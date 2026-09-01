# stellarcred

Command-line access to [StellarCred](https://github.com/Psalmuel01/StellarCred)
— for issuers, integrators, and CI, without writing code. Reads use
[`@stellarcred/sdk`](../sdk) directly; writes shell out to the `stellar` CLI's
own signing identities, so this tool never touches a secret key itself.

## Install

```bash
npx stellarcred --help
```

or install it globally:

```bash
npm install -g stellarcred
```

## Configuration

Every command reads the same environment variables the SDK and frontend use
(`STELLARCRED_*` preferred, falling back to `NEXT_PUBLIC_*`), or accepts an
equivalent global flag:

| Env var | Flag | Used by |
| --- | --- | --- |
| `STELLARCRED_RPC_URL` / `NEXT_PUBLIC_RPC_URL` | `--rpc-url` | all |
| `STELLARCRED_NETWORK_PASSPHRASE` / `NEXT_PUBLIC_NETWORK_PASSPHRASE` | `--network-passphrase` | all |
| `STELLARCRED_NETWORK` / `NEXT_PUBLIC_STELLAR_NETWORK` | `--network` | `issuer register` |
| `STELLARCRED_BASE_URL` / `NEXT_PUBLIC_STELLARCRED_BASE_URL` | `--base-url` | `verify-url` |
| `STELLARCRED_REGISTRY_ID` / `NEXT_PUBLIC_PROOF_REGISTRY_ID` | `--registry-id` | `check` |
| `STELLARCRED_ISSUER_REGISTRY_ID` / `NEXT_PUBLIC_ISSUER_REGISTRY_ID` | `--issuer-registry-id` | `issuers`, `issuer` |
| `STELLARCRED_SIM_ACCOUNT` / `NEXT_PUBLIC_ISSUER_ADDRESS` | `--sim-account` | `issuers`, `issuer status` |

## Commands

### `stellarcred check <wallet> <claim>`

Reads on-chain whether `wallet` holds a valid, unexpired `claim`.

```bash
stellarcred check GABC...XYZ kyc
stellarcred check GABC...XYZ funds --min-threshold 50000
stellarcred check GABC...XYZ kyc --trusted-issuers GISS1...,GISS2... --json
```

Exit code `0` when verified, `1` when not, `2` on a configuration/RPC error —
safe to use directly in a CI gate or shell script.

### `stellarcred issuers`

Lists every address registered in the IssuerRegistry.

```bash
stellarcred issuers --sim-account GANYFUNDEDACCOUNT
```

`--sim-account` (or `STELLARCRED_SIM_ACCOUNT`) just needs to be *any* existing
funded account — it's used to build the read-only simulation, never signed
with or charged.

### `stellarcred verify-url`

Builds a StellarCred verify link, identical to the SDK's `buildVerifyUrl`.

```bash
stellarcred verify-url --return-url "https://myapp.example/vault" --claim funds --threshold 50000
```

### `stellarcred issuer status <issuerId>`

Read-only: on-chain pubkey, metadata, and (with `--credential-type`) whether
the issuer is currently trusted for that claim type.

```bash
stellarcred issuer status GISSUER... --credential-type kyc
```

### `stellarcred issuer register`

Admin-only — registers (or overwrites) a trusted issuer. Requires a signing
identity already configured in the local `stellar` CLI's keystore (the same
one [`scripts/deploy.sh`](../../../scripts/deploy.sh) uses):

```bash
stellar keys generate --network testnet --fund admin   # one-time setup

stellarcred issuer register \
  --issuer-id GISSUER... \
  --pubkey <secp256k1-hex-pubkey> \
  --credential-types kyc,age,funds \
  --source admin \
  --network testnet
```

This command shells out to `stellar contract invoke ... --send yes`. The
StellarCred CLI never reads, generates, or stores a secret key itself —
signing stays entirely inside the `stellar` CLI, matching how every other
write in this repo (deploys, registration) is already done.
