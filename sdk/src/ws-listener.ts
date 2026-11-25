export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface WebSocketCloseEventLike {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export interface WebSocketMessageEventLike {
  data: unknown;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: WebSocketMessageEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: WebSocketCloseEventLike) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface EventFilter {
  id?: string;
  contractId?: string;
  eventType?: string;
  topics?: string[];
}

export interface LedgerEvent<T = unknown> {
  id: string;
  ledgerSequence: number;
  type: string;
  contractId?: string;
  topics?: string[];
  payload: T;
  timestamp?: string;
}

export type EventHandler<T = unknown> = (event: LedgerEvent<T>) => void;
export type Unsubscribe = () => void;

export interface BackfillParams {
  fromLedgerSequence: number;
  filters: EventFilter[];
}

export type BackfillFetcher = (params: BackfillParams) => Promise<LedgerEvent[]>;

export interface ReconnectOptions {
  enabled?: boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterRatio?: number;
  maxAttempts?: number;
}

export interface DisconnectInfo {
  code?: number;
  reason?: string;
  wasClean?: boolean;
  willReconnect: boolean;
}

export interface ReconnectingInfo {
  attempt: number;
  delayMs: number;
}

export interface ReconnectSuccessInfo {
  attempt: number;
  backfilledCount: number;
}

export interface WebSocketListenerConfig {
  url: string;
  reconnect?: ReconnectOptions;
  initialLedgerSequence?: number;
  fetchMissedEvents?: BackfillFetcher;
  webSocketFactory?: WebSocketFactory;
  maxSeenEventIds?: number;
  random?: () => number;
  onStateChange?: (state: ConnectionState) => void;
  onDisconnect?: (info: DisconnectInfo) => void;
  onReconnecting?: (info: ReconnectingInfo) => void;
  onReconnect?: (info: ReconnectSuccessInfo) => void;
  onError?: (error: Error) => void;
}

export const DEFAULT_RECONNECT_OPTIONS: Required<ReconnectOptions> = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  jitterRatio: 0.2,
  maxAttempts: Number.POSITIVE_INFINITY,
};

const WS_OPEN = 1;
const DEFAULT_MAX_SEEN_EVENT_IDS = 10_000;

interface ActiveSubscription {
  id: string;
  filter: EventFilter;
  handler: EventHandler;
}

/**
 * Computes exponential backoff delay with optional symmetric jitter.
 */
export function calculateBackoffDelay(
  attempt: number,
  options: ReconnectOptions = {},
  random: () => number = Math.random
): number {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_RECONNECT_OPTIONS.initialDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RECONNECT_OPTIONS.maxDelayMs;
  const backoffMultiplier = options.backoffMultiplier ?? DEFAULT_RECONNECT_OPTIONS.backoffMultiplier;
  const jitterRatio = options.jitterRatio ?? DEFAULT_RECONNECT_OPTIONS.jitterRatio;

  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponential = Math.min(maxDelayMs, initialDelayMs * Math.pow(backoffMultiplier, safeAttempt - 1));

  if (jitterRatio <= 0) {
    return Math.round(exponential);
  }

  const clampedJitter = Math.min(1, Math.max(0, jitterRatio));
  const jitterFactor = 1 + (random() * 2 - 1) * clampedJitter;
  const withJitter = exponential * jitterFactor;
  return Math.max(0, Math.min(maxDelayMs, Math.round(withJitter)));
}

/**
 * Checks whether a ledger event matches a subscription filter.
 */
export function matchesEventFilter(event: LedgerEvent, filter: EventFilter): boolean {
  if (filter.contractId !== undefined && event.contractId !== filter.contractId) {
    return false;
  }
  if (filter.eventType !== undefined && event.type !== filter.eventType) {
    return false;
  }
  if (filter.topics !== undefined && filter.topics.length > 0) {
    if (!event.topics || event.topics.length === 0) {
      return false;
    }
    for (const requiredTopic of filter.topics) {
      if (!event.topics.includes(requiredTopic)) {
        return false;
      }
    }
  }
  return true;
}

function isLedgerEvent(value: unknown): value is LedgerEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.ledgerSequence === 'number' &&
    Number.isFinite(candidate.ledgerSequence) &&
    typeof candidate.type === 'string'
  );
}

function parseIncomingEvent(raw: unknown): LedgerEvent | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.type === 'event' && isLedgerEvent(envelope.event)) {
    return envelope.event;
  }
  if (isLedgerEvent(parsed)) {
    return parsed;
  }
  return null;
}

/**
 * Resilient WebSocket event listener with automatic exponential-backoff reconnection,
 * automatic re-subscription of active filters, and ledger-sequence event backfilling.
 */
export class WebSocketEventListener {
  private readonly url: string;
  private readonly reconnectOptions: Required<ReconnectOptions>;
  private readonly fetchMissedEvents: BackfillFetcher | undefined;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly maxSeenEventIds: number;
  private readonly random: () => number;

  private readonly onStateChange: ((state: ConnectionState) => void) | undefined;
  private readonly onDisconnect: ((info: DisconnectInfo) => void) | undefined;
  private readonly onReconnecting: ((info: ReconnectingInfo) => void) | undefined;
  private readonly onReconnect: ((info: ReconnectSuccessInfo) => void) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;

  private socket: WebSocketLike | null = null;
  private state: ConnectionState = 'disconnected';
  private intentionalDisconnect = false;
  private hasConnectedOnce = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProcessedLedgerSequence: number | null;

  private subscriptionCounter = 0;
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly seenEventIds = new Set<string>();
  private isBackfilling = false;
  private readonly pendingLiveEvents: LedgerEvent[] = [];

  constructor(config: WebSocketListenerConfig) {
    if (!config.url) {
      throw new Error('WebSocketEventListener requires a url');
    }
    this.url = config.url;
    this.reconnectOptions = {
      enabled: config.reconnect?.enabled ?? DEFAULT_RECONNECT_OPTIONS.enabled,
      initialDelayMs: config.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_OPTIONS.initialDelayMs,
      maxDelayMs: config.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_OPTIONS.maxDelayMs,
      backoffMultiplier: config.reconnect?.backoffMultiplier ?? DEFAULT_RECONNECT_OPTIONS.backoffMultiplier,
      jitterRatio: config.reconnect?.jitterRatio ?? DEFAULT_RECONNECT_OPTIONS.jitterRatio,
      maxAttempts: config.reconnect?.maxAttempts ?? DEFAULT_RECONNECT_OPTIONS.maxAttempts,
    };
    this.lastProcessedLedgerSequence = config.initialLedgerSequence ?? null;
    this.fetchMissedEvents = config.fetchMissedEvents;
    this.maxSeenEventIds = config.maxSeenEventIds ?? DEFAULT_MAX_SEEN_EVENT_IDS;
    this.random = config.random ?? Math.random;

    this.onStateChange = config.onStateChange;
    this.onDisconnect = config.onDisconnect;
    this.onReconnecting = config.onReconnecting;
    this.onReconnect = config.onReconnect;
    this.onError = config.onError;

    this.webSocketFactory =
      config.webSocketFactory ??
      ((wsUrl: string) => {
        if (typeof globalThis.WebSocket !== 'function') {
          throw new Error('WebSocket implementation is not available in this environment');
        }
        return new globalThis.WebSocket(wsUrl) as unknown as WebSocketLike;
      });
  }

  getState(): ConnectionState {
    return this.state;
  }

  getLastProcessedLedgerSequence(): number | null {
    return this.lastProcessedLedgerSequence;
  }

  getActiveFilters(): EventFilter[] {
    return Array.from(this.subscriptions.values()).map((sub) => ({ ...sub.filter }));
  }

  /**
   * Opens the WebSocket connection. Safe to call when disconnected or failed.
   */
  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }
    this.intentionalDisconnect = false;
    this.clearReconnectTimer();
    this.openSocket(false);
  }

  /**
   * Intentionally closes the WebSocket connection and cancels any scheduled reconnects.
   */
  disconnect(code = 1000, reason = 'Client disconnected'): void {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.isBackfilling = false;
    this.pendingLiveEvents.length = 0;

    const currentSocket = this.socket;
    this.socket = null;
    if (currentSocket) {
      currentSocket.onopen = null;
      currentSocket.onmessage = null;
      currentSocket.onerror = null;
      currentSocket.onclose = null;
      try {
        currentSocket.close(code, reason);
      } catch {
        // Ignore close errors during intentional teardown
      }
    }
    this.setState('disconnected');
  }

  /**
   * Subscribes to ledger events matching the given filter.
   * Active subscriptions are automatically re-sent after reconnection.
   */
  subscribe<T = unknown>(filter: EventFilter, handler: EventHandler<T>): Unsubscribe {
    const id = filter.id ?? `sub_${++this.subscriptionCounter}`;
    const normalizedFilter: EventFilter = { ...filter, id };
    const subscription: ActiveSubscription = {
      id,
      filter: normalizedFilter,
      handler: handler as EventHandler,
    };
    this.subscriptions.set(id, subscription);

    if (this.state === 'connected' && this.socket && this.socket.readyState === WS_OPEN) {
      this.sendSubscribeMessage(subscription);
    }

    return () => {
      if (!this.subscriptions.delete(id)) {
        return;
      }
      if (this.state === 'connected' && this.socket && this.socket.readyState === WS_OPEN) {
        this.sendJson({ type: 'unsubscribe', subscriptionId: id });
      }
    };
  }

  private openSocket(isReconnect: boolean): void {
    this.setState(isReconnect ? 'reconnecting' : 'connecting');

    let ws: WebSocketLike;
    try {
      ws = this.webSocketFactory(this.url);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(error);
      this.handleUnexpectedClose({ wasClean: false, reason: error.message });
      return;
    }

    this.socket = ws;

    ws.onopen = () => {
      if (this.socket !== ws) return;

      const attemptNumber = this.reconnectAttempt;
      const wasReconnect = this.hasConnectedOnce || isReconnect;
      this.hasConnectedOnce = true;
      this.reconnectAttempt = 0;
      this.setState('connected');

      // Re-subscribe all active filters
      for (const sub of this.subscriptions.values()) {
        this.sendSubscribeMessage(sub);
      }

      if (wasReconnect) {
        void this.performBackfillAndNotify(attemptNumber);
      }
    };

    ws.onmessage = (msgEvent) => {
      if (this.socket !== ws) return;
      const ledgerEvent = parseIncomingEvent(msgEvent.data);
      if (!ledgerEvent) return;

      if (this.isBackfilling) {
        this.pendingLiveEvents.push(ledgerEvent);
        return;
      }

      this.processEvent(ledgerEvent);
    };

    ws.onerror = (errEvent) => {
      if (this.socket !== ws) return;
      const error =
        errEvent instanceof Error
          ? errEvent
          : new Error('WebSocket encountered a connection error');
      this.onError?.(error);
    };

    ws.onclose = (closeEvent) => {
      if (this.socket !== ws) return;
      this.socket = null;
      if (this.intentionalDisconnect) {
        this.setState('disconnected');
        return;
      }
      this.handleUnexpectedClose(closeEvent);
    };
  }

  private handleUnexpectedClose(closeEvent: WebSocketCloseEventLike): void {
    const nextAttempt = this.reconnectAttempt + 1;
    const willReconnect =
      this.reconnectOptions.enabled && nextAttempt <= this.reconnectOptions.maxAttempts;

    const disconnectInfo: DisconnectInfo = {
      willReconnect,
      ...(closeEvent.code !== undefined ? { code: closeEvent.code } : {}),
      ...(closeEvent.reason !== undefined ? { reason: closeEvent.reason } : {}),
      ...(closeEvent.wasClean !== undefined ? { wasClean: closeEvent.wasClean } : {}),
    };
    this.onDisconnect?.(disconnectInfo);

    if (!willReconnect) {
      const terminalState: ConnectionState = this.reconnectOptions.enabled ? 'failed' : 'disconnected';
      this.setState(terminalState);
      if (this.reconnectOptions.enabled) {
        this.onError?.(
          new Error(
            `WebSocket reconnection failed after ${this.reconnectOptions.maxAttempts} attempts`
          )
        );
      }
      return;
    }

    this.reconnectAttempt = nextAttempt;
    const delayMs = calculateBackoffDelay(
      this.reconnectAttempt,
      this.reconnectOptions,
      this.random
    );

    this.setState('reconnecting');
    this.onReconnecting?.({ attempt: this.reconnectAttempt, delayMs });

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalDisconnect) return;
      this.openSocket(true);
    }, delayMs);
  }

  private async performBackfillAndNotify(attempt: number): Promise<void> {
    let backfilledCount = 0;

    if (this.fetchMissedEvents && this.lastProcessedLedgerSequence !== null) {
      this.isBackfilling = true;
      try {
        const fromLedgerSequence = this.lastProcessedLedgerSequence + 1;
        const missed = await this.fetchMissedEvents({
          fromLedgerSequence,
          filters: this.getActiveFilters(),
        });

        const sorted = [...missed].sort((a, b) => a.ledgerSequence - b.ledgerSequence);
        for (const event of sorted) {
          if (this.processEvent(event)) {
            backfilledCount += 1;
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.onError?.(error);
      } finally {
        this.isBackfilling = false;
        const buffered = this.pendingLiveEvents.splice(0, this.pendingLiveEvents.length);
        buffered.sort((a, b) => a.ledgerSequence - b.ledgerSequence);
        for (const event of buffered) {
          this.processEvent(event);
        }
      }
    }

    this.onReconnect?.({ attempt, backfilledCount });
  }

  private processEvent(event: LedgerEvent): boolean {
    if (this.seenEventIds.has(event.id)) {
      return false;
    }
    this.trackSeenEventId(event.id);

    if (
      this.lastProcessedLedgerSequence === null ||
      event.ledgerSequence > this.lastProcessedLedgerSequence
    ) {
      this.lastProcessedLedgerSequence = event.ledgerSequence;
    }

    for (const sub of this.subscriptions.values()) {
      if (matchesEventFilter(event, sub.filter)) {
        try {
          sub.handler(event);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.onError?.(error);
        }
      }
    }

    return true;
  }

  private trackSeenEventId(id: string): void {
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > this.maxSeenEventIds) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) {
        this.seenEventIds.delete(oldest);
      }
    }
  }

  private sendSubscribeMessage(subscription: ActiveSubscription): void {
    this.sendJson({
      type: 'subscribe',
      subscriptionId: subscription.id,
      filter: subscription.filter,
    });
  }

  private sendJson(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      return;
    }
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(error);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange?.(next);
  }
}

export function createWebSocketEventListener(
  config: WebSocketListenerConfig
): WebSocketEventListener {
  return new WebSocketEventListener(config);
}
