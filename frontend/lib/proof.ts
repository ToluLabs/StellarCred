// Client-side zero-knowledge proof generation — the proving *engine*.
//
// Witness generation (Noir circuit execution) runs server-side via POST /api/witness —
// this avoids bundling @noir-lang/acvm_js WASM through Next.js/webpack, which fails in
// dev mode for packages inside pnpm's nested .pnpm/ layout. The witness bytes are
// returned as a hex string and decoded here.
//
// Proving (UltraHonk) still runs entirely in the browser via /public/bb/ (loaded with
// webpackIgnore so webpack never touches it). Private inputs are sent to our own server
// for witness generation only; the proof itself is computed locally.
//
// Toolchain must match the contracts: Noir 1.0.0-beta.9 / bb 0.87.0.
//
// ── Where this code runs ────────────────────────────────────────────────────
// Everything below is context-free on purpose: it touches no DOM and reads
// cross-origin isolation off `globalThis`, so the exact same module runs either
//   • inside the dedicated prover worker (lib/proof-worker.ts) — the normal
//     path, keeping witness decoding, backend construction and proof
//     orchestration off the main thread — or
//   • on the main thread, as the fallback lib/proof-client.ts uses when Web
//     Workers are unavailable (jsdom/unit tests, a worker blocked by CSP, or a
//     worker script that failed to load).
// Because both paths share this module, the fallback is behaviourally identical
// to the worker path — only the thread differs.

import type { CredentialType } from "./stellar";

/** The compiled Noir circuit artifact emitted by circuits/scripts/build.sh to
 * /public/circuits/<type>.json.
 */
export interface CircuitArtifact {
  bytecode: string;
}

export interface GeneratedProof {
  /** Raw proof bytes (456 fields × 32 = 14592 bytes), as the contract expects. */
  proof: Uint8Array;
  /** Public inputs serialized as concatenated 32-byte big-endian field elements. */
  publicInputs: Uint8Array;
}

/**
 * A circuit the prover can run: any single-credential type, plus the
 * multi-credential `aggregate` circuit (which is not itself a credential type
 * but is compiled and served exactly like one). Naming this once keeps the
 * `as any` casts the aggregate path used to need out of the codebase.
 */
export type ProverCircuit = CredentialType | "aggregate";

// bb.js returns public inputs as an array of 0x-prefixed field hex strings. The
// contract expects them concatenated as 32-byte big-endian values.
function fieldsToBytes(fields: string[]): Uint8Array {
  const out = new Uint8Array(fields.length * 32);
  fields.forEach((f, i) => {
    const hex = f.replace(/^0x/, "").padStart(64, "0");
    for (let j = 0; j < 32; j++) {
      out[i * 32 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
    }
  });
  return out;
}

// bb.js's UltraHonkBackend always spawns a Web Worker from its prebuilt
// main.worker.js (`new Worker(new URL("./main.worker.js", import.meta.url))`).
// If Next.js/webpack bundles bb.js, it re-wraps that already-bundled worker and
// corrupts it ("Object.defineProperty called on non-object"). So instead we load
// bb.js as a *native* ES module from /public/bb (copied there by
// scripts/copy-bb.mjs on predev/prebuild). `webpackIgnore` keeps webpack from
// touching the import; the browser then resolves main.worker.js / barretenberg.js
// relative to /bb/index.js, untouched.
type BbModule = {
  UltraHonkBackend: new (
    bytecode: string,
    options?: { threads?: number },
  ) => {
    generateProof: (
      witness: Uint8Array,
      options?: { keccak?: boolean },
    ) => Promise<{ proof: Uint8Array; publicInputs: string[] }>;
    destroy: () => Promise<void>;
  };
};

async function loadBb(): Promise<BbModule> {
  // @ts-expect-error - resolved at runtime by the browser from /public/bb, not a build-time module.
  return import(/* webpackIgnore: true */ "/bb/index.js") as Promise<BbModule>;
}

type Backend = InstanceType<BbModule["UltraHonkBackend"]>;

// Constructed (or in-flight) UltraHonkBackend instances, keyed by circuit
// type, for this browser tab's session. Construction is the expensive part
// (bytecode fetch + wasm init), so once a backend exists for a type we keep
// it around and reuse it across every subsequent proof of that type instead
// of tearing it down after each use. Callers that own this cache's lifecycle
// (see lib/use-warm-prover.ts) are responsible for calling destroyBackend /
// destroyAllBackends when it's time to let the wasm memory go (e.g. the
// holder page unmounting or the tab closing) -- this module never does so on
// its own.
const backendCache = new Map<ProverCircuit, Promise<Backend>>();

// Multithreading is only safe once the *realm running this code* is
// crossOriginIsolated (COOP/COEP headers — see next.config.mjs). Read the live
// value at construction time rather than caching it, so a proxy/CDN stripping
// those headers still falls back correctly to the single-threaded path.
// Omitting `threads` when isolated lets bb.js pick its own worker-pool size
// (it reads navigator.hardwareConcurrency internally); logged once so the
// choice is visible in the field.
//
// `globalThis`, not `window`: this module normally executes inside the
// dedicated prover worker, which has no `window`. A dedicated worker created
// by a cross-origin-isolated page is itself cross-origin isolated, so
// `globalThis.crossOriginIsolated` / SharedArrayBuffer stay available there and
// bb.js takes the same multithreaded path it took on the main thread. (bb.js
// makes the identical `typeof window !== "undefined" ? window : globalThis`
// check internally before choosing its thread count.)
let loggedIsolation = false;

function backendOptions(): { threads?: number } {
  const isolated = Boolean(globalThis.crossOriginIsolated);
  if (!loggedIsolation) {
    loggedIsolation = true;
    console.info(`[proof] crossOriginIsolated=${isolated}`);
  }
  if (isolated) {
    return {};
  }
  return { threads: 1 };
}

async function buildBackend(type: ProverCircuit): Promise<Backend> {
  const circuitRes = await fetch(`/circuits/${type}.json`);
  if (!circuitRes.ok) {
    throw new Error(
      `Compiled circuit "${type}" not found. Run the circuit build to emit /public/circuits/${type}.json.`,
    );
  }
  const circuit = (await circuitRes.json()) as CircuitArtifact;
  const { UltraHonkBackend } = await loadBb();
  return new UltraHonkBackend(circuit.bytecode, backendOptions());
}

// Returns the cached (or in-flight) backend for `type`, constructing one if
// none exists yet. Concurrent callers for the same type -- e.g. the warm
// trigger firing twice under React StrictMode, or a real prove click racing
// an in-flight warm -- share this exact promise instead of racing separate
// constructions, since the cache is checked and populated synchronously
// (no `await` between the `get` and the `set`).
function getBackend(type: ProverCircuit): Promise<Backend> {
  let pending = backendCache.get(type);
  if (!pending) {
    pending = buildBackend(type);
    backendCache.set(type, pending);
    // A failed construction must not permanently poison the cache for this
    // type -- evict it so the next call (a warm retry, or the user's actual
    // prove click) gets a fresh attempt instead of replaying the same error
    // forever.
    pending.catch(() => {
      if (backendCache.get(type) === pending) backendCache.delete(type);
    });
  }
  return pending;
}

// Warms the prover for `type` in the background: kicks off backend
// construction (bytecode fetch + wasm init) without blocking the caller or
// throwing. Meant to be called ahead of time (see use-warm-prover.ts) so the
// eventual prove click hits an already-warm cache. If warming fails (network
// error, wasm init failure, etc.) it's logged and swallowed -- the real
// prove click still falls back to constructing fresh via proveWithBackend.
export function warmBackend(type: ProverCircuit): void {
  const before = backendCache.get(type);
  const pending = getBackend(type);
  if (pending !== before) {
    pending.catch((err) => {
      console.warn(`[proof] Failed to warm prover for "${type}":`, err);
    });
  }
}

// Destroys and evicts the cached backend for `type`, if one exists. Safe to
// call even when nothing was ever warmed/proved for that type.
export async function destroyBackend(type: ProverCircuit): Promise<void> {
  const pending = backendCache.get(type);
  if (!pending) return;
  backendCache.delete(type);
  try {
    const backend = await pending;
    await backend.destroy();
  } catch {
    // Construction itself failed, or destroy() threw -- either way there's
    // nothing left to clean up.
  }
}

// Destroys every cached backend. Intended for page unmount / navigating away
// from the holder page (see use-warm-prover.ts), so wasm memory isn't held
// for the rest of the tab's lifetime once the user is done proving.
export async function destroyAllBackends(): Promise<void> {
  await Promise.all(Array.from(backendCache.keys()).map(destroyBackend));
}

// Stage 1 — server computes the witness (Noir circuit execution).
// Exported so ProofFlow can report progress between stages.
// When signal is provided, fetch abort cancels the server-side witness computation.
export async function computeWitness(
  type: ProverCircuit,
  credential: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetch("/api/witness", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, credential }),
    signal,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Witness generation failed: ${msg}`);
  }
  const { witness: hex } = (await res.json()) as { witness: string };
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Stage 2 — browser runs UltraHonk over the witness.
// Exported so ProofFlow can call it after stage 1 completes.
// Reuses the cached backend for `type` (see getBackend above) if one is
// already warm or warming, constructing one on demand otherwise. Unlike the
// original implementation, this deliberately does NOT destroy the backend
// afterwards -- the whole point of the cache is that a second proof of the
// same type (a retry, or the next credential in a batch) reuses the already-
// initialized wasm instance instead of paying construction cost again.
// Destruction is the cache owner's responsibility (see destroyBackend /
// destroyAllBackends, called from use-warm-prover.ts on unmount).
// When signal is provided, aborting it terminates the WASM worker mid-proof.
export async function proveWithBackend(
  type: ProverCircuit,
  witness: Uint8Array,
  signal?: AbortSignal,
  onStep?: (step: "circuit" | "proof") => void,
): Promise<GeneratedProof> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  if (onStep) onStep("circuit");
  const backend = await getBackend(type);
  if (onStep) onStep("proof");

  // Abort destroys the WASM worker, causing generateProof() to reject.
  const abort = () => destroyBackend(type);
  signal?.addEventListener("abort", abort);
  try {
    const { proof, publicInputs } = await backend.generateProof(witness, {
      keccak: true,
    });
    return { proof, publicInputs: fieldsToBytes(publicInputs) };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

// Convenience wrapper — runs both stages in sequence.
export async function generateProof(
  type: ProverCircuit,
  credential: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GeneratedProof> {
  const witness = await computeWitness(type, credential, signal);
  return proveWithBackend(type, witness, signal);
}

// ── Aggregate proof generation ───────────────────────────────────────────────
// For the N=2 PoC (KYC + age), this generates a single aggregate proof that
// proves both credentials in one circuit. The inner credentials must have been
// issued by the same or compatible issuers with matching public keys.

export interface AggregateInput {
  /** Full KYC credential — private fields (value/secret, salt, sig) plus the
   * public fields the aggregate circuit re-verifies (commitment, issuerPubX,
   * issuerPubY). Byte arrays (sig, issuerPubX/Y) must be `number[]`. */
  kyc: Record<string, unknown>;
  /** Full age credential — private fields (date_of_birth/value, salt, sig) plus
   * the public fields (commitment, issuerPubX, issuerPubY, and the claimed
   * threshold via claimParams.threshold_years). Byte arrays (sig,
   * issuerPubX/Y) must be `number[]`. */
  age: Record<string, unknown>;
}

// Resolves a required aggregate-circuit input from one of two shapes the inner
// credentials may arrive in (e.g. "secret" vs "value", "date_of_birth" vs
// "value"). Throws with a clear message when the field is missing from both
// keys — never silently serializes an `undefined` into the witness payload,
// which would otherwise surface as a confusing backend error.
function resolveAggregateField(
  credential: Record<string, unknown>,
  key: string,
  alias?: string,
): unknown {
  const value = credential[key] ?? (alias ? credential[alias] : undefined);
  if (value === undefined || value === null) {
    throw new Error(
      `Aggregate proof: missing required field "${key}"${
        alias ? ` (or "${alias}")` : ""
      } in credential inputs.`,
    );
  }
  return value;
}

export async function computeAggregateWitness(
  inputs: AggregateInput,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  // Build the merged credential object with prefixed keys matching the aggregate
  // circuit's parameter names. Noir treats `pub` parameters as ordinary witness
  // inputs too — the backend never derives them from the private inputs — so the
  // payload must carry ALL circuit inputs: the 6 private fields (secrets, salts,
  // signatures) AND the 9 public fields (commitments, issuer pubkeys, age
  // date/threshold, num_credentials). Omitting any of them makes witness
  // generation fail with an unresolved-witness error.
  const ageParams = (inputs.age.claimParams ?? {}) as Record<string, unknown>;
  // Field elements are coerced with String() — matching buildInputs in
  // /api/witness — so numeric inputs arrive as decimal strings like the rest of
  // the codebase; byte arrays (signatures, issuer pubkeys) pass through as-is.
  const aggregateCredential = {
    // ── KYC credential (private) ────────────────────────────────────────────
    kyc_secret: String(resolveAggregateField(inputs.kyc, "value", "secret")),
    kyc_salt: String(resolveAggregateField(inputs.kyc, "salt")),
    kyc_sig: resolveAggregateField(inputs.kyc, "sig"),
    // ── KYC credential (public) ─────────────────────────────────────────────
    kyc_commitment: String(resolveAggregateField(inputs.kyc, "commitment")),
    kyc_issuer_x: resolveAggregateField(inputs.kyc, "issuerPubX"),
    kyc_issuer_y: resolveAggregateField(inputs.kyc, "issuerPubY"),
    // ── Age credential (private) ────────────────────────────────────────────
    age_date_of_birth: String(resolveAggregateField(inputs.age, "date_of_birth", "value")),
    age_salt: String(resolveAggregateField(inputs.age, "salt")),
    age_sig: resolveAggregateField(inputs.age, "sig"),
    // ── Age credential (public) ─────────────────────────────────────────────
    age_commitment: String(resolveAggregateField(inputs.age, "commitment")),
    age_issuer_x: resolveAggregateField(inputs.age, "issuerPubX"),
    age_issuer_y: resolveAggregateField(inputs.age, "issuerPubY"),
    // Days since epoch — mirrors the single-proof age path, which derives
    // current_date server-side.
    age_current_date: String(Math.floor(Date.now() / 86_400_000)),
    age_threshold_years: String(
      inputs.age.threshold_years ?? ageParams.threshold_years ?? 18,
    ),
    // ── Metadata (public) ───────────────────────────────────────────────────
    // The PoC circuit asserts num_credentials == 2.
    num_credentials: "2",
  };

  const res = await fetch("/api/witness", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "aggregate", credential: aggregateCredential }),
    signal,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Aggregate witness generation failed: ${msg}`);
  }
  const { witness: hex } = (await res.json()) as { witness: string };
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function generateAggregateProof(
  inputs: AggregateInput,
  signal?: AbortSignal,
): Promise<GeneratedProof> {
  const witness = await computeAggregateWitness(inputs, signal);
  return proveWithBackend("aggregate", witness, signal);
}
