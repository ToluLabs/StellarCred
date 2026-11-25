import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WebSocketEventListener,
  createWebSocketEventListener,
  calculateBackoffDelay,
  matchesEventFilter,
  type WebSocketLike,
  type WebSocketCloseEventLike,
  type WebSocketMessageEventLike,
  type LedgerEvent,
  type ConnectionState,
} from '../src/ws-listener';
import { SdkClient } from '../src/client';

class MockWebSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: WebSocketMessageEventLike) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: WebSocketCloseEventLike) => void) | null = null;

  constructor(public readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code, reason, wasClean: true });
  }

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.({});
  }

  simulateMessage(data: unknown): void {
    const serialized = typeof data === 'string' ? data : JSON.stringify(data);
    this.onmessage?.({ data: serialized });
  }

  simulateError(err: unknown = new Error('network error')): void {
    this.onerror?.(err);
  }

  simulateDrop(code = 1006, reason = 'Abnormal closure'): void {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code, reason, wasClean: false });
  }
}

function makeEvent(overrides: Partial<LedgerEvent> & { id: string; ledgerSequence: number }): LedgerEvent {
  return {
    type: 'credential_issued',
    contractId: 'C_TEST_CONTRACT',
    topics: ['issue', 'kyc'],
    payload: { ok: true },
    ...overrides,
  };
}

describe('calculateBackoffDelay', () => {
  it('computes exponential backoff without jitter and caps at maxDelayMs', () => {
    const opts = { initialDelayMs: 500, maxDelayMs: 3000, backoffMultiplier: 2, jitterRatio: 0 };
    expect(calculateBackoffDelay(1, opts)).toBe(500);
    expect(calculateBackoffDelay(2, opts)).toBe(1000);
    expect(calculateBackoffDelay(3, opts)).toBe(2000);
    expect(calculateBackoffDelay(4, opts)).toBe(3000);
    expect(calculateBackoffDelay(5, opts)).toBe(3000);
  });

  it('applies symmetric jitter within bounds', () => {
    const opts = { initialDelayMs: 1000, maxDelayMs: 10000, backoffMultiplier: 2, jitterRatio: 0.2 };
    expect(calculateBackoffDelay(1, opts, () => 0)).toBe(800);
    expect(calculateBackoffDelay(1, opts, () => 0.5)).toBe(1000);
    expect(calculateBackoffDelay(1, opts, () => 1)).toBe(1200);
  });
});

describe('matchesEventFilter', () => {
  const evt = makeEvent({
    id: 'e1',
    ledgerSequence: 10,
    type: 'credential_revoked',
    contractId: 'C_ABC',
    topics: ['revoke', 'tier1'],
  });

  it('matches empty filter', () => {
    expect(matchesEventFilter(evt, {})).toBe(true);
  });

  it('matches contractId, eventType, and topics', () => {
    expect(matchesEventFilter(evt, { contractId: 'C_ABC', eventType: 'credential_revoked', topics: ['revoke'] })).toBe(true);
    expect(matchesEventFilter(evt, { contractId: 'C_OTHER' })).toBe(false);
    expect(matchesEventFilter(evt, { eventType: 'credential_issued' })).toBe(false);
    expect(matchesEventFilter(evt, { topics: ['revoke', 'missing'] })).toBe(false);
  });
});

describe('WebSocketEventListener', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects, subscribes, dispatches events, and unsubscribes', () => {
    const sockets: MockWebSocket[] = [];
    const states: ConnectionState[] = [];
    const received: LedgerEvent[] = [];

    const listener = createWebSocketEventListener({
      url: 'wss://example.com/ws/events',
      webSocketFactory: (url) => {
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        return ws;
      },
      onStateChange: (s) => states.push(s),
    });

    const unsub = listener.subscribe({ id: 'sub-1', contractId: 'C_TEST_CONTRACT' }, (e) => {
      received.push(e);
    });

    listener.connect();
    expect(states).toEqual(['connecting']);
    expect(sockets).toHaveLength(1);

    sockets[0]!.simulateOpen();
    expect(states).toEqual(['connecting', 'connected']);
    expect(sockets[0]!.sent).toHaveLength(1);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: 'subscribe',
      subscriptionId: 'sub-1',
      filter: { id: 'sub-1', contractId: 'C_TEST_CONTRACT' },
    });

    const evt1 = makeEvent({ id: 'evt-1', ledgerSequence: 100 });
    sockets[0]!.simulateMessage({ type: 'event', event: evt1 });

    expect(received).toEqual([evt1]);
    expect(listener.getLastProcessedLedgerSequence()).toBe(100);

    unsub();
    expect(JSON.parse(sockets[0]!.sent[1]!)).toEqual({
      type: 'unsubscribe',
      subscriptionId: 'sub-1',
    });

    sockets[0]!.simulateMessage({ type: 'event', event: makeEvent({ id: 'evt-2', ledgerSequence: 101 }) });
    expect(received).toHaveLength(1);
  });

  it('automatically reconnects with exponential backoff and notifies parent application', () => {
    const sockets: MockWebSocket[] = [];
    const reconnectAttempts: Array<{ attempt: number; delayMs: number }> = [];
    const disconnects: Array<{ willReconnect: boolean; code?: number }> = [];

    const listener = new WebSocketEventListener({
      url: 'wss://example.com/ws/events',
      reconnect: {
        initialDelayMs: 500,
        maxDelayMs: 4000,
        backoffMultiplier: 2,
        jitterRatio: 0,
      },
      webSocketFactory: (url) => {
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        return ws;
      },
      onDisconnect: (info) => disconnects.push(info),
      onReconnecting: (info) => reconnectAttempts.push(info),
    });

    listener.connect();
    sockets[0]!.simulateOpen();

    // First drop -> schedules attempt 1 after 500ms
    sockets[0]!.simulateDrop(1006, 'Network blip');
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0]!.willReconnect).toBe(true);
    expect(reconnectAttempts).toEqual([{ attempt: 1, delayMs: 500 }]);
    expect(listener.getState()).toBe('reconnecting');

    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);

    // Second socket fails before opening -> schedules attempt 2 after 1000ms
    sockets[1]!.simulateDrop(1006, 'Still down');
    expect(reconnectAttempts).toEqual([
      { attempt: 1, delayMs: 500 },
      { attempt: 2, delayMs: 1000 },
    ]);

    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);

    // Third socket succeeds -> resets attempt counter
    sockets[2]!.simulateOpen();
    expect(listener.getState()).toBe('connected');

    // Another drop later starts back at attempt 1 (500ms)
    sockets[2]!.simulateDrop(1006, 'Another blip');
    expect(reconnectAttempts[2]).toEqual({ attempt: 1, delayMs: 500 });
  });

  it('re-subscribes active filters and backfills missed events since last processed ledger sequence', async () => {
    const sockets: MockWebSocket[] = [];
    const received: LedgerEvent[] = [];
    const reconnectSuccess: Array<{ attempt: number; backfilledCount: number }> = [];

    const fetchMissedEvents = vi.fn(async ({ fromLedgerSequence }) => {
      expect(fromLedgerSequence).toBe(51);
      return [
        makeEvent({ id: 'evt-53', ledgerSequence: 53 }),
        makeEvent({ id: 'evt-51', ledgerSequence: 51 }),
        makeEvent({ id: 'evt-52', ledgerSequence: 52 }),
      ];
    });

    const listener = new WebSocketEventListener({
      url: 'wss://example.com/ws/events',
      reconnect: { initialDelayMs: 200, jitterRatio: 0 },
      fetchMissedEvents,
      webSocketFactory: (url) => {
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        return ws;
      },
      onReconnect: (info) => reconnectSuccess.push(info),
    });

    const unsubDropped = listener.subscribe({ id: 'sub-dropped', eventType: 'other' }, () => {});
    listener.subscribe({ id: 'sub-active', contractId: 'C_TEST_CONTRACT' }, (e) => received.push(e));

    listener.connect();
    sockets[0]!.simulateOpen();
    unsubDropped();

    // Process event at ledger 50
    sockets[0]!.simulateMessage({ type: 'event', event: makeEvent({ id: 'evt-50', ledgerSequence: 50 }) });
    expect(listener.getLastProcessedLedgerSequence()).toBe(50);

    // Drop connection and advance timer to reconnect
    sockets[0]!.simulateDrop();
    vi.advanceTimersByTime(200);
    expect(sockets).toHaveLength(2);

    // Open reconnected socket
    sockets[1]!.simulateOpen();

    // Only active filter is re-subscribed
    expect(sockets[1]!.sent).toHaveLength(1);
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      type: 'subscribe',
      subscriptionId: 'sub-active',
      filter: { id: 'sub-active', contractId: 'C_TEST_CONTRACT' },
    });

    // Wait for async backfill microtasks
    await vi.runAllTimersAsync();

    expect(fetchMissedEvents).toHaveBeenCalledTimes(1);
    expect(received.map((e) => e.id)).toEqual(['evt-50', 'evt-51', 'evt-52', 'evt-53']);
    expect(listener.getLastProcessedLedgerSequence()).toBe(53);
    expect(reconnectSuccess).toEqual([{ attempt: 1, backfilledCount: 3 }]);
  });

  it('buffers live events during backfill and deduplicates overlapping events', async () => {
    const sockets: MockWebSocket[] = [];
    const received: LedgerEvent[] = [];
    let resolveBackfill!: (events: LedgerEvent[]) => void;

    const fetchMissedEvents = vi.fn(
      () =>
        new Promise<LedgerEvent[]>((resolve) => {
          resolveBackfill = resolve;
        })
    );

    const listener = new WebSocketEventListener({
      url: 'wss://example.com/ws/events',
      initialLedgerSequence: 10,
      reconnect: { initialDelayMs: 100, jitterRatio: 0 },
      fetchMissedEvents,
      webSocketFactory: (url) => {
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        return ws;
      },
    });

    listener.subscribe({}, (e) => received.push(e));
    listener.connect();
    sockets[0]!.simulateOpen();

    sockets[0]!.simulateDrop();
    vi.advanceTimersByTime(100);
    sockets[1]!.simulateOpen();

    // Live events arrive while backfill is still in-flight (including duplicate evt-12)
    sockets[1]!.simulateMessage(makeEvent({ id: 'evt-12', ledgerSequence: 12 }));
    sockets[1]!.simulateMessage(makeEvent({ id: 'evt-13', ledgerSequence: 13 }));

    // Nothing dispatched yet because backfill is in progress
    expect(received).toHaveLength(0);

    // Complete backfill with evt-11 and overlapping evt-12
    resolveBackfill([
      makeEvent({ id: 'evt-11', ledgerSequence: 11 }),
      makeEvent({ id: 'evt-12', ledgerSequence: 12 }),
    ]);

    await vi.runAllTimersAsync();

    expect(received.map((e) => e.id)).toEqual(['evt-11', 'evt-12', 'evt-13']);
    expect(listener.getLastProcessedLedgerSequence()).toBe(13);
  });

  it('transitions to failed state when maxAttempts is exceeded', () => {
    const sockets: MockWebSocket[] = [];
    const errors: Error[] = [];

    const listener = new WebSocketEventListener({
      url: 'wss://example.com/ws/events',
      reconnect: { initialDelayMs: 100, jitterRatio: 0, maxAttempts: 2 },
      webSocketFactory: (url) => {
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        return ws;
      },
      onError: (err) => errors.push(err),
    });

    listener.connect();
    sockets[0]!.simulateDrop(); // triggers attempt 1
    vi.advanceTimersByTime(100);
    sockets[1]!.simulateDrop(); // triggers attempt 2
    vi.advanceTimersByTime(200);
    sockets[2]!.simulateDrop(); // exceeds maxAttempts

    expect(listener.getState()).toBe('failed');
    expect(errors.some((e) => e.message.includes('failed after 2 attempts'))).toBe(true);
  });

  it('does not reconnect after intentional disconnect', () => {
    const sockets: MockWebSocket[] = [];
    const listener = new WebSocketEventListener({
      url: 'wss://example.com/ws/events',
      reconnect: { initialDelayMs: 100, jitterRatio: 0 },
      webSocketFactory: (url) => {
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        return ws;
      },
    });

    listener.connect();
    sockets[0]!.simulateOpen();
    listener.disconnect();

    expect(listener.getState()).toBe('disconnected');
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
  });

  it('integrates with SdkClient.createEventListener for default URL and HTTP backfill', async () => {
    const sockets: MockWebSocket[] = [];
    const received: LedgerEvent[] = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe('https://api.stellarcred.io/api/events?fromLedgerSequence=201');
      return new Response(
        JSON.stringify({
          events: [makeEvent({ id: 'evt-201', ledgerSequence: 201 })],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const client = new SdkClient({
      baseUrl: 'https://api.stellarcred.io',
      fetch: mockFetch as unknown as typeof fetch,
    });

    const listener = client.createEventListener({
      initialLedgerSequence: 200,
      reconnect: { initialDelayMs: 100, jitterRatio: 0 },
      webSocketFactory: (url) => {
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        return ws;
      },
    });

    listener.subscribe({}, (e) => received.push(e));
    listener.connect();
    expect(sockets[0]!.url).toBe('wss://api.stellarcred.io/ws/events');

    sockets[0]!.simulateOpen();
    sockets[0]!.simulateDrop();
    vi.advanceTimersByTime(100);
    sockets[1]!.simulateOpen();

    await vi.runAllTimersAsync();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(received.map((e) => e.id)).toEqual(['evt-201']);
  });
});
