# Local Proof Validation

Run the same credential parser used by the holder app, check proof public
inputs against the credential's issuer and claim policy, then verify the
UltraHonk proof against the locally compiled circuit. No server, RPC, or
provider connection is used, and the command never submits or writes a proof.

## Setup

From the repository root, install the frontend workspace dependencies once:

```sh
pnpm --dir frontend install
```

The compiled circuit artifact must exist at
`frontend/public/circuits/<credential-type>.json`.

## Usage

The credential file is the same plaintext credential JSON accepted by the
holder app. The proof file contains the generated proof and public inputs:

```json
{
  "proof": "base64:...",
  "publicInputs": ["0x...", "0x..."]
}
```

Public inputs may also be supplied as a byte array, hex string, or
`base64:<data>` string containing packed 32-byte fields. `proof` accepts a byte
array, hex, or `base64:<data>`.

```sh
pnpm --dir frontend validate-proof -- \
  --credential ./credential.json \
  --proof ./proof.json \
  --dry-run
```

The command prints JSON with `result: "PASS"` or `result: "FAIL"`. A failure
exits with status 1. `--dry-run` is explicit; validation is always read-only and
does not contact the network or submit anything.

## Checks and limits

Validation rejects malformed credential data, wrong circuit/public-input
counts, a commitment or issuer key that does not match the credential, and
threshold or jurisdiction inputs that differ from the credential policy. It
then verifies the proof with Barretenberg's UltraHonk verifier using the
production `keccak` setting.

This does not query IssuerRegistry or ProofRegistry. In particular, it cannot
confirm that the issuer key is currently trusted, that a proof has not been
revoked, or that a deployment currently accepts the proof. The age circuit's
public `current_date` is supplied by the prover; the current ProofRegistry does
not compare it with ledger time. A local PASS therefore does not establish
freshness for an age claim. Production age-gating should not treat this date as
trusted until the contract enforces the ledger-time check. A local PASS means
the proof is valid for the local circuit and matches the supplied credential
policy, not that it is currently accepted by a deployment.

## Common failures

- `type must be one of ...`: the credential type is unsupported or misspelled.
- `Expected ... public inputs`: the proof belongs to another circuit or its
  public inputs were truncated; provide the matching proof and credential.
- `commitment` or `issuer public key` mismatch: regenerate the proof from this
  credential, rather than editing the public inputs.
- `threshold` or `restricted list` mismatch: use the same claim parameters the
  credential was issued with and the protocol expects.
- `UltraHonk verification failed`: check that proof, public inputs, and the
  compiled circuit artifact were generated from compatible circuit versions.

Credential and proof files may reveal sensitive information. Keep them local,
restrict file permissions, and remove temporary copies when finished.
