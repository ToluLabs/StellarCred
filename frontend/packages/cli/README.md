# stellarcred (CLI)

Command-line access to StellarCred for issuers, integrators, ops and CI.

The CLI uses [`@stellarcred/sdk`](../sdk) for every read. It defaults to
**testnet**, with the contract ids recorded in
[`DEPLOYMENTS.md`](../../../DEPLOYMENTS.md).

```bash
npx stellarcred --help
```

## Commands

| Command                                                                                                                                    | What it does                                                                       | Exit code                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `stellarcred check <wallet> <claim> [--min <n>] [--issuer <G…>]…`                                                                          | Reads the wallet's credential from ProofRegistry on-chain (SDK `checkClaimStatus`) | `0` valid · `1` not verified / expired / revoked / below `--min` / wrong issuer |
| `stellarcred issuers [--all]`                                                                                                              | Lists issuers registered in IssuerRegistry (`--all` includes revoked)              | `0`                                                                             |
| `stellarcred verify-url --return-url <url> (--claim <t> \| --claims <a,b>) [--wallet <G…>] [--state <s>] [--expires <min>] [--single-use]` | Builds a verify link (SDK `buildVerifyUrl`)                                        | `0`                                                                             |
| `stellarcred issuer status <issuer> [--type <claim>]…`                                                                                     | Shows an issuer's record, and whether it is valid for each credential type         | `0` registered and not revoked · `1` otherwise                                  |
| `stellarcred issuer register <issuer> --pubkey <128 hex> --types <a,b> (--source <G…> \| --send)`                                          | Builds the admin-only `register_issuer` transaction                                | `0`                                                                             |

Shared exit codes: `2` is a usage error (bad flag, address or claim type), and
`3` is an RPC or network error. Add `--json` to any command for
machine-readable output.

```bash
# Gate a CI job or script on a credential
npx stellarcred check GABC…XYZ kyc && echo "verified"
npx stellarcred check GABC…XYZ age --min 18 --json | jq .status

# Send a user to verify, then back to your app
npx stellarcred verify-url --return-url https://app.example/done --claims kyc,age --expires 30
```

## Configuration

Flags win over environment variables, which win over the network defaults. The
variables are the ones the SDK already reads, so a server that configures the
SDK also configures the CLI.

| Flag                   | Environment                                    | Default                                      |
| ---------------------- | ---------------------------------------------- | -------------------------------------------- |
| `--network`            | `STELLARCRED_NETWORK`                          | `testnet`                                    |
| `--rpc-url`            | `STELLARCRED_RPC_URL`                          | the network's public Soroban RPC             |
| —                      | `STELLARCRED_NETWORK_PASSPHRASE`               | the network's passphrase                     |
| `--registry-id`        | `STELLARCRED_REGISTRY_ID`, `PROOF_REGISTRY_ID` | testnet ProofRegistry from `DEPLOYMENTS.md`  |
| `--issuer-registry-id` | `STELLARCRED_ISSUER_REGISTRY_ID`               | testnet IssuerRegistry from `DEPLOYMENTS.md` |
| `--base-url`           | `STELLARCRED_BASE_URL`                         | `https://stellarcred.xyz`                    |

Mainnet has no recorded deployment yet, so on mainnet you must pass contract ids
explicitly.

## Issuer registration and signing

`register_issuer` is **admin-only**. The CLI never takes a secret from the
command line: any `S…` seed in the arguments is rejected, so keys stay out of
shell history and CI logs.

- **Default — build only.** Pass the admin's public key with `--source`. The
  transaction is simulated against the network, which fails early if the source
  is not the admin or if the key change needs `rotate_issuer_key`. It is then
  printed **unsigned**, to sign with a wallet or the Stellar CLI:

  ```bash
  npx stellarcred issuer register G…ISSUER --pubkey <128 hex> --types kyc,age --source G…ADMIN
  ```

- **`--send` — sign here.** Signs with the admin key in `STELLARCRED_ADMIN_SECRET`
  and submits, retrying transient RPC failures through the SDK's
  `submitTransaction`. Use it only on a server or in a CI job with a protected
  secret.
  - It refuses to run when any `NEXT_PUBLIC_*` variable holds a secret key, since
    that would be bundled into the browser.
  - On mainnet it also needs `--allow-mainnet`.

The issuer's **credential-signing** key (`ISSUER_PRIVATE_KEY`, secp256k1) is
never used by the CLI. Only its public key is registered.

## Development

```bash
npm run build     # bundles src/cli.ts + the SDK source into dist/cli.mjs
npm test          # vitest: commands with the SDK stubbed, register against a fake RPC, and the built binary
npm run typecheck
```
