# Date-range credential circuit

This circuit proves that a privately held issuance date lies inside an
inclusive public window while binding that date to an issuer-signed Poseidon2
commitment.

Public inputs are ordered as: `commitment`, `issuer_x[32]`, `issuer_y[32]`,
`window_start`, and `window_end`. Dates are whole days since the Unix epoch.
The witness contains `issued_at`, non-zero `salt`, and the 64-byte secp256k1
signature.

Verifiers must derive the acceptable window from trusted ledger time. The
circuit proves the relationship only; accepting a caller-selected unbounded
window does not enforce a freshness policy.

Run the focused suite with `nargo test --package date_range`.
