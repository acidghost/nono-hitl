package approval

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

var (
	ErrStoreClosed     = errors.New("approval store is closed")
	ErrStoreFull       = errors.New("approval store is full")
	ErrDuplicate       = errors.New("duplicate approval request")
	ErrNotFound        = errors.New("approval request not found")
	ErrAlreadyResolved = errors.New("approval request is already resolved")
	ErrInvalidDecision = errors.New("invalid approval decision")
	ErrGrantsDisabled  = errors.New("session approvals are disabled")
)

// State describes the lifecycle of an approval.
type State string

const (
	StatePending  State = "pending"
	StateGranted  State = "granted"
	StateDenied   State = "denied"
	StateExpired  State = "expired"
	StateCanceled State = "canceled"
)

// ScopeSession marks a grant that also releases later identical requests from
// the same nono session.
const ScopeSession = "session"

// Resolution is the terminal result returned to a waiting webhook request.
type Resolution struct {
	State      State     `json:"state"`
	Scope      string    `json:"scope,omitempty"`
	Reason     string    `json:"reason,omitempty"`
	ResolvedAt time.Time `json:"resolved_at"`
}

// SessionGrant approves every later request reporting exactly the same nono
// session, command, argv, caller, and rule. ID is the approving request's ID.
type SessionGrant struct {
	ID            string    `json:"id"`
	SessionID     string    `json:"session_id"`
	Command       string    `json:"command"`
	Args          []string  `json:"args"`
	Caller        string    `json:"caller"`
	InterceptRule string    `json:"intercept_rule"`
	CreatedAt     time.Time `json:"created_at"`
}

// EventKind identifies an approval-store change.
type EventKind string

const (
	EventPending  EventKind = "pending"
	EventResolved EventKind = "resolved"
	EventGrants   EventKind = "grants"
)

// Event is an immutable approval-store notification. Grants events carry the
// full grant list instead of an approval. Subscribers must use a snapshot to
// reconcile if their bounded event channel drops an update.
type Event struct {
	Kind     EventKind      `json:"kind"`
	Approval Approval       `json:"approval"`
	Grants   []SessionGrant `json:"grants,omitempty"`
}

// Approval is an immutable snapshot suitable for an API or UI.
type Approval struct {
	Envelope   WebhookEnvelope `json:"envelope"`
	State      State           `json:"state"`
	CreatedAt  time.Time       `json:"created_at"`
	Deadline   time.Time       `json:"deadline"`
	Resolution *Resolution     `json:"resolution,omitempty"`
}

// StoreConfig bounds all retained in-memory state.
type StoreConfig struct {
	MaxPending int
	MaxRecent  int
	// MaxGrants bounds session grants; the oldest is evicted when full. Zero
	// disables session approvals.
	MaxGrants int
}

type entry struct {
	approval Approval
	done     chan struct{}
	timer    *time.Timer
}

// Store owns pending approvals and a bounded history of terminal results.
type Store struct {
	mu          sync.RWMutex
	pending     map[string]*entry
	recent      []Approval
	recentByID  map[string]struct{}
	grants      map[string]SessionGrant
	subscribers map[uint64]chan Event
	nextSubID   uint64
	maxPending  int
	maxRecent   int
	maxGrants   int
	closed      bool
}

// NewStore constructs a bounded in-memory approval store.
func NewStore(config StoreConfig) (*Store, error) {
	if config.MaxPending <= 0 {
		return nil, errors.New("max pending approvals must be positive")
	}
	if config.MaxRecent < 0 {
		return nil, errors.New("max recent approvals cannot be negative")
	}
	if config.MaxGrants < 0 {
		return nil, errors.New("max session grants cannot be negative")
	}

	return &Store{
		pending:     make(map[string]*entry, config.MaxPending),
		recent:      make([]Approval, 0, config.MaxRecent),
		recentByID:  make(map[string]struct{}, config.MaxRecent),
		grants:      make(map[string]SessionGrant, config.MaxGrants),
		subscribers: make(map[uint64]chan Event),
		maxPending:  config.MaxPending,
		maxRecent:   config.MaxRecent,
		maxGrants:   config.MaxGrants,
	}, nil
}

// Submit registers an approval and waits until it is decided, expires, is
// canceled with the caller's context, or the store shuts down.
func (s *Store) Submit(
	ctx context.Context,
	envelope WebhookEnvelope,
	timeout time.Duration,
) (Resolution, error) {
	if err := envelope.Request.Validate(); err != nil {
		return Resolution{}, err
	}
	if envelope.Backend == "" || len(envelope.Backend) > maxBackendBytes {
		return Resolution{}, fmt.Errorf("%w: invalid backend", ErrInvalidRequest)
	}
	if timeout <= 0 {
		return Resolution{}, errors.New("approval timeout must be positive")
	}

	item, err := s.add(envelope, timeout)
	if err != nil {
		return Resolution{}, err
	}

	select {
	case <-item.done:
		return resolutionOf(item), nil
	case <-ctx.Done():
		resolution, transitionErr := s.transition(
			envelope.Request.RequestID,
			StateCanceled,
			ctx.Err().Error(),
		)
		if transitionErr == nil {
			return resolution, nil
		}
		if !errors.Is(transitionErr, ErrAlreadyResolved) {
			return Resolution{}, transitionErr
		}
		<-item.done
		return resolutionOf(item), nil
	}
}

// Decide grants or denies a pending approval. Only the first terminal
// transition succeeds.
func (s *Store) Decide(requestID string, decision State, reason string) (Resolution, error) {
	if decision != StateGranted && decision != StateDenied {
		return Resolution{}, fmt.Errorf("%w: %q", ErrInvalidDecision, decision)
	}
	return s.transition(requestID, decision, reason)
}

// DecideForSession grants a pending approval and remembers a session grant
// for its exact request. Other pending requests matching the grant are
// granted too.
func (s *Store) DecideForSession(requestID string, reason string) (Resolution, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.maxGrants == 0 {
		return Resolution{}, ErrGrantsDisabled
	}
	item, err := s.pendingItemLocked(requestID)
	if err != nil {
		return Resolution{}, err
	}

	request := item.approval.Envelope.Request
	key := grantKey(request)
	if len(s.grants) >= s.maxGrants {
		s.evictOldestGrantLocked()
	}
	s.grants[key] = SessionGrant{
		ID:            requestID,
		SessionID:     request.SessionID,
		Command:       request.Command,
		Args:          append([]string(nil), request.Args...),
		Caller:        request.Caller,
		InterceptRule: request.InterceptRule,
		CreatedAt:     time.Now(),
	}

	resolution := s.finishLocked(item, StateGranted, ScopeSession, reason)
	for _, other := range s.pending {
		if grantKey(other.approval.Envelope.Request) == key {
			s.finishLocked(other, StateGranted, ScopeSession, "Matched session approval")
		}
	}
	s.publishLocked(Event{Kind: EventGrants, Grants: s.grantsLocked()})
	return resolution, nil
}

// Revoke removes the session grant with the given ID.
func (s *Store) Revoke(grantID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for key, grant := range s.grants {
		if grant.ID == grantID {
			delete(s.grants, key)
			s.publishLocked(Event{Kind: EventGrants, Grants: s.grantsLocked()})
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrNotFound, grantID)
}

// Grants returns session grants ordered oldest first.
func (s *Store) Grants() []SessionGrant {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.grantsLocked()
}

// Pending returns pending approvals ordered oldest first.
func (s *Store) Pending() []Approval {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.pendingLocked()
}

// Recent returns terminal approvals ordered newest first.
func (s *Store) Recent() []Approval {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.recentLocked()
}

// Snapshot returns pending and recent approvals and session grants from one
// atomic view of the store. The returned values do not share mutable request
// data with it.
func (s *Store) Snapshot() ([]Approval, []Approval, []SessionGrant) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.pendingLocked(), s.recentLocked(), s.grantsLocked()
}

// Subscribe returns a bounded stream of store changes and an idempotent
// unsubscribe function. Slow subscribers may miss events and must reconcile
// with Pending and Recent snapshots.
func (s *Store) Subscribe(buffer int) (<-chan Event, func()) {
	if buffer < 1 {
		buffer = 1
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		closed := make(chan Event)
		close(closed)
		return closed, func() {}
	}
	id := s.nextSubID
	s.nextSubID++
	events := make(chan Event, buffer)
	s.subscribers[id] = events
	s.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			s.mu.Lock()
			if subscriber, exists := s.subscribers[id]; exists {
				delete(s.subscribers, id)
				close(subscriber)
			}
			s.mu.Unlock()
		})
	}
	return events, unsubscribe
}

// IsClosed reports whether Shutdown has closed the store.
func (s *Store) IsClosed() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.closed
}

// Shutdown closes the store and cancels every pending approval. It is safe to
// call more than once.
func (s *Store) Shutdown(reason string) {
	if reason == "" {
		reason = "approval service shut down"
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true

	for _, item := range s.pending {
		s.finishLocked(item, StateCanceled, "", reason)
	}
	for id, subscriber := range s.subscribers {
		delete(s.subscribers, id)
		close(subscriber)
	}
}

func (s *Store) pendingLocked() []Approval {
	approvals := make([]Approval, 0, len(s.pending))
	for _, item := range s.pending {
		approvals = append(approvals, cloneApproval(item.approval))
	}
	sort.Slice(approvals, func(i, j int) bool {
		return approvals[i].CreatedAt.Before(approvals[j].CreatedAt)
	})
	return approvals
}

func (s *Store) recentLocked() []Approval {
	approvals := make([]Approval, len(s.recent))
	for i := range s.recent {
		approvals[i] = cloneApproval(s.recent[i])
	}
	return approvals
}

func (s *Store) grantsLocked() []SessionGrant {
	grants := make([]SessionGrant, 0, len(s.grants))
	for _, grant := range s.grants {
		grant.Args = append([]string(nil), grant.Args...)
		grants = append(grants, grant)
	}
	sort.Slice(grants, func(i, j int) bool {
		return grants[i].CreatedAt.Before(grants[j].CreatedAt)
	})
	return grants
}

func (s *Store) evictOldestGrantLocked() {
	oldestKey := ""
	var oldest time.Time
	for key, grant := range s.grants {
		if oldestKey == "" || grant.CreatedAt.Before(oldest) {
			oldestKey, oldest = key, grant.CreatedAt
		}
	}
	delete(s.grants, oldestKey)
}

// grantKey identifies the exact request a session grant releases. Quoting
// keeps field and argument boundaries unambiguous.
func grantKey(request CommandRequest) string {
	return fmt.Sprintf("%q %q %q %q %q",
		request.SessionID, request.Command, request.Caller, request.InterceptRule, request.Args)
}

func (s *Store) add(envelope WebhookEnvelope, timeout time.Duration) (*entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return nil, ErrStoreClosed
	}
	requestID := envelope.Request.RequestID
	if _, exists := s.pending[requestID]; exists {
		return nil, fmt.Errorf("%w: %s", ErrDuplicate, requestID)
	}
	if _, exists := s.recentByID[requestID]; exists {
		return nil, fmt.Errorf("%w: %s", ErrDuplicate, requestID)
	}

	now := time.Now()
	item := &entry{
		approval: Approval{
			Envelope:  cloneEnvelope(envelope),
			State:     StatePending,
			CreatedAt: now,
			Deadline:  now.Add(timeout),
		},
		done: make(chan struct{}),
	}
	if _, granted := s.grants[grantKey(envelope.Request)]; granted {
		s.finishLocked(item, StateGranted, ScopeSession, "Matched session approval")
		return item, nil
	}

	if len(s.pending) >= s.maxPending {
		return nil, ErrStoreFull
	}
	s.pending[requestID] = item
	s.publishLocked(Event{Kind: EventPending, Approval: item.approval})
	item.timer = time.AfterFunc(timeout, func() {
		_, _ = s.transition(requestID, StateExpired, "approval request timed out")
	})
	return item, nil
}

func (s *Store) transition(requestID string, state State, reason string) (Resolution, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	item, err := s.pendingItemLocked(requestID)
	if err != nil {
		return Resolution{}, err
	}
	return s.finishLocked(item, state, "", reason), nil
}

func (s *Store) pendingItemLocked(requestID string) (*entry, error) {
	item, exists := s.pending[requestID]
	if !exists {
		if _, resolved := s.recentByID[requestID]; resolved {
			return nil, fmt.Errorf("%w: %s", ErrAlreadyResolved, requestID)
		}
		return nil, fmt.Errorf("%w: %s", ErrNotFound, requestID)
	}
	return item, nil
}

func (s *Store) finishLocked(item *entry, state State, scope string, reason string) Resolution {
	requestID := item.approval.Envelope.Request.RequestID
	delete(s.pending, requestID)
	if item.timer != nil {
		item.timer.Stop()
	}

	resolution := Resolution{
		State:      state,
		Scope:      scope,
		Reason:     reason,
		ResolvedAt: time.Now(),
	}
	item.approval.State = state
	item.approval.Resolution = &resolution
	s.rememberLocked(item.approval)
	s.publishLocked(Event{Kind: EventResolved, Approval: item.approval})
	close(item.done)
	return resolution
}

func (s *Store) rememberLocked(approval Approval) {
	if s.maxRecent == 0 {
		return
	}

	requestID := approval.Envelope.Request.RequestID
	s.recent = append([]Approval{cloneApproval(approval)}, s.recent...)
	s.recentByID[requestID] = struct{}{}
	if len(s.recent) <= s.maxRecent {
		return
	}

	evicted := s.recent[len(s.recent)-1]
	delete(s.recentByID, evicted.Envelope.Request.RequestID)
	s.recent = s.recent[:len(s.recent)-1]
}

func (s *Store) publishLocked(event Event) {
	for _, subscriber := range s.subscribers {
		published := event
		published.Approval = cloneApproval(event.Approval)
		select {
		case subscriber <- published:
		default:
		}
	}
}

func resolutionOf(item *entry) Resolution {
	if item.approval.Resolution == nil {
		panic("approval completed without a resolution")
	}
	return *item.approval.Resolution
}

func cloneApproval(approval Approval) Approval {
	cloned := approval
	cloned.Envelope = cloneEnvelope(approval.Envelope)
	if approval.Resolution != nil {
		resolution := *approval.Resolution
		cloned.Resolution = &resolution
	}
	return cloned
}
