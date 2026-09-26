# Issuer Key Rotation & Revocation Runbook

Operational procedure for rotating an issuer's secp256k1 signing key and for
emergency-revoking a compromised one.

Companion to the HSM/KMS work (#69). Where a key lives is an infrastructure
question; this document covers what has to happen **on-chain** so that
outstanding credentials survive the move.

---

## Background

A credential's trust root is a single secp256k1 key: the circuit verifies the
issuer's signature over the commitment, and `ProofRegistry` checks that the
public key carried in the proof's public inputs is one the registry currently
accepts for that issuer.

Before this feature the registry held exactly one key per issuer. Rotating it
was therefore destructive — every credential already issued carried a signature
from the old key, the registry held the new one, and submissions failed with
`IssuerKeyMismatch` (error #5). An issuer rotating a key silently invalidated
all of its outstanding credentials, with no migration path.

`IssuerRegistry` now supports **multiple keys per issuer, each with a validity
window**:

| Concept | Meaning |
|---|---|
| **Current key** | The issuer's active signing key. Mirrored in `Issuer::pubkey`, so existing indexers, UIs and the SDK need no change. New issuance must use it. |
| **Retired key** | A previous key, still accepted until its `valid_until` timestamp. Exists so already-issued credentials keep verifying. |
| **Revoked key** | Rejected immediately, whatever its window said. The compromise response. |

---

## Rotation vs. revocation

|  | Rotate | Revoke |
|---|---|---|
| Entry point | `rotate_issuer_key` | `revoke_issuer_key` |
| Effect on the old key | Valid until `now + overlap_secs` | Invalid immediately |
| Use when | Scheduled rotation, HSM/KMS migration, planned key hygiene | Compromise, leak, suspected key exposure |
| Outstanding credentials | Keep working for the window | Stop being submittable at once |
| Event | `iss_reg.key_rot` | `iss_reg.key_rev` |
| Retryable | No — state changes | Yes — idempotent |

**Choose revocation whenever the key may be in someone else's hands.** During
an overlap window a superseded key can still mint *new* credentials, so a
rotation is not a containment strategy.

---

## Procedure A — Planned rotation

Use for scheduled rotation, HSM migration (#69), or key hygiene. No credential
is invalidated.

**Preconditions**

- You hold the `IssuerRegistry` admin key (ideally a multisig — see
  [SECURITY.md](../SECURITY.md#1-administrative-key-management-admin-key)).
- The new keypair is generated and the private key is already in your KMS/HSM
  and reachable by the issuing service.
- You have chosen an overlap window (see [Choosing an overlap window](#choosing-an-overlap-window)).

**Steps**

1. **Load the issuer's current key state and keep it for the audit trail.**

   ```bash
   stellar contract invoke \
     --id "$ISSUER_REGISTRY_ID" \
     --source "$SOURCE" --network "$NETWORK" \
     -- get_issuer_keys --issuer_id "$ISSUER"
   ```

   Record the output. This is your "before" snapshot and it is what the
   `iss_reg.key_rot` event will be reconciled against.

2. **Rotate.** `overlap_secs` is in seconds.

   ```bash
   stellar contract invoke \
     --id "$ISSUER_REGISTRY_ID" \
     --source "$SOURCE" --network "$NETWORK" \
     --send yes \
     -- rotate_issuer_key \
     --issuer_id "$ISSUER" \
     --new_pubkey "$NEW_PUBKEY_HEX" \
     --overlap_secs 2592000
   ```

3. **Confirm the new key is current and the old one is still honoured.**

   ```bash
   stellar contract invoke \
     --id "$ISSUER_REGISTRY_ID" \
     --source "$SOURCE" --network "$NETWORK" \
     -- get_issuer_pubkey --issuer_id "$ISSUER"
   # -> must equal $NEW_PUBKEY_HEX

   stellar contract invoke \
     --id "$ISSUER_REGISTRY_ID" \
     --source "$SOURCE" --network "$NETWORK" \
     -- is_issuer_key_valid --issuer_id "$ISSUER" --pubkey "$OLD_PUBKEY_HEX"
   # -> true during the window, false once it closes
   ```

4. **Switch the issuing service to the new private key.** This is a secret
   change, not a contract change: update the value the signing service reads
   (never a `NEXT_PUBLIC_`-prefixed variable) in the secret manager, then roll
   the service. New credentials are signed with the new key from this point.

   Order matters: rotate on-chain **before** switching the service, so that any
   credential signed in the gap is still backed by a key the registry accepts.
   If you invert the order, credentials issued in the gap fail until the
   rotation lands.

5. **Verify the `iss_reg.key_rot` event.** It carries the outgoing key, the
   incoming key, and the exact timestamp the old key stops being accepted. Use
   this to schedule the follow-up check and to satisfy the audit log.

**After the window closes**

Nothing needs to happen on-chain. The retired key stops being accepted on its
own once `previous_valid_until` passes, and the record ages out of storage.
`get_issuer_keys` keeps showing the key with its closed window as history.

---

## Procedure B — Emergency revocation

Use when the key is compromised, leaked, or suspected exposed. This stops
acceptance immediately; it does **not** wait out any remaining overlap.

**Steps**

1. **Revoke the compromised key.**

   ```bash
   stellar contract invoke \
     --id "$ISSUER_REGISTRY_ID" \
     --source "$SOURCE" --network "$NETWORK" \
     --send yes \
     -- revoke_issuer_key \
     --issuer_id "$ISSUER" \
     --pubkey "$COMPROMISED_PUBKEY_HEX"
   ```

   The call is idempotent: re-running it is a safe no-op, so an incident
   runbook can be executed more than once. The first revocation timestamp is
   preserved.

2. **Confirm it took effect.**

   ```bash
   stellar contract invoke \
     --id "$ISSUER_REGISTRY_ID" \
     --source "$SOURCE" --network "$NETWORK" \
     -- is_issuer_key_valid --issuer_id "$ISSUER" --pubkey "$COMPROMISED_PUBKEY_HEX"
   # -> false
   ```

3. **Rotate to a fresh key** (Procedure A step 2) so issuance can resume.

   A revoked key can never be reinstated — `rotate_issuer_key` rejects it.
   Recovery means moving forward to a new key, not restoring the old one.

4. **Assess the blast radius.** Any credential that was *already verified and
   cached* on-chain stays valid until its own `expiry`; revoking a signing key
   does not retroactively invalidate stored `ProofRecord`s. To invalidate a
   specific cached proof, use `ProofRegistry::revoke_proof` for that holder and
   credential type.

5. **Notify holders.** Anyone holding a credential signed by the compromised key
   must re-prove against the new key. Because the retired key is rejected, their
   old proof will not submit — this is intended. Plan the communication with
   the revocation, not after it.

---

## Choosing an overlap window

`overlap_secs` must satisfy `0 < overlap_secs <= 7776000` (90 days). A zero
window is rejected (`InvalidOverlap`) — use revocation instead, which is the
explicit, evented, retryable path for "stop now".

**The cap is 90 days because that is `ProofRegistry`'s proof TTL.** A cached
proof is evicted after 90 days, so a longer window would not keep any
additional credential verifiable. It would only widen the period during which a
superseded key can mint *new* credentials — precisely the risk rotation is meant
to close.

Sizing guidance:

| Situation | Suggested window |
|---|---|
| HSM/KMS migration, no key-exposure concern | The shortest that covers your credential lifetime — 7–30 days is typical |
| Issuer cannot re-issue on demand (slow KYC, offline holders) | 60–90 days, close to the cap |
| Key hygiene only, all credentials short-lived | The minimum, ~7 days |

Widest-first: prefer the **shortest** window your re-issuance process can
tolerate. Each extra day is a day the old key can still sign.

---

## Queries

| Call | Purpose |
|---|---|
| `get_issuer_keys(issuer_id)` | All tracked keys with validity windows and revocation state. Start here. |
| `get_issuer_key(issuer_id, pubkey)` | One key's record, or `None` if never registered. |
| `get_issuer_pubkey(issuer_id)` | The issuer's **current** key. Unchanged semantics. |
| `is_issuer_key_valid(issuer_id, pubkey)` | Would a proof carrying this key be accepted right now? |

---

## Errors

| Code | Name | Meaning during key ops |
|---|---|---|
| 4 | `KeyNotFound` | Revoking a key that was never registered for this issuer. |
| 5 | `TooManyKeys` | The issuer already tracks 4 keys (`MAX_KEYS_PER_ISSUER`). |
| 6 | `InvalidOverlap` | `overlap_secs` is 0. Use `revoke_issuer_key`. |
| 7 | `OverlapTooLong` | `overlap_secs` exceeds 90 days. |
| 8 | `RotationNoop` | The new key is already current, or `register_issuer` was used to change a key. |
| 9 | `KeyRevoked` | The new key was previously revoked. Revocation is permanent. |

`ProofRegistry` error 5, `IssuerKeyMismatch`, now means one of:

- the key was revoked, or
- the key's validity window has closed, or
- the key was never registered for this issuer.

It no longer means "the issuer rotated".

---

## Operational limits and invariants

- **At most 4 keys per issuer** (`MAX_KEYS_PER_ISSUER`). Rotating back to a key
  whose window is still open reuses its slot rather than consuming a new one.
  Once the bound is hit, old records must age out of storage — they do so on
  their own after ~180 days.
- **A rotation never extends a closing window.** If the outgoing key was already
  retired, the earlier of the two deadlines wins. A rotation cannot be used to
  keep a key alive.
- **`register_issuer` cannot change an issuer's signing key.** It has no overlap
  parameter, so allowing it to swap keys would reintroduce the original bug. Use
  it only for first registration and for updating credential types — re-registering
  an issuer preserves its key history.
- **A revoked key is never reinstated**, by rotation or re-registration.
- **Issuers registered before this feature** have no key history recorded.
  Their single key is accepted as before, and the first rotation back-fills a
  record for it inside its window rather than orphaning it.

---

## Deployment ordering

`ProofRegistry` now calls `IssuerRegistry::is_issuer_key_valid` instead of
`get_issuer_pubkey` when validating a proof. Deploy the new `IssuerRegistry`
**before** the new `ProofRegistry`; a `ProofRegistry` upgraded ahead of it will
fail every submission with a missing-function error.

This is a contract-interface change: re-record the reproducible WASM hashes in
[DEPLOYMENTS.md](../DEPLOYMENTS.md) after building, per
[REPRODUCIBLE_BUILDS.md](REPRODUCIBLE_BUILDS.md).

**Client bindings are unaffected today.** The frontend reads only
`get_issuer_pubkey`, whose semantics are unchanged — it still returns the
issuer's *current* key, so existing UIs, the indexer and the SDK keep working.
The generated bindings in `frontend/packages/issuer-registry/` will pick up
`rotate_issuer_key` / `revoke_issuer_key` / `get_issuer_keys` on the next
`scripts/gen-bindings.sh` run after deployment; they are generated from the
deployed contract, not from source, so they cannot be updated ahead of the
deploy.

**Cost re-measurement is required.** `is_issuer_key_valid` now runs on every
`ProofRegistry` submission and reads the issuer's key index plus one record per
tracked key, where the old path read a single `Issuer` struct. See the pending
rows in [BENCHMARKS.md](../BENCHMARKS.md).

---

## Pre-flight checklist

- [ ] Admin key is a multisig/HSM-backed account, not a hot wallet
- [ ] New keypair generated; private key already in the KMS/HSM
- [ ] Overlap window chosen and justified against the 90-day cap
- [ ] `get_issuer_keys` "before" state captured for the audit log
- [ ] Rotation executed and `iss_reg.key_rot` event observed
- [ ] `get_issuer_pubkey` returns the new key
- [ ] Issuing service switched to the new private key and rolled
- [ ] A testnet end-to-end proof under the retired key still submits during the window
- [ ] `iss_reg.key_rot` used to schedule the post-window check
- [ ] WASM hashes re-recorded in `DEPLOYMENTS.md`
- [ ] `is_issuer_key_valid` re-benchmarked on the submission hot path

Emergency path additionally:

- [ ] `revoke_issuer_key` executed and `is_issuer_key_valid` returns `false`
- [ ] Rotation to a fresh key completed so issuance can resume
- [ ] Cached `ProofRecord`s needing explicit `revoke_proof` identified
- [ ] Holder re-issuance communicated

---

## References

- [Events reference](EVENTS.md) — `iss_reg.key_rot`, `iss_reg.key_rev`
- [Security policy](../SECURITY.md) — pre-mainnet key-management checklist
- [Threat model](THREAT_MODEL.md)
- [Architecture](ARCHITECTURE.md) — trust-root overview
- [ProofRegistry errors](contract-error-codes.md)
- #69 — KMS/HSM integration (companion work)
- #544 — This feature
