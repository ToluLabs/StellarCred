# ProofRegistry Contract Error Codes

Complete reference for the `ProofRegistry` Error enum and its client-side mappings.

## Error Mapping

| Code | Variant | Client Message |
|------|---------|----------------|
| 1 | AlreadyInitialized | Contract already initialized. |
| 2 | NotInitialized | Contract not initialized. |
| 3 | Unauthorized | Not authorised — wallet signature missing or wrong account. |
| 4 | IssuerNotTrusted | Issuer not trusted — the issuer address isn't registered for this credential type. |
| 5 | IssuerKeyMismatch | Issuer key mismatch — this credential was signed with a key that doesn't match what's registered on-chain. Re-issue the credential and try again. |
| 6 | ProofNotFound | Proof not found — no proof exists for this credential type yet. |
| 7 | BatchTooLarge | Batch too large — maximum batch size exceeded. Submit fewer proofs at once. |
| 8 | BatchEmpty | Batch empty — submit at least one proof in the batch. |
| 9 | DuplicateCredentialType | Duplicate credential type — the batch contains two proofs for the same claim type. |
| 10 | AggregateLayoutInvalid | Aggregate proof layout invalid — the number of credentials or public inputs don't match the circuit. |
| 11 | SubmissionsPaused | Submissions paused — the protocol admin has temporarily halted new proof submissions. |
| 12 | InvalidExpiry | Invalid expiry — the credential expiry is either in the past or too far in the future. |

## HumanAirdrop Error Mapping

Reference for the `HumanAirdrop` (`contracts/human_airdrop`) Error enum — the
verified-human-once distribution pattern, see [ANTI_SYBIL.md](ANTI_SYBIL.md).

| Code | Variant | Client Message |
|------|---------|----------------|
| 1 | NotInitialized | Contract not initialized. |
| 2 | CampaignExists | A campaign with this id already exists. |
| 3 | CampaignNotFound | No such campaign. |
| 4 | CampaignInactive | This campaign is paused. |
| 5 | CampaignNotStarted | This campaign has not started yet. |
| 6 | CampaignEnded | This campaign has ended. |
| 7 | NotVerifiedHuman | No valid credential — get verified first (missing, expired, revoked, below threshold, or untrusted issuer). |
| 8 | AlreadyClaimed | This human has already claimed in this campaign — the campaign-scoped nullifier is already spent. |
| 9 | BudgetExhausted | This campaign has run out of allocation (budget or claim cap). |
| 10 | InvalidAmount | Invalid amount — must be positive, and the budget must cover at least one payout. |
| 11 | InvalidWindow | Invalid claim window — `end` must be after `start` (or 0 for "no end"). |
| 12 | InvalidScope | Invalid app scope — must be 1–64 bytes. |
| 13 | InsufficientBalance | Insufficient claimed balance for this withdrawal. |

## Source

- Contract enum: `contracts/proof_registry/src/lib.rs`, `contracts/human_airdrop/src/lib.rs`
- Client map: `frontend/lib/contracts.ts`
- Guard test: `frontend/lib/contracts.test.ts`