# ProofRegistry Contract Error Codes

Complete reference for the `ProofRegistry` Error enum and its client-side mappings.

## Error Mapping

| Code | Variant | Client Message |
|------|---------|----------------|
| 1 | AlreadyInitialized | Contract already initialized. |
| 2 | NotInitialized | Contract not initialized. |
| 3 | Unauthorized | Not authorised — wallet signature missing or wrong account. |
| 4 | IssuerNotTrusted | Issuer not trusted — the issuer address isn't registered for this credential type. |
| 5 | IssuerKeyMismatch | Issuer key mismatch — this credential was signed with a key that isn't currently accepted for this issuer: it was revoked, its rotation window has closed, or it was never registered. Re-issue against the issuer's current key (see [IssuerKey Rotation](ISSUER_KEY_ROTATION.md)). |
| 6 | ProofNotFound | Proof not found — no proof exists for this credential type yet. |
| 7 | BatchTooLarge | Batch too large — maximum batch size exceeded. Submit fewer proofs at once. |
| 8 | BatchEmpty | Batch empty — submit at least one proof in the batch. |
| 9 | DuplicateCredentialType | Duplicate credential type — the batch contains two proofs for the same claim type. |
| 10 | AggregateLayoutInvalid | Aggregate proof layout invalid — the number of credentials or public inputs don't match the circuit. |
| 11 | SubmissionsPaused | Submissions paused — the protocol admin has temporarily halted new proof submissions. |
| 12 | InvalidExpiry | Invalid expiry — the credential expiry is either in the past or too far in the future. |

## IssuerRegistry Error Mapping

| Code | Variant | Client Message |
|------|---------|----------------|
| 1 | NotInitialized | Contract not initialized. |
| 2 | IssuerNotFound | Issuer not found — no such issuer is registered. |
| 3 | MetadataTooLong | Metadata too long — exceeds the per-field length cap. |
| 4 | KeyNotFound | Key not found — that signing key is not registered for this issuer. |
| 5 | TooManyKeys | Too many keys — this issuer already tracks the maximum of 4 signing keys. |
| 6 | InvalidOverlap | Invalid overlap — the rotation window is zero. Use key revocation to retire a key immediately. |
| 7 | OverlapTooLong | Overlap too long — the rotation window exceeds the 90-day maximum. |
| 8 | RotationNoop | Rotation is a no-op — the key is already current, or `register_issuer` was used in place of `rotate_issuer_key`. |
| 9 | KeyRevoked | Key revoked — that key was revoked and can never be reinstated. Rotate to a new key instead. |

Codes 4–9 are only produced by the issuer key management calls
(`rotate_issuer_key`, `revoke_issuer_key`, `register_issuer`). See
[IssuerKey Rotation](ISSUER_KEY_ROTATION.md).

## Source

- Contract enum: `contracts/proof_registry/src/lib.rs`
- Client map: `frontend/lib/contracts.ts`
- Guard test: `frontend/lib/contracts.test.ts`