# ProofRegistry Contract Error Codes

Complete reference for the `ProofRegistry` Error enum and its client-side mappings.

> Per-entrypoint panic behaviour is documented in [PROOF_REGISTRY_API.md](PROOF_REGISTRY_API.md).

## Error Mapping

| Code | Variant | Client Message |
|------|---------|----------------|
| 1 | NotInitialized | Contract not initialized — a required admin, verifier, or issuer registry entry is missing. |
| 2 | VerificationFailed | Verification failed — the ZK proof is invalid or was generated against the wrong circuit VK. |
| 3 | NotAuthorized | Not authorised — wallet signature missing or wrong account. |
| 4 | IssuerNotTrusted | Issuer not trusted — the issuer address isn't registered for this credential type. |
| 5 | IssuerKeyMismatch | Issuer key mismatch — this credential was signed with a key that doesn't match what's registered on-chain. Re-issue the credential and try again. |
| 6 | ProofNotFound | Proof not found — no proof exists for this credential type yet. |
| 7 | BatchTooLarge | Batch too large — maximum batch size exceeded. Submit fewer proofs at once. |
| 8 | BatchEmpty | Batch empty — submit at least one proof in the batch. |
| 9 | DuplicateCredentialType | Duplicate credential type — the batch contains two proofs for the same claim type. |
| 10 | AggregateLayoutInvalid | Aggregate proof layout invalid — the number of credentials or public inputs don't match the circuit. |
| 11 | SubmissionsPaused | Submissions paused — the protocol admin has temporarily halted new proof submissions. |
| 12 | InvalidExpiry | Invalid expiry — the credential expiry is either in the past or too far in the future. |
| 13 | RoleNotHeld | Role not held — the required role has no holder, or the caller is not the holder. |
| 14 | RoleHolderMismatch | Role holder mismatch — `revoke_role` named an address that is not the current holder of the role. |
| 15 | NoPendingAdmin | No pending admin — `accept_admin` was called without a pending `propose_admin` proposal. |

## Source

- Contract enum: `contracts/proof_registry/src/lib.rs`
- Client map: `frontend/lib/contracts.ts`
- Guard test: `frontend/lib/contracts.test.ts`

---

# IssuerRegistry Contract Error Codes

## Error Mapping

| Code | Variant | Client Message |
|------|---------|----------------|
| 1 | NotInitialized | Contract not initialized — no admin has been set. |
| 2 | IssuerNotFound | Issuer not found — this address is not registered. |
| 3 | MetadataTooLong | Issuer metadata too long — a name, URL, or logo field exceeds its length cap. |
| 4 | RoleNotHeld | Role not held — the required role has no holder, or the caller is not the holder. |
| 5 | RoleHolderMismatch | Role holder mismatch — `revoke_role` named an address that is not the current holder. |
| 6 | KeyNotFound | Key not found — the key is unknown to this issuer, or its validity window has already closed, so there is nothing to revoke. |
| 7 | KeyAlreadyRevoked | Key already revoked — the emergency revocation has already been applied. |
| 8 | KeyAlreadyRetired | Key already retired — the key is still in the issuer's key set; re-installing it would revive credentials signed with it. Rotate to a new key instead. |
| 9 | KeyHistoryFull | Key history full — eight retired keys are still inside their validity windows. Wait for one to expire, or revoke keys that are no longer needed. |
| 10 | InvalidKeyWindow | Invalid validity window — the window is already closed, or longer than the 366-day maximum. |
| 11 | KeyAlreadyCurrent | Key already current — the key passed to `rotate_issuer_key` is already the issuer's signing key. |
| 12 | KeyChangeRequiresRotation | Key change requires rotation — `register_issuer` cannot change an existing issuer's public key. Use `rotate_issuer_key` so outstanding credentials keep verifying. |

## Source

- Contract enum: `contracts/issuer_registry/src/lib.rs`
- Operational procedure: [ISSUER_KEY_ROTATION.md](ISSUER_KEY_ROTATION.md)