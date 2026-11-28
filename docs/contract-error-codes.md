# StellarCred Smart Contract Error Codes

This document defines the canonical error taxonomy, error codes, and operational retry guidance for StellarCred smart contracts on Soroban.

Machine-readable definitions are maintained in `contracts/error-codes.json` and validated against contract source code and client SDKs in CI via `scripts/verify-contract-errors.mjs`.

## Error Taxonomy

StellarCred classifies on-chain contract errors into five categories:

1. **Configuration**: The contract instance is missing required dependencies, addresses, or initialization parameters.
2. **Validation**: Input parameters, zero-knowledge proofs, or submitted claim records failed integrity or validity checks.
3. **Authorization**: The calling identity is missing required permissions, signatures, or access roles.
4. **Operational**: The contract is in a temporary state (such as paused submissions) or resources are insufficient.
5. **Lifecycle**: Administrative state transitions (such as role grants, two-step admin transfers, or version deprecations).

### Retry Guidance Overview

- **Retryable (`true`)**: The failure is transient or depends on temporary state. Callers can safely retry after a backoff period or after adjusting batch size or waiting for an unpause.
- **Terminal (`false`)**: The failure indicates invalid inputs, bad proofs, or missing permissions. Retrying with identical parameters will always fail; client or user action is required before re-submitting.

---

## ProofRegistry

Contract ID Env: `NEXT_PUBLIC_PROOF_REGISTRY_ID`

| Code | Name | Category | Retryable | Description | Retry Guidance |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | NotInitialized | configuration | No | Contracts not initialised - required contract addresses or admin state are unset. | Deploy and initialise the contract before invoking functions. |
| 2 | VerificationFailed | validation | No | Proof verification failed - the ZK proof is invalid or was generated against the wrong circuit VK. | Do not retry with the same proof. Regenerate the ZK proof using matching circuit verification keys. |
| 3 | NotAuthorized | authorization | No | Not authorised - wallet signature missing or wrong account. | Check that the calling wallet matches the required identity and provide valid authorization. |
| 4 | IssuerNotTrusted | authorization | No | Issuer not trusted - the issuer address is not registered for this credential type. | Verify the credential issuer against the IssuerRegistry before submitting. |
| 5 | IssuerKeyMismatch | validation | No | Issuer key mismatch - this credential was signed with a key that does not match what is registered on-chain. | Re-issue the credential with the current registered issuer signing key and try again. |
| 6 | ProofNotFound | validation | No | Proof not found - no on-chain proof exists for this holder and credential type. | Submit a valid proof before attempting to query or consume the claim. |
| 7 | BatchTooLarge | validation | Yes | Batch too large - the submission exceeds the maximum batch limit. | Reduce the batch size and submit in smaller chunks. |
| 8 | BatchEmpty | validation | No | Batch is empty - at least one proof submission is required. | Include one or more proof submissions in the batch. |
| 9 | DuplicateCredentialType | validation | No | Duplicate credential type - the batch contains multiple proofs for the same claim type. | Deduplicate submissions in the batch so each credential type appears at most once. |
| 10 | AggregateLayoutInvalid | validation | No | Aggregate proof layout invalid - the number of credentials or public inputs do not match expected format. | Re-generate the aggregate proof with the canonical public input ordering. |
| 11 | SubmissionsPaused | operational | Yes | Submissions paused - protocol admin has temporarily halted new proof submissions. | Transient state. Wait for the pauser or admin to resume submissions before retrying. |
| 12 | InvalidExpiry | validation | No | Invalid expiry - the credential expiry is either in the past or exceeds the maximum allowable future window. | Re-issue the credential with a valid expiry timestamp. |
| 13 | RoleNotHeld | authorization | No | The caller does not hold the role required by this function. | Grant the necessary role or execute from an authorized address. |
| 14 | RoleHolderMismatch | authorization | No | revoke_role named an address that is not the current holder of the role. | Verify current role assignment before revoking. |
| 15 | NoPendingAdmin | lifecycle | No | accept_admin called with no active proposal. | Admin must call propose_admin prior to accept_admin. |
| 16 | NullifierAlreadyUsed | validation | No | The nullifier has already been consumed in this application context. | Terminal error. Credentials cannot be reused for nullifier-gated actions. |

---

## IssuerRegistry

Contract ID Env: `NEXT_PUBLIC_ISSUER_REGISTRY_ID`

| Code | Name | Category | Retryable | Description | Retry Guidance |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | NotInitialized | configuration | No | IssuerRegistry has not been initialized with admin state. | Run contract constructor and initialize state before usage. |
| 2 | IssuerNotFound | validation | No | The specified issuer address is not registered in the system. | Register the issuer address via admin before querying or updating. |
| 3 | MetadataTooLong | validation | No | Issuer metadata string exceeds maximum permitted length. | Shorten name, url, or logo metadata payloads within the maximum byte limit. |
| 4 | RoleNotHeld | authorization | No | Caller does not hold the required administrative role for this operation. | Execute the transaction with an address holding the required role. |
| 5 | RoleHolderMismatch | authorization | No | revoke_role address does not match the active holder. | Confirm the current assigned role holder address before revoking. |
| 6 | KeyNotFound | validation | No | The public key is not part of this issuer live key set. | Verify the key was previously registered and that its validity window has not closed. |
| 7 | KeyAlreadyRevoked | lifecycle | No | The key was already emergency-revoked. | No action needed; the key is already inactive. |
| 8 | KeyAlreadyRetired | lifecycle | No | rotate_issuer_key attempted to install a key that is already retired. | Provide a fresh, previously unused secp256k1 public key for rotation. |
| 9 | KeyHistoryFull | operational | Yes | Issuer retains maximum number of retired keys inside active validity windows. | Wait for older retired keys to pass their validity window before rotating again. |
| 10 | InvalidKeyWindow | validation | No | Requested key validity window is zero or exceeds maximum retention limit. | Specify a validity window between 1 second and MAX_KEY_RETENTION_SECS. |
| 11 | KeyAlreadyCurrent | lifecycle | No | rotate_issuer_key was asked to install the key that is already active. | Provide a new public key distinct from the current key. |
| 12 | KeyChangeRequiresRotation | lifecycle | No | register_issuer attempted to change the pubkey of an existing issuer. | Use rotate_issuer_key so existing credentials remain verifiable within their validity window. |
| 13 | NoPendingAdmin | lifecycle | No | accept_admin was called with no pending admin proposal. | Admin must call propose_admin before accept_admin can succeed. |

---

## CredentialVerifier

Contract ID Env: `NEXT_PUBLIC_VERIFIER_ID`

| Code | Name | Category | Retryable | Description | Retry Guidance |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | NotInitialized | configuration | No | CredentialVerifier is uninitialized. | Initialize the verifier contract with admin address. |
| 2 | VkNotSet | validation | No | No verification key is registered for the specified credential type and version. | Register the circuit verification key before submitting proofs. |
| 3 | VkInvalid | validation | No | The verification key bytes are malformed or fail integrity checks. | Re-extract verification key from compiled circuit artifacts and re-register. |
| 4 | VersionDeprecated | lifecycle | No | The requested VK version has been deprecated by admin. | Upgrade to the latest circuit version and submit proofs against the current VK. |
| 5 | VkAlreadySet | lifecycle | No | A verification key is already registered at the requested version. VKs are immutable. | Increment the version number and register as a new version. |
| 6 | VkStillReferenceable | lifecycle | No | VK version cannot be purged while still referenceable by valid cached proofs. | Wait until all cached proofs referencing this version have expired. |
| 7 | RoleNotHeld | authorization | No | Caller does not hold the required role for this verifier function. | Invoke with an address granted the required role. |
| 8 | RoleHolderMismatch | authorization | No | revoke_role target address is not the current holder. | Verify current role holder before attempting revocation. |
| 9 | NoPendingAdmin | lifecycle | No | accept_admin called without an active proposal. | Admin must call propose_admin prior to accept_admin. |

---

## GatedPool

Contract ID Env: `NEXT_PUBLIC_GATED_POOL_ID`

| Code | Name | Category | Retryable | Description | Retry Guidance |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | NotInitialized | configuration | No | GatedPool contract is not initialized. | Call constructor to set registry and required claim types. |
| 2 | NotKycVerified | validation | No | Caller does not possess a valid verified claim in ProofRegistry. | Complete credential verification and submit proof to ProofRegistry before joining the pool. |
| 3 | InvalidAmount | validation | No | Deposit or withdrawal amount must be greater than zero. | Specify a positive non-zero token amount. |
| 4 | InsufficientBalance | operational | No | Withdrawal amount exceeds caller deposited balance. | Request an amount less than or equal to current deposited balance. |

---

## Compatibility and Deprecation Guarantees

1. **Append-Only Numbering**: Once assigned to an error condition, a numeric code is immutable. New error variants are appended with monotonically increasing integer discriminants.
2. **No Discriminant Re-use**: If an error condition becomes obsolete, its numeric code is retired rather than reassigned to a different meaning.
3. **Machine Verification**: Any change to `contracts/error-codes.json` must be reflected across Rust contract enums, client packages, and SDK message tables. The continuous integration check `scripts/verify-contract-errors.mjs` enforces synchronization on every pull request.
