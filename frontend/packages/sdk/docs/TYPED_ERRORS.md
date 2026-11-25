# Typed Error Taxonomy

The StellarCred SDK surfaces contract panics, RPC failures, and indexer issues as typed, actionable errors that applications can branch on programmatically.

## Overview

Every contract error code maps to the same human message across the stack (SDK, frontend, documentation), with the contract's `ProofRegistry` error enum as the single source of truth.

## Safe verification categories

`classifyVerificationError` normalizes SDK errors, contract panics, API responses, worker failures, and arbitrary thrown values into a `VerificationError`. Its `message` is selected from fixed safe text; raw exceptions and response bodies remain only in `cause` for diagnostics.

| Category                 | Meaning                                                                                 | Default retry behavior      |
| ------------------------ | --------------------------------------------------------------------------------------- | --------------------------- |
| `policy_rejection`       | The proof is absent, revoked, from an untrusted issuer, or below the required threshold | Do not retry unchanged      |
| `expired_proof`          | A locally evaluated proof has expired                                                   | Re-issue or re-prove        |
| `unsupported_credential` | The claim type, circuit version, or proof format is unsupported                         | Use a supported credential  |
| `network_error`          | RPC, indexer, HTTP 429/5xx, or transport failure                                        | Retry with backoff          |
| `invalid_input`          | Malformed address, threshold, credential, or request                                    | Correct the input           |
| `configuration_error`    | Required deployment configuration is missing                                            | Contact the app operator    |
| `authorization_error`    | Wallet signature, role, or challenge authorization failed                               | Reconnect or re-authorize   |
| `unknown`                | The failure cannot be safely classified                                                 | Inspect the diagnostic code |

Every normalized error carries the original stable `code`, `category`, `retryable`, optional `httpStatus`, and `cause`. `verificationErrorFromApi(status, body)` reads only structured diagnostic fields; it never displays the API's `error` text. UI and worker boundaries should display `message`, not `String(error)` or `error.message` from an unclassified exception.

Claim-status APIs additionally return `errorCategory` and `errorCode`, so callers can distinguish a policy rejection from an unavailable read without parsing prose.

## Error Classes

### ContractError

Thrown when a ProofRegistry transaction fails with a contract panic. Carries a numeric error code and human-friendly message.

```typescript
import { ContractError, ContractErrorCode } from "@stellarcred/sdk";

try {
  await submitProof(...);
} catch (err) {
  if (err instanceof ContractError) {
    console.log(err.code); // 4
    console.log(err.friendlyMessage); // "Issuer not trusted..."

    // Branch on specific error codes
    if (err.code === ContractErrorCode.IssuerNotTrusted) {
      // Show "issuer not registered" UI
    } else if (err.code === ContractErrorCode.VerificationFailed) {
      // Show "proof invalid" UI
    }

    // Use helper methods
    if (err.isRetryable()) {
      // Show retry button (e.g., SubmissionsPaused)
    } else if (err.isTerminal()) {
      // Show "requires action" UI (e.g., IssuerKeyMismatch)
    }
  }
}
```

### RpcError

Thrown when an RPC request to the Soroban network fails. May wrap a `ContractError` if the failure was due to a contract panic.

```typescript
import { RpcError } from "@stellarcred/sdk";

try {
  await hasClaim(wallet, "kyc");
} catch (err) {
  if (err instanceof RpcError) {
    if (err.isContractError()) {
      // Access the wrapped contract error
      const contractErr = err.contractError;
      console.log(contractErr.code);
    } else {
      // Network/timeout issue
      console.log(err.status); // HTTP status code
    }
  }
}
```

### IndexerError

Thrown when an indexer request fails or returns malformed data.

```typescript
import { IndexerError } from "@stellarcred/sdk";

try {
  await hasClaim(wallet, "kyc", { source: "indexer" });
} catch (err) {
  if (err instanceof IndexerError) {
    console.log(err.message);
    console.log(err.status); // HTTP status code if available
  }
}
```

## Contract Error Codes

All ProofRegistry error codes are exported as constants:

```typescript
import { ContractErrorCode } from "@stellarcred/sdk";

// Available codes:
ContractErrorCode.NotInitialized; // 1
ContractErrorCode.VerificationFailed; // 2
ContractErrorCode.NotAuthorized; // 3
ContractErrorCode.IssuerNotTrusted; // 4
ContractErrorCode.IssuerKeyMismatch; // 5
ContractErrorCode.ProofNotFound; // 6
ContractErrorCode.BatchTooLarge; // 7
ContractErrorCode.BatchEmpty; // 8
ContractErrorCode.DuplicateCredentialType; // 9
ContractErrorCode.AggregateLayoutInvalid; // 10
ContractErrorCode.SubmissionsPaused; // 11
ContractErrorCode.InvalidExpiry; // 12
ContractErrorCode.RoleNotHeld; // 13
ContractErrorCode.RoleHolderMismatch; // 14
ContractErrorCode.NoPendingAdmin; // 15
ContractErrorCode.NullifierAlreadyUsed; // 16
```

## Error Classification

### Retryable Errors

Errors that may succeed if retried later (transient failures):

- `SubmissionsPaused` (code 11) - Protocol admin has temporarily halted submissions

### Terminal Errors

Errors that require user action before retrying:

- `VerificationFailed` (code 2) - Invalid proof, must regenerate
- `IssuerNotTrusted` (code 4) - Issuer not registered, must use different issuer
- `IssuerKeyMismatch` (code 5) - Credential signed with wrong key, must re-issue
- `InvalidExpiry` (code 12) - Credential expiry invalid, must re-issue
- `NotInitialized` (code 1) - Contract misconfiguration

### User-Correctable Errors

Errors that the user can fix without re-issuing credentials:

- `NotAuthorized` (code 3) - Wrong wallet or missing signature
- `BatchTooLarge` (code 7) - Too many credentials in batch, reduce count
- `DuplicateCredentialType` (code 9) - Duplicate types in batch, remove one

## UI Integration Example

```typescript
import { ContractError, ContractErrorCode, classifyVerificationError } from "@stellarcred/sdk";

function handleSubmitError(err: unknown) {
  if (err instanceof ContractError) {
    // Show specific UI based on error type
    switch (err.code) {
      case ContractErrorCode.IssuerNotTrusted:
        return {
          title: "Issuer Not Registered",
          message: err.friendlyMessage,
          action: "contact_issuer",
          retryable: false,
        };

      case ContractErrorCode.VerificationFailed:
        return {
          title: "Proof Invalid",
          message: err.friendlyMessage,
          action: "regenerate_proof",
          retryable: false,
        };

      case ContractErrorCode.SubmissionsPaused:
        return {
          title: "Submissions Temporarily Paused",
          message: err.friendlyMessage,
          action: "retry",
          retryable: true,
        };

      case ContractErrorCode.BatchTooLarge:
        return {
          title: "Too Many Credentials",
          message: err.friendlyMessage,
          action: "reduce_batch",
          retryable: true,
        };

      default:
        return {
          title: "Transaction Failed",
          message: err.friendlyMessage,
          action: "unknown",
          retryable: false,
        };
    }
  }

  // Generic error handling: display only fixed safe text.
  const normalized = classifyVerificationError(err);
  return {
    title: "Error",
    message: normalized.message,
    action: "unknown",
    retryable: normalized.retryable,
  };
}
```

## Parsing Raw Errors

If you receive a raw error string from the RPC layer, use `parseContractError`:

```typescript
import { parseContractError } from "@stellarcred/sdk";

const rawError = "Error(Contract, #4)";
const parsed = parseContractError(rawError);

if (parsed) {
  console.log(parsed.code); // 4
  console.log(parsed.friendlyMessage); // "Issuer not trusted..."
}
```

## Error Messages

All error messages are maintained in `PROOF_REGISTRY_ERROR_MESSAGES`:

```typescript
import { PROOF_REGISTRY_ERROR_MESSAGES } from "@stellarcred/sdk";

console.log(PROOF_REGISTRY_ERROR_MESSAGES[4]);
// "Issuer not trusted — the issuer address isn't registered for this credential type."
```

## Single Source of Truth

The error table lives in `frontend/packages/sdk/src/errors.ts` and is imported by:

- Frontend (`lib/contract-errors.ts`)
- SDK (`src/errors.ts`)
- Documentation (this file)

This ensures error codes and messages stay in sync across the entire stack.

## Migration Guide

### Before (opaque strings)

```typescript
try {
  await submitProof(...);
} catch (err) {
  // Had to parse string messages
  if (String(err).includes("not trusted")) {
    // Show issuer error
  }
}
```

### After (typed errors)

```typescript
try {
  await submitProof(...);
} catch (err) {
  if (err instanceof ContractError) {
    if (err.code === ContractErrorCode.IssuerNotTrusted) {
      // Strongly typed, no string parsing
    }
  }
}
```
