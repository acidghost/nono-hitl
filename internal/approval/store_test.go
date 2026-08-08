package approval

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestStoreSubmitAndDecide(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		decision State
		reason   string
	}{
		{name: "grant", decision: StateGranted},
		{name: "deny", decision: StateDenied, reason: "not now"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			store := newTestStore(t, 4, 4)
			result := submitAsync(store, testEnvelope("req-1"), time.Second)
			waitForPending(t, store, 1)

			decided, err := store.Decide("req-1", test.decision, test.reason)
			if err != nil {
				t.Fatalf("Decide() error = %v", err)
			}
			if decided.State != test.decision {
				t.Fatalf("Decide() state = %q, want %q", decided.State, test.decision)
			}

			got := awaitResult(t, result)
			if got.resolution.State != test.decision || got.resolution.Reason != test.reason {
				t.Fatalf("Submit() resolution = %+v, want state %q reason %q", got.resolution, test.decision, test.reason)
			}
			if got.err != nil {
				t.Fatalf("Submit() error = %v", got.err)
			}
			if pending := store.Pending(); len(pending) != 0 {
				t.Fatalf("len(Pending()) = %d, want 0", len(pending))
			}
			recent := store.Recent()
			if len(recent) != 1 || recent[0].State != test.decision {
				t.Fatalf("Recent() = %+v, want one %q approval", recent, test.decision)
			}
		})
	}
}

func TestStoreExpiresPendingApproval(t *testing.T) {
	t.Parallel()

	store := newTestStore(t, 1, 1)
	result := submitAsync(store, testEnvelope("req-timeout"), 20*time.Millisecond)

	got := awaitResult(t, result)
	if got.err != nil {
		t.Fatalf("Submit() error = %v", got.err)
	}
	if got.resolution.State != StateExpired {
		t.Fatalf("Submit() state = %q, want %q", got.resolution.State, StateExpired)
	}
}

func TestStoreCancelsWithContext(t *testing.T) {
	t.Parallel()

	store := newTestStore(t, 1, 1)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan submitResult, 1)
	go func() {
		resolution, err := store.Submit(ctx, testEnvelope("req-cancel"), time.Second)
		result <- submitResult{resolution: resolution, err: err}
	}()
	waitForPending(t, store, 1)
	cancel()

	got := awaitResult(t, result)
	if got.err != nil {
		t.Fatalf("Submit() error = %v", got.err)
	}
	if got.resolution.State != StateCanceled {
		t.Fatalf("Submit() state = %q, want %q", got.resolution.State, StateCanceled)
	}
}

func TestStoreRejectsDuplicateRequests(t *testing.T) {
	t.Parallel()

	store := newTestStore(t, 2, 2)
	first := submitAsync(store, testEnvelope("req-duplicate"), time.Second)
	waitForPending(t, store, 1)

	_, err := store.Submit(context.Background(), testEnvelope("req-duplicate"), time.Second)
	if !errors.Is(err, ErrDuplicate) {
		t.Fatalf("pending duplicate error = %v, want ErrDuplicate", err)
	}
	if _, err := store.Decide("req-duplicate", StateDenied, "done"); err != nil {
		t.Fatalf("Decide() error = %v", err)
	}
	_ = awaitResult(t, first)

	_, err = store.Submit(context.Background(), testEnvelope("req-duplicate"), time.Second)
	if !errors.Is(err, ErrDuplicate) {
		t.Fatalf("recent duplicate error = %v, want ErrDuplicate", err)
	}
}

func TestStoreOnlyFirstConcurrentDecisionWins(t *testing.T) {
	t.Parallel()

	store := newTestStore(t, 1, 1)
	result := submitAsync(store, testEnvelope("req-race"), time.Second)
	waitForPending(t, store, 1)

	const contenders = 32
	var successes atomic.Int32
	var alreadyResolved atomic.Int32
	var wait sync.WaitGroup
	wait.Add(contenders)
	for i := range contenders {
		go func() {
			defer wait.Done()
			decision := StateGranted
			if i%2 == 0 {
				decision = StateDenied
			}
			_, err := store.Decide("req-race", decision, fmt.Sprintf("decision %d", i))
			switch {
			case err == nil:
				successes.Add(1)
			case errors.Is(err, ErrAlreadyResolved):
				alreadyResolved.Add(1)
			default:
				t.Errorf("Decide() unexpected error = %v", err)
			}
		}()
	}
	wait.Wait()
	_ = awaitResult(t, result)

	if got := successes.Load(); got != 1 {
		t.Fatalf("successful decisions = %d, want 1", got)
	}
	if got := alreadyResolved.Load(); got != contenders-1 {
		t.Fatalf("already-resolved decisions = %d, want %d", got, contenders-1)
	}
}

func TestStoreBoundsPendingAndRecentApprovals(t *testing.T) {
	t.Parallel()

	store := newTestStore(t, 1, 1)
	first := submitAsync(store, testEnvelope("req-1"), time.Second)
	waitForPending(t, store, 1)

	_, err := store.Submit(context.Background(), testEnvelope("req-2"), time.Second)
	if !errors.Is(err, ErrStoreFull) {
		t.Fatalf("full store error = %v, want ErrStoreFull", err)
	}
	_, _ = store.Decide("req-1", StateGranted, "")
	_ = awaitResult(t, first)

	second := submitAsync(store, testEnvelope("req-2"), time.Second)
	waitForPending(t, store, 1)
	_, _ = store.Decide("req-2", StateDenied, "")
	_ = awaitResult(t, second)

	recent := store.Recent()
	if len(recent) != 1 || recent[0].Envelope.Request.RequestID != "req-2" {
		t.Fatalf("Recent() = %+v, want only req-2", recent)
	}

	// Eviction bounds replay protection as well as history retention.
	third := submitAsync(store, testEnvelope("req-1"), time.Second)
	waitForPending(t, store, 1)
	_, _ = store.Decide("req-1", StateDenied, "cleanup")
	_ = awaitResult(t, third)
}

func TestStoreShutdownFailsPendingClosed(t *testing.T) {
	t.Parallel()

	store := newTestStore(t, 3, 3)
	first := submitAsync(store, testEnvelope("req-1"), time.Second)
	second := submitAsync(store, testEnvelope("req-2"), time.Second)
	waitForPending(t, store, 2)

	store.Shutdown("server stopping")
	store.Shutdown("ignored")

	for _, result := range []<-chan submitResult{first, second} {
		got := awaitResult(t, result)
		if got.err != nil {
			t.Fatalf("Submit() error = %v", got.err)
		}
		if got.resolution.State != StateCanceled || got.resolution.Reason != "server stopping" {
			t.Fatalf("Submit() resolution = %+v, want canceled shutdown", got.resolution)
		}
	}

	_, err := store.Submit(context.Background(), testEnvelope("req-3"), time.Second)
	if !errors.Is(err, ErrStoreClosed) {
		t.Fatalf("Submit() after shutdown error = %v, want ErrStoreClosed", err)
	}
}

func TestStoreSnapshotsDoNotExposeMutableRequestData(t *testing.T) {
	t.Parallel()

	store := newTestStore(t, 1, 1)
	envelope := testEnvelope("req-copy")
	result := submitAsync(store, envelope, time.Second)
	waitForPending(t, store, 1)

	envelope.Request.Args[0] = "changed outside"
	pending, recent := store.Snapshot()
	if len(pending) != 1 || len(recent) != 0 {
		t.Fatalf("Snapshot() lengths = %d pending, %d recent; want 1, 0", len(pending), len(recent))
	}
	pending[0].Envelope.Request.Args[0] = "changed snapshot"
	*pending[0].Envelope.Request.Reason = "changed reason"

	fresh := store.Pending()[0]
	if fresh.Envelope.Request.Args[0] != "gh" {
		t.Fatalf("stored Args[0] = %q, want gh", fresh.Envelope.Request.Args[0])
	}
	if fresh.Envelope.Request.Reason == nil || *fresh.Envelope.Request.Reason != "Needed for the requested task" {
		t.Fatalf("stored Reason = %v, want original reason", fresh.Envelope.Request.Reason)
	}

	_, _ = store.Decide("req-copy", StateDenied, "cleanup")
	_ = awaitResult(t, result)
}

func TestStorePublishesPendingAndResolvedEvents(t *testing.T) {
	t.Parallel()

	store := newTestStore(t, 1, 1)
	events, unsubscribe := store.Subscribe(2)
	defer unsubscribe()

	result := submitAsync(store, testEnvelope("req-events"), time.Second)
	pending := awaitEvent(t, events)
	if pending.Kind != EventPending || pending.Approval.State != StatePending {
		t.Fatalf("pending event = %+v, want pending approval", pending)
	}

	if _, err := store.Decide("req-events", StateGranted, ""); err != nil {
		t.Fatalf("Decide() error = %v", err)
	}
	resolved := awaitEvent(t, events)
	if resolved.Kind != EventResolved || resolved.Approval.State != StateGranted {
		t.Fatalf("resolved event = %+v, want granted approval", resolved)
	}
	_ = awaitResult(t, result)
}

func TestStoreShutdownClosesSubscriptions(t *testing.T) {
	t.Parallel()

	store := newTestStore(t, 1, 1)
	events, unsubscribe := store.Subscribe(1)
	store.Shutdown("done")
	unsubscribe()

	if _, open := <-events; open {
		t.Fatal("subscription remained open after shutdown")
	}
	closedEvents, _ := store.Subscribe(1)
	if _, open := <-closedEvents; open {
		t.Fatal("subscription created after shutdown is open")
	}
}

func TestNewStoreValidatesBounds(t *testing.T) {
	t.Parallel()

	if _, err := NewStore(StoreConfig{}); err == nil {
		t.Fatal("NewStore() error = nil, want invalid max pending error")
	}
	if _, err := NewStore(StoreConfig{MaxPending: 1, MaxRecent: -1}); err == nil {
		t.Fatal("NewStore() error = nil, want invalid max recent error")
	}
}

type submitResult struct {
	resolution Resolution
	err        error
}

func newTestStore(t *testing.T, maxPending, maxRecent int) *Store {
	t.Helper()
	store, err := NewStore(StoreConfig{MaxPending: maxPending, MaxRecent: maxRecent})
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	t.Cleanup(func() { store.Shutdown("test cleanup") })
	return store
}

func submitAsync(store *Store, envelope WebhookEnvelope, timeout time.Duration) <-chan submitResult {
	result := make(chan submitResult, 1)
	go func() {
		resolution, err := store.Submit(context.Background(), envelope, timeout)
		result <- submitResult{resolution: resolution, err: err}
	}()
	return result
}

func waitForPending(t *testing.T, store *Store, count int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(store.Pending()) == count {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("len(Pending()) = %d, want %d", len(store.Pending()), count)
}

func awaitEvent(t *testing.T, events <-chan Event) Event {
	t.Helper()
	select {
	case event, open := <-events:
		if !open {
			t.Fatal("event subscription closed unexpectedly")
		}
		return event
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for approval event")
		return Event{}
	}
}

func awaitResult(t *testing.T, result <-chan submitResult) submitResult {
	t.Helper()
	select {
	case got := <-result:
		return got
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for Submit()")
		return submitResult{}
	}
}
