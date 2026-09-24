# Composite Eligibility Proof

The composite proof evaluates a fixed-shape boolean policy over several committed attributes in a single proof. This enables evaluating complex logical rules (e.g., `(Age >= 18) AND (Accredited OR Jurisdiction in Allowlist)`) without requiring multiple proofs to be verified on-chain.

## Policy Encoding

The circuit evaluates a policy defined as a binary tree over a maximum of 4 terms (leaves).

### Terms

There are up to 4 terms provided via `values`, `salts`, `sigs`, `paths`, and `indices`.
For each term, its behavior is configured by the `kinds` array:

- `0` (FALSE/SKIP): The term always evaluates to `false`. Useful for padding. Note: Valid signatures/salts must still be provided (e.g. duplicate from another term) to satisfy the credential binding check.
- `1` (THRESHOLD): Evaluates `value >= threshold`.
- `2` (MEMBERSHIP): Evaluates if the value's Merkle path resolves to `merkle_root`.
- `3` (TRUE): The term always evaluates to `true`.

### Operators

The tree structure is fixed and evaluated using 3 operations (`ops`):

```
       op2
      /   \
    op0   op1
   /  \   /  \
  T0  T1 T2  T3
```

Available operator codes:
- `0`: AND (`left & right`)
- `1`: OR (`left | right`)
- `2`: LEFT (`left` - ignores right branch)
- `3`: RIGHT (`right` - ignores left branch)

### Example

To evaluate `(T0 OR T1) AND T2`:
- `kinds`: `[Type0, Type1, Type2, 0]`
- `ops[0]`: `1` (OR - evaluates `T0 OR T1`)
- `ops[1]`: `2` (LEFT - evaluates `T2` and ignores `T3`)
- `ops[2]`: `0` (AND - evaluates the final result)

This structure bounds the circuit to 4 Merkle/signature evaluations while supporting any Boolean formula of up to 4 terms through operator selection.

## Bounding Rationale

The policy shape is bounded to a maximum of 4 terms (`MAX_TERMS = 4`). This limit balances flexibility for real-world policies (such as `KYC AND (Accredited OR HighIncome) AND EligibleJurisdiction`) with circuit size and prover performance. Each term requires computing Poseidon hashes and ECDSA signature verifications, making a bounded number critical for fast proofs on consumer hardware.
