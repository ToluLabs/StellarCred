# StellarCred Circuits — Constraint Audit

> Noir **1.0.0-beta.9** · Barretenberg (UltraHonk) **v0.87.0** · `nargo info` run 2026-07-25
>
> Companion to [`circuits/README.md`](README.md), which documents the circuit
> reference (commitment scheme, cryptographic conventions, test vectors, and
> public input ABI layouts).

## Overview

In-browser proving time is dominated by circuit constraint count (backend gate count,
not just ACIR opcodes). This audit establishes a **baseline measurement** of every
circuit's ACIR opcode count and provides a constraint-breakdown analysis so future
PRs can measure regression or improvement.

All circuits share a common skeleton: **Poseidon2 commitment hash** → **secp256k1 ECDSA
signature verification** → **type-specific threshold or membership check**.

## Audit Table

| Circuit                | Total ACIR Opcodes | ECDSA         | Poseidon2     | Field→Bytes + Commitment | Threshold / Logic | Notes |
|------------------------|--------------------|----------------|----------------|--------------------------|-------------------|-------|
| `commit`               | 4                  | —              | 4 (100%)       | —                        | —                 | Witness-only helper; never proven. |
| `kyc_proof`            | 582                | 1 blackbox¹    | 4              | ~577                      | —                 | Baseline proof circuit — no threshold. |
| `income_proof`         | 588                | 1 blackbox¹    | 4              | ~577                      | ~6 (≥ comparison) | +6 opcodes vs kyc for `income ≥ threshold`. |
| `funds_proof`          | 588                | 1 blackbox¹    | 4              | ~577                      | ~6 (≥ comparison) | Identical profile to income_proof. |
| `accreditation_proof`  | 588                | 1 blackbox¹    | 4              | ~577                      | ~6 (≥ comparison) | Identical profile to income_proof. |
| `age_proof`            | 601                | 1 blackbox¹    | 4              | ~577                      | ~19 (sub, div, ≥) | +19 vs kyc; division by 365 is the delta. |
| `jurisdiction_proof`   | 607                | 1 blackbox¹    | 4              | ~577                      | ~25 (8 × ≠ loop) | +25 vs kyc; unrolled loop over 8 entries. |

> ¹ ECDSA secp256k1 verification uses a single ACIR blackbox opcode (`EcdsaSecp256k1`),
> but expands to an estimated ~30,000 backend gates in Barretenberg (rough
> order-of-magnitude; not yet profiled with `bb`). This is why proving time is
> dominated by ECDSA across all circuits despite it appearing as "1 opcode" in the
> ACIR count.

Each row's column breakdown adds up to its stated total:

| Circuit              | 1 (ECDSA) + 4 (Poseidon2) + ~577 (field→bytes) + threshold | Total |
|----------------------|-------------------------------------------------------------|-------|
| `kyc_proof`          | 1 + 4 + ~577 + 0                                           | 582   |
| `income_proof`       | 1 + 4 + ~577 + ~6                                          | 588   |
| `funds_proof`        | 1 + 4 + ~577 + ~6                                          | 588   |
| `accreditation_proof`| 1 + 4 + ~577 + ~6                                          | 588   |
| `age_proof`          | 1 + 4 + ~577 + ~19                                         | 601   |
| `jurisdiction_proof` | 1 + 4 + ~577 + ~25                                         | 607   |

### What drives the ~577 non-ECDSA, non-Poseidon2 opcodes?

The constrained `to_be_bytes()` decomposition of the field element into 32 bytes
generates the bulk of the remaining opcodes. Each of the 32 output bytes requires
a range check (`0 ≤ byte ≤ 255`), and each range check decomposes into bit-level
constraints in ACIR.

> **Note:** The `nargo info --json` output also lists "Unconstrained functions"
> (`directive_to_radix`: 17, `directive_invert`: 9, `directive_integer_quotient`: 8).
> These are **witness-only hints** that do NOT contribute to the constraint count —
> they are listed separately because they run outside the constraint system. The
> constraint count comes entirely from the constrained range checks and field
> arithmetic emitted by `to_be_bytes()` and related operations.

## Constraint Contributor Analysis

### 1. ECDSA secp256k1 Verification (dominant cost)

**ACIR:** 1 blackbox opcode  
**Backend:** ~30,000 UltraHonk gates (est.)

Every credential circuit uses `std::ecdsa_secp256k1::verify_signature` to prove
the issuer signed the commitment. This is **expected** — the ECDSA check is the
root of trust that binds a credential to a registered issuer. It is the single
largest contributor to proving time and **cannot be removed without replacing
the entire trust model**.

**ACIR visibility:** Because ECDSA is a blackbox function, it contributes only
1 opcode to the ACIR count, making the ACIR numbers look deceptively low. All
constraint-count differences between circuits come from the **non-ECDSA** logic.

### 2. Poseidon2 Commitment Hash (negligible)

**ACIR:** 4 opcodes  
**Backend:** ~200 gates (estimate)

The commitment hash `Poseidon2::hash([value, salt], 2)` is consistent across all
circuits and contributes negligible cost. This is the most efficient zk-friendly
hash available in Noir 1.0.0-beta.9. **No optimization needed.**

### 3. Field → Bytes Conversion (~577 ACIR opcodes)

**ACIR:** ~570–580 opcodes  
**Backend:** ~3,000 gates (estimate, range checks for 32 bytes)

`commitment.to_be_bytes()` is required to pass the 32-byte message to ECDSA
verification. Each byte needs a range check. This is the **second-largest ACIR
contributor** but still small relative to ECDSA backend cost.

**Potential optimization:** If the ECDSA blackbox could accept a field element
directly (instead of bytes), these ~577 opcodes would be eliminated. This
requires a Noir stdlib or Barretenberg change — track upstream.

### 4. Type-Specific Logic (0–25 ACIR opcodes)

These are negligible in the overall constraint budget:

| Circuit | Extra Opcodes | Operations | Cost per op |
|---------|---------------|------------|-------------|
| `kyc_proof` | 0 (baseline) | None | — |
| `income_proof` | +6 | `income ≥ threshold` (u64) | ~6 |
| `funds_proof` | +6 | `balance ≥ threshold` (u64) | ~6 |
| `accreditation_proof` | +6 | `net_worth ≥ threshold` (u64) | ~6 |
| `age_proof` | +19 | subtract, divide by 365, compare | ~7/7/5 |
| `jurisdiction_proof` | +25 | 8 × `country_code ≠ restricted[i]` | ~3 |

## Per-Circuit Analysis & Optimization Suggestions

### `commit` — 4 opcodes

**Purpose:** Witness-only helper for deriving credential commitments. Never proven.

**Finding:** Trivial — 4 Poseidon2 opcodes. No optimization needed.

### `kyc_proof` — 582 opcodes

**Purpose:** Proves knowledge of a KYC secret bound to an issuer-signed commitment.

**Structure:** Poseidon2 → to_be_bytes → ECDSA. No threshold logic.

**Finding:** Minimal, well-structured baseline. The 582 is essentially the fixed
cost of any credential proof.

**Optimization suggestion:** None needed at the circuit level. This is the lower
bound for any circuit that requires ECDSA + commitment.

### `income_proof` — 588 opcodes

**Purpose:** Proves income ≥ threshold.

**Structure:** kyc_proof + `income ≥ threshold` (u64 comparison).

**Finding:** The +6 opcode delta is the u64 comparison. Efficient.

**Optimization suggestion:** Merge `income_proof`, `funds_proof`, and
`accreditation_proof` into a single **generic `threshold_proof`** circuit
parameterized by the credential type. All three have identical structure and
constraint counts — only the input name differs. This reduces code duplication
(3 Nargo.toml packages → 1) and simplifies the build matrix without changing
constraints.

### `funds_proof` — 588 opcodes

**Purpose:** Proves account balance ≥ threshold.

**Structure:** Identical to `income_proof`.

**Finding:** Same as income_proof.

**Optimization suggestion:** See `income_proof` — merge into generic threshold circuit.

### `accreditation_proof` — 588 opcodes

**Purpose:** Proves net worth ≥ threshold for accredited investor verification.

**Structure:** Identical to `income_proof`.

**Finding:** Same as income_proof.

**Optimization suggestion:** See `income_proof` — merge into generic threshold circuit.

### `age_proof` — 601 opcodes

**Purpose:** Proves `age_years ≥ threshold_years` from a concealed date of birth.

**Structure:** kyc_proof + date comparison + subtraction + division by 365 +
threshold comparison.

**Finding:** The division by 365 is the sole differentiator from other threshold
circuits (+13 opcodes over a plain comparison). In Noir, integer division lowers
to the unconstrained `directive_integer_quotient` witness hint (8 opcodes —
listed separately and not counted in the ACIR total, see the note in "What
drives the ~577 opcodes?") plus the **constrained range checks** that bound the
quotient and remainder; those range checks are what the extra opcodes come from.

**Optimization suggestion:** Replace `(current_date - date_of_birth) / 365` with
a **multiplication-based check**:

```noir
// Instead of:
//   let age_years = (current_date - date_of_birth) / 365;
//   assert(age_years >= threshold_years);
//
// Use:
assert(current_date >= date_of_birth + threshold_years * 365);
```

This eliminates the division entirely. The multiplication `threshold_years * 365`
is a constant-time operation when `threshold_years` is a circuit input (the Noir
compiler can precompute or use efficient multiplication). Expected ACIR savings:
~10–15 opcodes (eliminates the constrained range checks, bit decompositions,
and comparison operations that verify the division result; the unconstrained
`directive_integer_quotient` itself is a witness-only hint that does not
contribute to ACIR counts — see the note in "What drives the ~577 opcodes?").
Backend gate savings are an estimated ~2,000 (not yet profiled with `bb`).

### `jurisdiction_proof` — 607 opcodes

**Purpose:** Proves residence country is NOT in a restricted list of 8 entries.

**Structure:** kyc_proof + 8 unrolled loop iterations of `assert(code ≠ restricted[i])`.

**Finding:** Each loop iteration costs ~3 opcodes (u64 inequality check). The
loop unrolling is necessary because Noir does not support dynamic loops. If the
restricted list grows beyond 8, constraint count will grow linearly.

**Optimization suggestions (two-tiered):**

1. **Short-term (list stays small):** Keep the unrolled loop. At ~3 opcodes per entry
   and lists of <20 entries, the cost is negligible relative to ECDSA.

2. **Long-term (list grows large):** Replace linear scan with a **sorted Merkle
   inclusion check**. The holder proves their country code is NOT in a
   publicly-known restricted Merkle tree by proving non-membership (e.g., via
   sorted leaf ordering: prove two adjacent leaves `a < code < b` with no gap).
   This makes the jurisdiction check **O(log n)** instead of **O(n)**.

## Key Findings

1. **ECDSA dominates backend cost** (~30,000 gates) across all circuits, but
   appears as only 1 ACIR opcode due to blackbox treatment. Future constraint
   optimization should focus on backend gate profiling, not just ACIR counts.

2. **Field→bytes conversion is the largest ACIR contributor** (~570 opcodes)
   and is the most promising target for ACIR-level optimization if the Noir
   stdlib ever supports ECDSA verification directly on field elements.

3. **Type-specific logic is negligible** (0–25 opcodes, <5% of ACIR, <0.1% of
   backend gates). Optimization effort here yields diminishing returns.

4. **Three circuits are structurally identical** (`income_proof`, `funds_proof`,
   `accreditation_proof`) — all have 588 opcodes. Merging them into a single
   parameterized circuit would reduce code duplication without changing constraints.

5. **age_proof division is unnecessary.** The division by 365 can be replaced
   with multiplication, saving ~10–15 ACIR opcodes and ~2,000 backend gates.

6. **jurisdiction_proof scales linearly** with the restricted list size. At 8
   entries (25 extra opcodes) this is fine, but a Merkle-based approach should
   be evaluated if lists grow.

## Baseline Commitment

These numbers are committed as the **baseline for Noir 1.0.0-beta.9 + bb v0.87.0**.
Any circuit change PR should re-run `nargo info` and update this document,
noting the delta and whether it represents a regression or improvement.

```bash
# Reproduce:
noirup -v 1.0.0-beta.9
cd circuits/
for d in commit kyc_proof income_proof funds_proof accreditation_proof age_proof jurisdiction_proof; do
  echo "=== $d ===" && cd "$d" && nargo info && cd -
done
```

---

## Variable Aggregate Proof — Revert Post-Mortem (#607)

> Recorded here so the next attempt starts informed.  
> Related: issue [#538](https://github.com/ToluLabs/StellarCred/issues/538),
> PR [#570](https://github.com/ToluLabs/StellarCred/pull/570) (merged),
> revert PR [#579](https://github.com/ToluLabs/StellarCred/pull/579),
> follow-up issue [#580](https://github.com/ToluLabs/StellarCred/issues/580).

### What was attempted

PR #570 generalised `aggregate_proof` from a hardcoded KYC + age two-circuit
proof to a variable-N proof supporting up to a configurable maximum of credential
types in a single on-chain transaction (feature spec: #538).

### Why it was reverted (#579)

The revert was necessary due to a **public-input layout mismatch** between the
generalised circuit and the on-chain `submit_aggregate_proof` contract entry
point.

Specifically:

1. **Fixed public-input ABI assumption in the Soroban contract.**  
   `submit_aggregate_proof` (in `contracts/proof_registry/src/lib.rs`) expects
   a flat public-input array whose layout is determined at compile time from the
   two-credential circuit's VK. The variable-N circuit produces a different
   number of public inputs depending on `num_credentials`, which the contract
   cannot handle without a corresponding upgrade and new VK registration.

2. **VK / fixture regeneration not completed.**  
   The PR updated the Noir circuit but did not regenerate `fixtures/aggregate/vk`
   from the new circuit. CI's "Check staged artifacts are current" step (`bb
   write_vk` diff) failed, blocking merge of the revert's fix branch.

3. **Proving cost increase not benchmarked.**  
   The variable-N circuit adds one ECDSA blackbox call per additional credential
   slot, each costing ~30,000 UltraHonk gates. For N=4 this roughly doubles
   browser proving time vs. the two-credential baseline. No profiling data was
   collected before the PR was merged, so the cost was unknown at review time.

### What the next attempt must address

Before re-opening work on #538 / #580:

1. **Contract-first design.** Define the final public-input ABI for variable-N
   in the Soroban contract first, then write the circuit to match it. The two
   must be co-designed; neither can be changed independently once deployed.

2. **VK registration.** The aggregate VK is stored on-chain in `IssuerRegistry`.
   A variable-N circuit produces a different VK from the fixed-N one. The
   upgrade path requires: new circuit → new VK → contract migration or a new
   entry point. Plan this before writing any Noir.

3. **Benchmark before merging.** Run `bb prove` (not just `nargo info`) on the
   variable-N circuit for N=2, N=3, N=4 and record wall-clock proving time in
   both single-threaded and multi-threaded WASM environments. Proving time
   budget for the browser is roughly ≤30 s on a mid-range device.

4. **Regenerate all fixtures.** `circuits/scripts/build.sh` must be re-run and
   the new `fixtures/aggregate/vk` committed before the PR can pass CI.

### Current state

`aggregate_proof` on `main` is the original hardcoded KYC + age two-circuit
version. It is correct and production-tested. Do not change it without
addressing the points above.
