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

// Resolution is the terminal result returned to a waiting webhook request.
type Resolution struct {
	State      State     `json:"state"`
	Reason     string    `json:"reason,omitempty"`
	ResolvedAt time.Time `json:"resolved_at"`
}

// EventKind identifies an approval-store change.
type EventKind string

const (
	EventPending  EventKind = "pending"
	EventResolved EventKind = "resolved"
)

// Event is an immutable approval-store notification. Subscribers must use a
// snapshot to reconcile if their bounded event channel drops an update.
type Event struct {
	Kind     EventKind `json:"kind"`
	Approval Approval  `json:"approval"`
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
	subscribers map[uint64]chan Event
	nextSubID   uint64
	maxPending  int
	maxRecent   int
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

	return &Store{
		pending:     make(map[string]*entry, config.MaxPending),
		recent:      make([]Approval, 0, config.MaxRecent),
		recentByID:  make(map[string]struct{}, config.MaxRecent),
		subscribers: make(map[uint64]chan Event),
		maxPending:  config.MaxPending,
		maxRecent:   config.MaxRecent,
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

// Snapshot returns pending and recent approvals from one atomic view of the
// store. The returned approvals do not share mutable request data with it.
func (s *Store) Snapshot() ([]Approval, []Approval) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.pendingLocked(), s.recentLocked()
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
		s.finishLocked(item, StateCanceled, reason)
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
	if len(s.pending) >= s.maxPending {
		return nil, ErrStoreFull
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

	item, exists := s.pending[requestID]
	if !exists {
		if _, resolved := s.recentByID[requestID]; resolved {
			return Resolution{}, fmt.Errorf("%w: %s", ErrAlreadyResolved, requestID)
		}
		return Resolution{}, fmt.Errorf("%w: %s", ErrNotFound, requestID)
	}

	return s.finishLocked(item, state, reason), nil
}

func (s *Store) finishLocked(item *entry, state State, reason string) Resolution {
	requestID := item.approval.Envelope.Request.RequestID
	delete(s.pending, requestID)
	if item.timer != nil {
		item.timer.Stop()
	}

	resolution := Resolution{
		State:      state,
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
