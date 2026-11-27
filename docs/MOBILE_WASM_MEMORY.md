# Mobile WASM prover memory

## Transport and witness lifecycle

The `/api/witness` route returns the Noir witness as
`application/octet-stream`. It previously returned the same bytes as an uppercase
hex string inside JSON, which approximately doubled witness transport text and
required a full second `Uint8Array` allocation in the browser. The browser
client accepts the binary response and retains the hex JSON format only as a
compatibility fallback for a rolling deployment.

Witness bytes are held only in the dedicated prover worker. After proving
succeeds or fails, the worker drops its reference. Cancellation and backend
destruction also evict the cached backend and release the owning WASM instance.
No forced garbage collection API is used.

## Circuit artifacts and Barretenberg WASM

Compiled circuit JSON is fetched and parsed once per circuit type in a worker
and is shared with concurrent backend construction. Repeated warms and proof
attempts reuse the same artifact and backend. Backend reuse remains optional:
page teardown destroys every backend.

For resource-constrained realms, Barretenberg `UltraHonkBackend` is constructed
with `threads: 1`. This avoids a pool of independent worker/WASM heaps on
mobile browsers and is selected for Android, iPhone/iPad, low-core devices, or
devices reporting no more than 4 GB of memory. Desktop cross-origin-isolated
realms keep bb.js's normal thread-pool behavior.

bb.js owns its WASM linear memory and allocator. This change does not assume
that linear memory can be partially freed or shrunk. It only uses the public
`destroy()` lifecycle and does not write to internal memory or allocator state.

## Benchmark methodology

Memory measurements must cover:

1. circuit artifact fetch and parse;
2. witness response transfer and decode;
3. Barretenberg/WASM initialization;
4. proof generation;
5. backend destruction and repeated proving.

For Chromium, use Playwright CDP `Performance.getMetrics` and OS process
metrics where available. CDP JS heap metrics are insufficient for this target
because they exclude WASM linear memory and worker process allocations. Chrome
Task Manager or a mobile/desktop OS process sampler should be used to measure
the browser process and dedicated worker total where supported.

The acceptance limit is 250 MB peak **total relevant process memory**. A run
that exceeds 250 MB must be reported, even if JavaScript heap usage remains
below the limit. Browser tooling limitations must be recorded rather than
converted into unsupported claims.
