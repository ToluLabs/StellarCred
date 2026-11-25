import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStream, parseEvent, type EventOf, type SocketCtor } from "../event-stream";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  drop() {
    this.onclose?.({});
  }
  fail() {
    this.onerror?.({});
  }
}

const Ctor = FakeSocket as unknown as SocketCtor;
const WS_URL = "wss://indexer.example/events";

const submittedWire = {
  contract: "proof_reg",
  action: "submitted",
  credential_type: "kyc",
  ledger: 10,
  data: { holder: "GHOLDER", issuer: "GISSUER", verified_at: 100, expiry: 999 },
};
const revokedWire = {
  contract: "proof_reg",
  action: "revoked",
  credential_type: "age",
  ledger: 12,
  data: { holder: "GHOLDER", issuer: "GISSUER", revoked_at: 200 },
};
const selfRevWire = {
  contract: "proof_reg",
  action: "self_rev",
  credential_type: "kyc",
  ledger: 13,
  data: { holder: "GHOLDER", revoked_at: 300 },
};

const submitted = {
  type: "proof.submitted",
  claim: "kyc",
  holder: "GHOLDER",
  issuer: "GISSUER",
  verifiedAt: 100,
  expiry: 999,
  ledger: 10,
};
const revoked = {
  type: "proof.revoked",
  claim: "age",
  holder: "GHOLDER",
  issuer: "GISSUER",
  revokedAt: 200,
  ledger: 12,
};
const selfRevoked = {
  type: "proof.self_revoked",
  claim: "kyc",
  holder: "GHOLDER",
  revokedAt: 300,
  ledger: 13,
};

function makeWs(extra = {}) {
  return new EventStream({
    url: WS_URL,
    transport: "websocket",
    WebSocketImpl: Ctor,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    ...extra,
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("EventStream — validation", () => {
  it("rejects an invalid URL", () => {
    expect(
      () => new EventStream({ url: "nope", transport: "websocket", WebSocketImpl: Ctor }),
    ).toThrow(/not a valid URL/);
  });

  it("rejects a protocol that does not match the transport", () => {
    expect(
      () => new EventStream({ url: "https://x.io", transport: "websocket", WebSocketImpl: Ctor }),
    ).toThrow(/ws:/);
    expect(() => new EventStream({ url: WS_URL, transport: "sse", EventSourceImpl: Ctor })).toThrow(
      /http:/,
    );
  });

  it("throws on connect when no implementation exists", () => {
    const g = globalThis as unknown as { WebSocket?: unknown };
    const saved = g.WebSocket;
    g.WebSocket = undefined;
    try {
      const s = new EventStream({ url: WS_URL, transport: "websocket" });
      expect(() => s.connect()).toThrow(/no WebSocket implementation/);
    } finally {
      g.WebSocket = saved;
    }
  });
});

describe("EventStream — delivery", () => {
  it("delivers typed events only to matching handlers", () => {
    const s = makeWs();
    const onSubmitted = vi.fn<(e: EventOf<"proof.submitted">) => void>();
    const onRevoked = vi.fn<(e: EventOf<"proof.revoked">) => void>();
    s.on("proof.submitted", onSubmitted);
    s.on("proof.revoked", onRevoked);
    s.connect();
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].message(JSON.stringify(submittedWire));
    expect(onSubmitted).toHaveBeenCalledWith(submitted);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it("delivers revoked and self-revoked events", () => {
    const s = makeWs();
    const onRevoked = vi.fn();
    const onSelf = vi.fn();
    s.on("proof.revoked", onRevoked);
    s.on("proof.self_revoked", onSelf);
    s.connect();
    FakeSocket.instances[0].message(JSON.stringify(revokedWire));
    FakeSocket.instances[0].message(JSON.stringify(selfRevWire));
    expect(onRevoked).toHaveBeenCalledWith(revoked);
    expect(onSelf).toHaveBeenCalledWith(selfRevoked);
  });

  it("accepts already-parsed objects as message data", () => {
    const s = makeWs();
    const h = vi.fn();
    s.on("proof.submitted", h);
    s.connect();
    FakeSocket.instances[0].message(submittedWire);
    expect(h).toHaveBeenCalledWith(submitted);
  });

  it("reports malformed JSON and unrecognised events without crashing", () => {
    const onError = vi.fn();
    const s = makeWs({ onError });
    const h = vi.fn();
    s.on("proof.submitted", h);
    s.connect();
    const sock = FakeSocket.instances[0];
    sock.message("{not json");
    sock.message(JSON.stringify({ ...submittedWire, contract: "iss_reg" }));
    sock.message(JSON.stringify({ ...submittedWire, data: { holder: "G" } }));
    expect(h).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it("stops delivery after the unsubscribe function or off()", () => {
    const s = makeWs();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribe = s.on("proof.submitted", a);
    s.on("proof.submitted", b);
    s.connect();
    unsubscribe();
    s.off("proof.submitted", b);
    FakeSocket.instances[0].message(JSON.stringify(submittedWire));
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("isolates a throwing handler from the others", () => {
    const onError = vi.fn();
    const s = makeWs({ onError });
    const good = vi.fn();
    s.on("proof.submitted", () => {
      throw new Error("boom");
    });
    s.on("proof.submitted", good);
    s.connect();
    FakeSocket.instances[0].message(JSON.stringify(submittedWire));
    expect(good).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("works over the SSE transport", () => {
    const s = new EventStream({
      url: "https://indexer.example/events/stream",
      transport: "sse",
      EventSourceImpl: Ctor,
    });
    const h = vi.fn();
    s.on("proof.revoked", h);
    s.connect();
    FakeSocket.instances[0].message(JSON.stringify(revokedWire));
    expect(h).toHaveBeenCalledWith(revoked);
  });
});

describe("EventStream — connection lifecycle", () => {
  it("tracks state and ignores a second connect()", () => {
    const s = makeWs();
    expect(s.state).toBe("idle");
    s.connect();
    s.connect();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(s.state).toBe("connecting");
    FakeSocket.instances[0].open();
    expect(s.state).toBe("open");
  });

  it("reconnects with exponential backoff", () => {
    const s = makeWs({ maxRetries: 5 });
    s.connect();
    FakeSocket.instances[0].drop();
    vi.advanceTimersByTime(99);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].drop();
    vi.advanceTimersByTime(199);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("caps the backoff at maxDelayMs", () => {
    const s = makeWs({ maxRetries: 10, baseDelayMs: 100, maxDelayMs: 150 });
    s.connect();
    FakeSocket.instances[0].drop();
    vi.advanceTimersByTime(100);
    FakeSocket.instances[1].drop();
    vi.advanceTimersByTime(150); // would be 200 without the cap
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("resets the retry counter once a connection opens", () => {
    const s = makeWs({ maxRetries: 1 });
    s.connect();
    FakeSocket.instances[0].drop();
    vi.advanceTimersByTime(100);
    FakeSocket.instances[1].open();
    FakeSocket.instances[1].drop();
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(3);
    expect(s.state).toBe("connecting");
  });

  it("gives up after maxRetries and reports it", () => {
    const onError = vi.fn();
    const s = makeWs({ maxRetries: 2, onError });
    s.connect();
    FakeSocket.instances[0].drop();
    vi.advanceTimersByTime(100);
    FakeSocket.instances[1].drop();
    vi.advanceTimersByTime(200);
    FakeSocket.instances[2].drop();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(3);
    expect(s.state).toBe("closed");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("gave up") }),
    );
  });

  it("reconnects SSE after an error event", () => {
    const s = new EventStream({
      url: "https://indexer.example/events/stream",
      transport: "sse",
      EventSourceImpl: Ctor,
      baseDelayMs: 100,
      onError: () => {},
    });
    s.connect();
    FakeSocket.instances[0].fail();
    expect(FakeSocket.instances[0].closed).toBe(true);
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("disconnect() closes the socket and cancels pending reconnects", () => {
    const s = makeWs();
    s.connect();
    FakeSocket.instances[0].drop();
    s.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(s.state).toBe("closed");

    const s2 = makeWs();
    s2.connect();
    const sock = FakeSocket.instances[1];
    s2.disconnect();
    expect(sock.closed).toBe(true);
  });

  it("ignores events from a socket that was already replaced", () => {
    const s = makeWs();
    const h = vi.fn();
    s.on("proof.submitted", h);
    s.connect();
    const old = FakeSocket.instances[0];
    s.disconnect();
    old.message(JSON.stringify(submittedWire));
    expect(h).not.toHaveBeenCalled();
  });

  it("can connect again after disconnect()", () => {
    const s = makeWs();
    s.connect();
    s.disconnect();
    s.connect();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(s.state).toBe("connecting");
  });
});

describe("parseEvent", () => {
  it("maps wire messages to typed events", () => {
    expect(parseEvent(submittedWire)).toEqual(submitted);
    expect(parseEvent(revokedWire)).toEqual(revoked);
    expect(parseEvent(selfRevWire)).toEqual(selfRevoked);
  });

  it("rejects bad shapes", () => {
    expect(parseEvent(null)).toBeNull();
    expect(parseEvent("x")).toBeNull();
    expect(parseEvent({ ...submittedWire, action: "paused" })).toBeNull();
    expect(parseEvent({ ...submittedWire, ledger: "10" })).toBeNull();
    expect(parseEvent({ ...revokedWire, data: { holder: "G", issuer: "I" } })).toBeNull();
    expect(parseEvent({ ...selfRevWire, data: { holder: 5, revoked_at: 1 } })).toBeNull();
  });
});
