# Staged Deployment Verification and Safe Abort

This document describes how to deploy StellarCred in discrete, verifiable stages so
that every precondition is confirmed before production traffic is switched.  If any
stage fails the script stops immediately and production is left untouched.

## Why staged deployment?

StellarCred manages several on-chain contracts and circuit versions that must be
consistent with one another at all times.  A partially completed deploy can leave
services pointing to a mixed or unusable state:

- `proof_registry` wired to an old `credential_verifier`
- VKs for some credential types installed but not others
- Frontend config pointing to a contract that has not been initialised

Running `scripts/staged-deploy.sh` before switching production ensures every
invariant is confirmed end-to-end.

## Stages

| # | Name | What it checks |
|---|------|---------------|
| 1 | Preflight | Toolchain present, contract IDs set, source account funded |
| 2 | Contract wiring | `proof_registry.verifier_address` and `issuer_registry_address` match the expected IDs; every contract returns a non-empty `admin` |
| 3 | Identity checks | Expected issuer is registered; on-chain public key matches `EXPECTED_ISSUER_PUBKEY` |
| 4 | VK registration | Every required credential type (`kyc`, `age`, `income`, `jurisdiction`, `funds`, `accreditation`) has its verification key installed at the expected version |
| 5 | Frontend config | Generates and validates `stellarcred-config.json`; writes it to `frontend/src/` unless `--skip-frontend-write` |
| 6 | Smoke tests | Read-only invocations on every contract confirm they are live and responsive |
| 7 | Final gate | Writes a signed JSON manifest; prints PASS or ABORT |

## Quick start

```bash
# Set required environment variables
export STELLAR_NETWORK=testnet
export SOURCE=my-deploy-key
export ISSUER_REGISTRY_ID=C...
export CREDENTIAL_VERIFIER_ID=C...
export PROOF_REGISTRY_ID=C...
export GATED_POOL_ID=C...

# Optional identity assertions
export EXPECTED_ADMIN=G...
export EXPECTED_ISSUER_ID=G...
export EXPECTED_ISSUER_PUBKEY=<128-hex-chars>

# Run all stages
./scripts/staged-deploy.sh --network testnet

# Run only up to stage 4 (stop before writing frontend config)
./scripts/staged-deploy.sh --network testnet --stage 4

# Dry-run: check everything but write nothing
./scripts/staged-deploy.sh --network testnet --dry-run
```

## Safe abort

The script exits with code `1` and prints `SAFE ABORT` whenever a failure is
detected.  It does **not** write the deployment manifest and does **not** modify
any on-chain state (all checks are read-only after Stage 1).

If you want warnings to also abort the run:

```bash
./scripts/staged-deploy.sh --abort-on-warn
```

## Options reference

| Flag | Default | Description |
|------|---------|-------------|
| `--network` | `testnet` | Target Stellar network |
| `--rpc-url` | auto | Override Soroban RPC URL |
| `--source` | `$SOURCE` | Stellar key name or address |
| `--stage` | `7` | Stop after this stage |
| `--dry-run` | off | Print actions without writing files |
| `--abort-on-warn` | off | Treat warnings as fatal |
| `--output-manifest` | auto timestamped | Path for the signed manifest JSON |
| `--skip-frontend-write` | off | Skip writing frontend config to disk |

## What the manifest contains

On a successful run `scripts/staged-deploy.sh` writes a JSON manifest such as:

```json
{
  "schema_version": "1",
  "generated_by": "scripts/staged-deploy.sh",
  "timestamp": "2026-11-23T12:00:00Z",
  "network": "testnet",
  "contracts": {
    "issuer_registry":     "C...",
    "credential_verifier": "C...",
    "proof_registry":      "C...",
    "gated_pool":          "C..."
  },
  "stages_completed": 7,
  "warnings": 0,
  "failures": 0,
  "result": "PASS"
}
```

Commit this file to `deployment/` after a successful production deploy so that
`scripts/verify-deployment.sh` can compare against it on future runs.

## CI integration

Add a check to your release workflow:

```yaml
- name: Staged deployment verification
  env:
    STELLAR_NETWORK: testnet
    SOURCE: ${{ secrets.DEPLOY_SOURCE }}
    ISSUER_REGISTRY_ID: ${{ vars.ISSUER_REGISTRY_ID }}
    CREDENTIAL_VERIFIER_ID: ${{ vars.CREDENTIAL_VERIFIER_ID }}
    PROOF_REGISTRY_ID: ${{ vars.PROOF_REGISTRY_ID }}
    GATED_POOL_ID: ${{ vars.GATED_POOL_ID }}
  run: ./scripts/staged-deploy.sh --skip-frontend-write
```

## Relationship to verify-deployment.sh

| Script | Purpose |
|--------|---------|
| `staged-deploy.sh` | Run **before** switching production â€” preflight + wiring + VK + config |
| `verify-deployment.sh` | Run **after** to confirm WASM hashes and on-chain versions match the repository |

Use both: staged-deploy before the switch, verify-deployment after it.
