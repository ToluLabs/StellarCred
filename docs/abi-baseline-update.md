# Contract ABI Baseline Update Procedure

This document outlines the policy, classification, and workflow for updating the checked-in public ABI baselines for StellarCred Soroban smart contracts.

---

## 1. Background & Purpose

StellarCred smart contracts define the trust root and verification boundary of the zero-knowledge credential layer. The public Application Binary Interface (ABI)—encoded in the WebAssembly contract specification (`contractspecv0`) custom section—governs how external callers, the `@stellarcred/sdk`, client frontends, and on-chain integrations interact with our contracts.

Unintended breaking changes to public contract entrypoints or data types can cause catastrophic transaction failures, SDK desynchronization, and broken smart contract integrations.

To prevent silent breakage, CI enforces that the public ABI of each release-bound contract matches its checked-in baseline file:
* [`contracts/credential_verifier/abi.json`](file:///contracts/credential_verifier/abi.json)
* [`contracts/gated_pool/abi.json`](file:///contracts/gated_pool/abi.json)
* [`contracts/issuer_registry/abi.json`](file:///contracts/issuer_registry/abi.json)
* [`contracts/proof_registry/abi.json`](file:///contracts/proof_registry/abi.json)

---

## 2. Classification of ABI Changes

### Breaking Changes (Must Be Justified & Reviewed)

The following changes alter the contract interface and break existing clients, scripts, or callers:

1. **Removed Public Function:** Removing an existing contract method (e.g., removing `submit_proof` or `get_claim`).
2. **Changed Function Parameter Count or Order:** Adding, removing, or reordering parameters in an existing function.
3. **Changed Function Parameter Type:** Modifying any parameter type (e.g., `u64` $\to$ `u32`, `address` $\to$ `symbol`, or wrapping an argument in an `Option`).
4. **Changed Return Type:** Modifying a function's return type (e.g., changing return from `bool` to `Result<bool, Error>`).
5. **Removed or Altered Struct Fields:** Removing a field, renaming a field, or changing the data type of a field in a user-defined type (UDT) struct.
6. **Removed or Altered Error Codes / Enum Cases:** Deleting an error enum case or renumbering error discriminants (e.g., changing `Error::NotInitialized` from `1` to `2`).
7. **Removed or Altered Events:** Removing an event topic or altering the payload schema emitted by the contract.

### Non-Breaking Changes

The following changes do not alter existing compatibility:

1. **Adding a New Public Function:** Introducing a new entrypoint with a distinct name.
2. **Adding a New Event:** Emitting an additional event that does not disrupt existing topics.
3. **Adding a New UDT Struct / Enum:** Introducing a new type used solely by new functions.
4. **Internal Code Refactors:** Algorithmic changes, internal helper functions, performance optimizations, or comments that do not alter the compiled public specification.

> [!IMPORTANT]
> Even non-breaking additions will cause CI to flag an ABI difference until the checked-in baseline is regenerated and committed. This ensures all interface additions are conscious and visible in pull request diffs.

---

## 3. Step-by-Step Baseline Update Procedure

When a contract change intentionally modifies the public interface:

### Step 1: Regenerate ABI Baselines
Run the export script from the repository root:

```bash
bash scripts/export-contract-abi.sh
```
*(Or cross-platform via Node.js: `node scripts/export-contract-abi.mjs`)*

This compiles all release-bound contracts to `wasm32v1-none` in release mode, inspects the contract specifications via the Stellar CLI (`stellar contract info interface`), and formats the updated output in each contract's `abi.json`.

### Step 2: Review the Diff
Inspect the exact diff of the generated baselines:

```bash
git diff contracts/*/abi.json
```

Verify that only the intended function or type modifications are present.

### Step 3: Run the Verification Script Locally
Confirm that the ABI check passes against the new baselines:

```bash
bash scripts/check-contract-abi.sh
```

The script must report:
```text
✓ PASS: Contract 'credential_verifier' public ABI matches checked-in baseline.
✓ PASS: Contract 'gated_pool' public ABI matches checked-in baseline.
✓ PASS: Contract 'issuer_registry' public ABI matches checked-in baseline.
✓ PASS: Contract 'proof_registry' public ABI matches checked-in baseline.
```

### Step 4: Update Downstream Consumers
If public interfaces were modified:
1. Re-generate TypeScript bindings if applicable: `bash scripts/gen-bindings.sh`.
2. Update documentation in [`docs/PROOF_REGISTRY_API.md`](file:///docs/PROOF_REGISTRY_API.md) and [`docs/EVENTS.md`](file:///docs/EVENTS.md).
3. Update the SDK in `frontend/packages/sdk` and corresponding integration tests.

### Step 5: Commit the Updated Baseline
Commit the updated `contracts/<name>/abi.json` files alongside your contract source changes:

```bash
git add contracts/
git commit -m "feat(contracts): update ABI baseline for <contract-name>"
```

---

## 4. Review & Approval Requirements

As specified in [`.github/CODEOWNERS`](file:///.github/CODEOWNERS):
* The `/contracts/` path represents the system's trust anchor and is maintained by:
  * `@nonchalanttee22-lgtm`
  * `@Psalmuel01`

Any PR that touches `contracts/*/abi.json` requires:
1. **Explicit Maintainer Approval:** At least one designated code owner must review and approve the baseline diff.
2. **Breaking Change Justification:** The PR description must explicitly document why the breaking change is required, along with a migration path or deprecation plan for existing deployed contracts, client SDKs, and indexer consumers.
3. **Green CI Status:** The `Contract ABI baseline check` workflow must pass on both the PR branch and the merge target.
