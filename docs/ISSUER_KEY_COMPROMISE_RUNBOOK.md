# Issuer Master Key Compromise: Threat Model and Incident Runbook

This runbook covers what to do when an issuer's master signing key is
suspected or confirmed compromised. It maps each step to the contract entry
points that exist today (`issuer-registry`, `proof-registry`). For upgrade and
rollback of contract code itself see [MIGRATION_RUNBOOK.md](../MIGRATION_RUNBOOK.md).

## 1. Threat model

| Asset | What an attacker with the key can do | Impact |
| --- | --- | --- |
| Issuer master key (signs credentials, authorises `submit_proof` as issuer) | Mint credentials for arbitrary holders; submit proofs under the issuer's `issuer_id` | Forged credentials accepted by verifiers that trust the issuer |
| Issuer registry entry (`register_issuer`, `get_issuer_pubkey`) | Nothing alone; the entry is only changed by the registry admin | Entry keeps advertising the compromised pubkey until revoked |
| Registry admin key (`admin`, `set_admin`) | Revoke or register any issuer, upgrade contracts | Out of scope for the issuer key, but if it is also exposed, rotate it first via `set_admin` |

Key facts that shape the response:

- `revoke_issuer` is admin-only and marks the issuer as revoked.
  `is_valid_issuer` then returns `false`, but **existing proofs are not
  affected automatically**. Each proof must be revoked explicitly.
- `revoke_proof` / `revoke` operate per `(holder, credential_type)`. There is
  no single "revoke everything by issuer" call, so affected holders must be
  enumerated from the indexer.
- Verifiers that pass `trusted_issuers` to `is_verified` / `check_claim`
  can exclude an issuer immediately, without waiting for on-chain revocation.

## 2. Roles

- **Incident commander**: owns the timeline and decisions.
- **Registry admin**: holds the admin key and executes on-chain calls.
- **Issuer operator**: generates the replacement key and re-issues credentials.
- **Communications**: notifies integrators, holders and the public.

## 3. Response procedure

### Phase 0: Triage (target: within 15 minutes)

1. Open an incident and record the time of detection and the suspected
   compromise window (earliest time the key may have been exposed).
2. Freeze the old key: stop all issuance services using it and remove it from
   signing infrastructure. Do not delete it; keep it for forensics.
3. Confirm the registry admin key is not also compromised. If it is, run
   `set_admin` to a fresh key first.

### Phase 1: Contain (target: within 1 hour)

1. Revoke the issuer in the registry (admin only):
   `revoke_issuer({ issuer_id })`.
2. Verify: `is_valid_issuer({ issuer_id, credential_type })` returns `false`
   for every credential type the issuer held.
3. Tell integrators to pass an explicit `trusted_issuers` list that excludes
   the compromised `issuer_id` until step 4 completes.

### Phase 2: Revoke affected credentials

1. Using the indexer, list every proof whose `issuer_id` matches and whose
   issuance time falls inside the compromise window. Export as a list of
   `(holder, credential_type)` pairs and keep it with the incident record.
2. When in doubt, include the whole issuer, not only the window; wrongly
   revoked credentials can be re-issued, forged ones cannot be recalled later.
3. For each pair call `revoke_proof({ holder, credential_type })` (or
   `revoke({ issuer, holder, credential_type })` when acting as the issuer
   with the replacement key). Process in batches and persist progress so a
   failed run can resume; revocation is idempotent in effect, so re-running a
   batch is safe.
4. Verify with `get_record` / `is_verified` on a sample plus every
   high-value holder.

### Phase 3: Rotate to a clean key

1. Generate the new key on clean infrastructure (HSM or offline where
   possible). Never reuse the old key material or derive from it.
2. Register the replacement under a **new** `issuer_id`:
   `register_issuer({ issuer_id, pubkey, credential_types })`. A fresh id keeps
   the revoked id permanently distinguishable in audit trails.
3. Publish branding for the new id with `set_issuer_metadata` and note the
   relationship to the old id in the incident record.
4. Confirm `get_issuer_pubkey` returns the new key and `is_valid_issuer`
   returns `true` for the new id.

### Phase 4: Notify the registry ecosystem

1. Notify within the same hour as containment: integrators, verifiers and
   the indexer/webhook subscribers. Include the revoked `issuer_id`, the
   compromise window, the replacement `issuer_id`, and the time `revoke_issuer`
   was executed.
2. Indexer webhook consumers will see issuer and proof revocation events;
   confirm delivery and that downstream caches have invalidated.
3. Do not include key material, internal hostnames or holder PII in public
   notices.

### Phase 5: Batch re-issuance

1. Re-verify each holder's eligibility from the source of truth. Never
   re-issue automatically from the exported revoked list alone, because the
   attacker may have inserted entries.
2. Issue under the new `issuer_id` in batches using `submit_proofs_batch`
   (per holder) or `submit_proof`. Use a rate limit that respects ledger
   limits and keep a checkpoint after every batch.
3. Prioritise by holder impact, and notify holders as their credentials
   become valid again.
4. After each batch, verify with `is_verified` using
   `trusted_issuers = [new_issuer_id]`.

### Phase 6: Close out

1. Confirm zero valid proofs remain under the old `issuer_id`.
2. Run a post-incident review within 5 business days: root cause, detection
   gap, time to contain, time to full re-issuance.
3. Update key storage, access controls and monitoring to address the root
   cause; add action items with owners.

## 4. Checklist

- [ ] Old key frozen, forensics copy kept
- [ ] Admin key confirmed safe (or rotated with `set_admin`)
- [ ] `revoke_issuer` executed and `is_valid_issuer` is `false`
- [ ] Integrators told to use `trusted_issuers`
- [ ] Affected `(holder, credential_type)` list exported from the indexer
- [ ] All affected proofs revoked and sampled
- [ ] New key generated clean and registered under a new `issuer_id`
- [ ] Ecosystem notification sent
- [ ] Re-issuance completed in batches with checkpoints
- [ ] Post-incident review scheduled

## 5. Rehearsal

Run this procedure on testnet at least twice a year with a throwaway issuer:
register, issue proofs, revoke the issuer, revoke the proofs, rotate and
re-issue. Record the elapsed time of each phase and fix any step that was
unclear.
