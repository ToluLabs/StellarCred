// @stellarcred/sdk — push-based credential events (WebSocket / SSE)
//
// Complements `subscribeClaims` (subscriptions.ts), which polls the indexer
// over HTTP. EventStream receives events as they happen instead.
//
// Wire format (JSON, one message per event) mirrors docs/EVENTS.md:
//   { "contract": "proof_reg", "action": "submitted" | "revoked" | "self_rev",
//     "credential_type": "kyc", "ledger": 123, "data": { ...payload fields } }

interface BaseEvent {
  claim: string;
  holder: string;
  ledger: number;
}

/** proof_reg.submitted — proof verified and stored. */
export interface ProofSubmittedEvent extends BaseEvent {
  type: "proof.submitted";
  issuer: string;
  verifiedAt: number;
  expiry: number;
}

/** proof_reg.revoked — revoked by the issuer. */
export interface ProofRevokedEvent extends BaseEvent {
  type: "proof.revoked";
  issuer: string;
  revokedAt: number;
}

/** proof_reg.self_rev — removed by the holder. */
export interface ProofSelfRevokedEvent extends BaseEvent {
  type: "proof.self_revoked";
  revokedAt: number;
}

export type CredentialEvent = ProofSubmittedEvent | ProofRevokedEvent | ProofSelfRevokedEvent;

export type EventType = CredentialEvent["type"];
export type EventOf<T extends EventType> = Extract<CredentialEvent, { type: T }>;
export type EventHandler<T extends EventType> = (event: EventOf<T>) => void;

export type EventStreamTransport = "websocket" | "sse";
export type EventStreamState = "idle" | "connecting" | "open" | "closed";

/** Minimal shape shared by WebSocket and EventSource. */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}
export type SocketCtor = new (url: string) => SocketLike;

export interface EventStreamOptions {
  /** ws(s):// for "websocket", http(s):// for "sse". */
  url: string;
  transport: EventStreamTransport;
  /** Reconnect attempts before giving up. Default: 5. */
  maxRetries?: number;
  /** First reconnect delay in ms (doubles each attempt). Default: 1000. */
  baseDelayMs?: number;
  /** Upper bound for the reconnect delay. Default: 30000. */
  maxDelayMs?: number;
  /** Receives transport errors, malformed messages and handler exceptions. */
  onError?: (error: unknown) => void;
  /** Override the global WebSocket (tests, Node < 22). */
  WebSocketImpl?: SocketCtor;
  /** Override the global EventSource (tests, Node). */
  EventSourceImpl?: SocketCtor;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number";

/** Validate one wire message and convert it to a typed event, or null. */
export function parseEvent(raw: unknown): CredentialEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as Record<string, unknown>;
  if (w.contract !== "proof_reg") return null;
  if (typeof w.data !== "object" || w.data === null) return null;
  const data = w.data as Record<string, unknown>;

  const claim = w.credential_type;
  const ledger = w.ledger;
  const holder = data.holder;
  if (!isString(claim) || !isNumber(ledger) || !isString(holder)) return null;
  const base = { claim, holder, ledger };

  switch (w.action) {
    case "submitted":
      if (!isString(data.issuer) || !isNumber(data.verified_at) || !isNumber(data.expiry)) {
        return null;
      }
      return {
        type: "proof.submitted",
        ...base,
        issuer: data.issuer,
        verifiedAt: data.verified_at,
        expiry: data.expiry,
      };
    case "revoked":
      if (!isString(data.issuer) || !isNumber(data.revoked_at)) return null;
      return {
        type: "proof.revoked",
        ...base,
        issuer: data.issuer,
        revokedAt: data.revoked_at,
      };
    case "self_rev":
      if (!isNumber(data.revoked_at)) return null;
      return { type: "proof.self_revoked", ...base, revokedAt: data.revoked_at };
    default:
      return null;
  }
}

type AnyHandler = (event: CredentialEvent) => void;

export class EventStream {
  private readonly handlers = new Map<EventType, Set<AnyHandler>>();
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private current: EventStreamState = "idle";

  constructor(private readonly opts: EventStreamOptions) {
    let parsed: URL;
    try {
      parsed = new URL(opts.url);
    } catch {
      throw new Error(`EventStream: "${opts.url}" is not a valid URL`);
    }
    const allowed = opts.transport === "websocket" ? ["ws:", "wss:"] : ["http:", "https:"];
    if (!allowed.includes(parsed.protocol)) {
      throw new Error(
        `EventStream: ${opts.transport} transport needs a ${allowed.join(" or ")} URL, got "${parsed.protocol}"`,
      );
    }
  }

  get state(): EventStreamState {
    return this.current;
  }

  /** Subscribe to one event type. Returns an unsubscribe function. */
  on<T extends EventType>(type: T, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as unknown as AnyHandler);
    return () => this.off(type, handler);
  }

  off<T extends EventType>(type: T, handler: EventHandler<T>): void {
    this.handlers.get(type)?.delete(handler as unknown as AnyHandler);
  }

  /** Open the stream. No-op if already connecting or open. */
  connect(): void {
    if (this.current === "connecting" || this.current === "open") return;
    this.clearTimer();
    this.retries = 0;
    this.current = "connecting";
    this.open();
  }

  /** Close the stream and stop reconnecting. Safe to call repeatedly. */
  disconnect(): void {
    this.clearTimer();
    const socket = this.socket;
    this.socket = null;
    this.current = "closed";
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
  }

  private open(): void {
    const g = globalThis as unknown as {
      WebSocket?: SocketCtor;
      EventSource?: SocketCtor;
    };
    const isWs = this.opts.transport === "websocket";
    const Ctor = isWs
      ? (this.opts.WebSocketImpl ?? g.WebSocket)
      : (this.opts.EventSourceImpl ?? g.EventSource);
    if (!Ctor) {
      this.current = "closed";
      throw new Error(
        `EventStream: no ${isWs ? "WebSocket" : "EventSource"} implementation available`,
      );
    }

    const socket = new Ctor(this.opts.url);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.retries = 0;
      this.current = "open";
    };
    socket.onmessage = (m) => {
      if (this.socket !== socket) return;
      this.dispatch(m.data);
    };
    socket.onerror = (e) => {
      if (this.socket !== socket) return;
      const error = new Error("EventStream transport error") as Error & { cause?: unknown };
      error.cause = e;
      this.report(error);
      // EventSource has no close event: an error means the connection dropped.
      if (!isWs) this.handleDrop(socket);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.handleDrop(socket);
    };
  }

  private handleDrop(socket: SocketLike): void {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    this.socket = null;

    const max = this.opts.maxRetries ?? 5;
    if (this.retries >= max) {
      this.current = "closed";
      this.report(new Error(`EventStream gave up after ${max} reconnect attempts`));
      return;
    }
    const base = this.opts.baseDelayMs ?? 1000;
    const cap = this.opts.maxDelayMs ?? 30_000;
    const delay = Math.min(base * 2 ** this.retries, cap);
    this.retries++;
    this.current = "connecting";
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  private dispatch(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      this.report(new Error("EventStream received malformed JSON"));
      return;
    }
    const event = parseEvent(parsed);
    if (!event) {
      this.report(new Error("EventStream received an unrecognised event"));
      return;
    }
    for (const handler of [...(this.handlers.get(event.type) ?? [])]) {
      try {
        handler(event);
      } catch (err) {
        this.report(err);
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.opts.onError?.(error);
    } catch {
      /* never let onError break the stream */
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
