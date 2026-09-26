# StellarCred — Contract Instruction Budget Benchmarks

Pre-mainnet cost documentation for every public function across all four Soroban contracts.
Soroban charges per CPU instruction, memory byte, and ledger entry read/write — unexpectedly
expensive functions can make the protocol unusable or unaffordable.

---

## Testnet Conditions

| Parameter              | Value                                                    |
| ---------------------- | -------------------------------------------------------- |
| Date measured          | 2026-07-24                                               |
| Network                | Stellar Testnet (Futurenet / Protocol 23)                |
| Stellar CLI version    | v27.0.0 (`stellar --version`)                            |
| Soroban SDK            | soroban-sdk v26.1.0                                      |
| Verifier crate         | ultrahonk-soroban-verifier (BN254 UltraHonk)             |
| Noir version           | 1.0.0-beta.9                                             |
| Barretenberg (bb)      | v0.87.0                                                  |
| Per-tx CPU budget      | 100,000,000 instructions                                 |
| Fee base (testnet)     | ~0.0000100 XLM per 10,000 instructions (indicative)      |
| Resource estimation    | `stellar contract invoke --cost`                         |

> **Note:** Values below are derived from simulation using `stellar contract invoke --cost`
> and the Stellar Protocol 23 Soroban host. Actual mainnet fees depend on network fee
> competition and surge pricing at submission time. Figures are per-invocation, not including
> network overhead or base transaction fee.

---

## Per-transaction CPU budget utilization

Soroban's hard limit per transaction is **100,000,000 CPU instructions**.
The most expensive function, `submit_proof` (full UltraHonk BN254 verify), uses
approximately **12.5–15 million instructions** — roughly **12.5–15% of the transaction budget** —
confirming the protocol fits well within the per-transaction limit and leaving substantial
headroom for composability.

---

## proof_registry

| Function             | CPU Instructions | Mem (bytes)  | Read Entries | Write Entries | Read Bytes | Write Bytes | Fee (XLM est.) | Notes                                         |
| -------------------- | ---------------: | -----------: | -----------: | ------------: | ---------: | ----------: | -------------: | --------------------------------------------- |
| `submit_proof`       | ~13,500,000      | ~1,200,000   | 4            | 1             | ~6,200     | ~150        | ~0.014         | Dominant cost: BN254 UltraHonk verify + 3 cross-contract reads |
| `submit_proofs_batch`| ~40,000,000*     | ~3,500,000   | 12           | 3             | ~18,600    | ~450        | ~0.040*        | *Per 3-item batch (scales linearly up to MAX_BATCH_SIZE=5) |
| `is_verified`        | ~350,000         | ~60,000      | 1            | 0             | ~200       | 0           | ~0.00035       | Single persistent storage read; very cheap    |
| `check_claim`        | ~400,000         | ~65,000      | 1            | 0             | ~200       | 0           | ~0.0004        | Storage read + threshold comparison           |
| `revoke_proof`       | ~280,000         | ~50,000      | 0            | 1             | 0          | ~150        | ~0.00028       | Removes persistent entry; holder-auth         |
| `revoke`             | ~700,000         | ~80,000      | 2            | 1             | ~400       | ~150        | ~0.0007        | issuer auth + cross-contract `is_valid_issuer` + write |
| `set_admin`          | ~200,000         | ~40,000      | 1            | 1             | ~100       | ~100        | ~0.0002        | Instance storage update; admin-only           |
| `admin`              | ~120,000         | ~30,000      | 1            | 0             | ~100       | 0           | ~0.00012       | Instance storage read                         |
| `upgrade`            | ~250,000         | ~45,000      | 1            | 1             | ~100       | varies      | ~0.00025       | WASM hash update; admin-only                  |
| `verifier_address`   | ~120,000         | ~30,000      | 1            | 0             | ~100       | 0           | ~0.00012       | Instance storage read                         |
| `issuer_registry_address` | ~120,000   | ~30,000      | 1            | 0             | ~100       | 0           | ~0.00012       | Instance storage read                         |

### submit_proof cost breakdown

`submit_proof` is the most expensive function. The cost is dominated by the BN254 UltraHonk
proof verifier, which runs entirely via Soroban host-native functions (no external call):

```
1. is_valid_issuer (cross-contract call → IssuerRegistry): ~250,000 instructions
2. get_issuer_pubkey (cross-contract call → IssuerRegistry): ~220,000 instructions
3. public_inputs_match_pubkey (64-byte key comparison):       ~80,000 instructions
4. verify_proof (cross-contract call → CredentialVerifier):
     └─ BN254 UltraHonk host fn:                           ~12,500,000 instructions
5. Persistent storage write (ProofRecord):                    ~180,000 instructions
6. extend_ttl + event emit:                                    ~80,000 instructions
                                                    ─────────────────────────────
                                    Total:                ~13,310,000 instructions
                                    Budget utilization:         ~13.3%
```

---

## issuer_registry

| Function           | CPU Instructions | Mem (bytes) | Read Entries | Write Entries | Read Bytes | Write Bytes | Fee (XLM est.) | Notes                                              |
| ------------------ | ---------------: | ----------: | -----------: | ------------: | ---------: | ----------: | -------------: | -------------------------------------------------- |
| `register_issuer`  | ~320,000         | ~55,000     | 1            | 1             | ~100       | ~200        | ~0.00032       | Admin auth + persistent write (`Issuer` struct)    |
| `revoke_issuer`    | ~280,000         | ~50,000     | 1            | 1             | ~200       | ~200        | ~0.00028       | Admin auth + read-modify-write                     |
| `is_valid_issuer`  | ~200,000         | ~40,000     | 1            | 0             | ~200       | 0           | ~0.0002        | Persistent read + linear scan of `credential_types` Vec |
| `get_issuer_pubkey`| ~180,000         | ~38,000     | 1            | 0             | ~200       | 0           | ~0.00018       | Persistent read; returns 64-byte BytesN            |
| `admin`            | ~120,000         | ~30,000     | 1            | 0             | ~100       | 0           | ~0.00012       | Instance storage read                              |

### Issuer key management — pending measurement (#544)

`scripts/benchmark.sh` now also exercises the following, but no figures are
recorded here yet. Run the script on a funded testnet account and fill these in
before relying on the hot-path claim below.

| Function             | CPU Instructions | Mem (bytes) | Read Entries | Write Entries | Read Bytes | Write Bytes | Fee (XLM est.) | Notes |
| -------------------- | ---------------: | ----------: | -----------: | ------------: | ---------: | ----------: | -------------: | ----- |
| `is_issuer_key_valid`| _pending_        | _pending_   | _pending_    | _pending_     | _pending_  | _pending_   | _pending_      | Persistent read; key-index scan (≤ 4 keys) |
| `get_issuer_keys`    | _pending_        | _pending_   | _pending_    | _pending_     | _pending_  | _pending_   | _pending_      | Persistent read; returns the full rotation history |
| `rotate_issuer_key`  | _pending_        | _pending_   | _pending_    | _pending_     | _pending_  | _pending_   | _pending_      | Admin auth + read-modify-write of two key records |
| `revoke_issuer_key`  | _pending_        | _pending_   | _pending_    | _pending_     | _pending_  | _pending_   | _pending_      | Admin auth + read-modify-write of one key record |

> **Note:** `is_issuer_key_valid` replaces the previous single
> `get_issuer_pubkey` call on `ProofRegistry.submit_proof`, so it now runs on
> every submission. The old path was a single `Issuer` struct read; the new one
> additionally reads the issuer's key index and one record per tracked key
> (capped at 4 by `MAX_KEYS_PER_ISSUER`). This needs re-measuring before
> mainnet — the `submit_proof` headroom analysis in *Key findings* below was
> taken against the old single-read path.

---

## credential_verifier

| Function       | CPU Instructions | Mem (bytes) | Read Entries | Write Entries | Read Bytes  | Write Bytes | Fee (XLM est.) | Notes                                                       |
| -------------- | ---------------: | ----------: | -----------: | ------------: | ----------: | ----------: | -------------: | ----------------------------------------------------------- |
| `verify_proof` | ~12,700,000      | ~1,100,000  | 1            | 0             | ~3,000–5,000| 0           | ~0.013         | VK lookup + full BN254 UltraHonk verify (host-native)       |
| `set_vk`       | ~850,000         | ~120,000    | 1            | 1             | ~100        | ~3,000–5,000| ~0.00085       | Admin auth + VK parse/validate + persistent write           |

### verify_proof breakdown

```
1. Proof length check (early reject):              ~10,000 instructions
2. Persistent VK read:                            ~180,000 instructions
3. UltraHonkVerifier::new (VK parse):             ~200,000 instructions
4. verifier.verify (BN254 host fn):            ~12,200,000 instructions
                                        ─────────────────────────────
                         Total:                ~12,590,000 instructions
                         Budget utilization:          ~12.6%
```

---

## gated_pool

| Function       | CPU Instructions | Mem (bytes) | Read Entries | Write Entries | Read Bytes | Write Bytes | Fee (XLM est.) | Notes                                                      |
| -------------- | ---------------: | ----------: | -----------: | ------------: | ---------: | ----------: | -------------: | ---------------------------------------------------------- |
| `deposit`      | ~650,000         | ~90,000     | 2            | 1             | ~300       | ~100        | ~0.00065       | Caller auth + cross-contract `is_verified` + balance r/w  |
| `withdraw`     | ~350,000         | ~60,000     | 1            | 1             | ~100       | ~100        | ~0.00035       | Caller auth + balance read + balance write                 |
| `get_balance`  | ~150,000         | ~35,000     | 1            | 0             | ~100       | 0           | ~0.00015       | Simple persistent balance read                             |
| `registry_address` | ~120,000     | ~30,000     | 1            | 0             | ~100       | 0           | ~0.00012       | Instance storage read                                      |

### deposit breakdown

```
1. caller.require_auth():                           ~50,000 instructions
2. is_verified cross-contract call (→ ProofRegistry
   → persistent read):                             ~380,000 instructions
3. balance_of (persistent read):                    ~150,000 instructions
4. set_balance (persistent write + extend_ttl):     ~150,000 instructions
                                        ─────────────────────────────
                         Total:                     ~730,000 instructions
                         Budget utilization:              <1%
```

---

## Cost Summary (all functions)

| Contract              | Function              | CPU Instructions | Budget % | Fee (XLM est.) |
| --------------------- | --------------------- | ---------------: | -------: | -------------: |
| `proof_registry`      | `submit_proof`        | ~13,500,000      | ~13.5%   | ~0.014         |
| `proof_registry`      | `submit_proofs_batch` | ~40,000,000 *    | ~40.0% * | ~0.040 *       |
| `proof_registry`      | `is_verified`         | ~350,000         | <0.4%    | ~0.00035       |
| `proof_registry`      | `check_claim`         | ~400,000         | <0.4%    | ~0.0004        |
| `proof_registry`      | `revoke_proof`        | ~280,000         | <0.3%    | ~0.00028       |
| `proof_registry`      | `revoke`              | ~700,000         | <0.7%    | ~0.0007        |
| `proof_registry`      | `set_admin`           | ~200,000         | <0.2%    | ~0.0002        |
| `proof_registry`      | `admin`               | ~120,000         | <0.1%    | ~0.00012       |
| `proof_registry`      | `upgrade`             | ~250,000         | <0.3%    | ~0.00025       |
| `issuer_registry`     | `register_issuer`     | ~320,000         | <0.3%    | ~0.00032       |
| `issuer_registry`     | `revoke_issuer`       | ~280,000         | <0.3%    | ~0.00028       |
| `issuer_registry`     | `is_valid_issuer`     | ~200,000         | <0.2%    | ~0.0002        |
| `issuer_registry`     | `get_issuer_pubkey`   | ~180,000         | <0.2%    | ~0.00018       |
| `issuer_registry`     | `admin`               | ~120,000         | <0.1%    | ~0.00012       |
| `credential_verifier` | `verify_proof`        | ~12,700,000      | ~12.7%   | ~0.013         |
| `credential_verifier` | `set_vk`              | ~850,000         | <0.9%    | ~0.00085       |
| `gated_pool`          | `deposit`             | ~650,000         | <0.7%    | ~0.00065       |
| `gated_pool`          | `withdraw`            | ~350,000         | <0.4%    | ~0.00035       |
| `gated_pool`          | `get_balance`         | ~150,000         | <0.2%    | ~0.00015       |
| `gated_pool`          | `registry_address`    | ~120,000         | <0.1%    | ~0.00012       |

\* `submit_proofs_batch` figure is for a 3-item batch. Max 5-item batch ≈ 66,000,000 instructions (~66% budget).

---

## Key findings

1. **`submit_proof` fits the per-transaction budget comfortably.** At ~13.5M instructions
   (~13.5% of 100M limit), it has ~86M instructions of remaining headroom for composability
   with other contracts. This was the primary acceptance criterion for mainnet readiness.

2. **`verify_proof` in `credential_verifier` is similarly well-scoped** at ~12.7M instructions.
   The BN254 UltraHonk host function (`soroban_sdk::crypto::bn254`) is highly optimized.

3. **Read-only functions (`is_verified`, `check_claim`, `get_balance`) are negligible** — all
   under 400,000 instructions, less than 0.4% of budget. Downstream protocols calling these
   can do so freely in loops or multi-step transactions.

4. **`submit_proofs_batch` scales linearly** with batch size. A 5-credential batch approaches
   ~66M instructions. This is within budget but leaves less headroom; contributors should
   prefer single-proof submission for composable protocols.

5. **All fee estimates are below 0.05 XLM** even for the most expensive operations, making
   the protocol affordable under normal testnet and mainnet conditions.

---

## How to reproduce

Use `scripts/benchmark.sh` to measure instruction budgets for every function.
The script requires a funded testnet account and Stellar CLI v26+:

```bash
# One-time: generate and fund a testnet account
stellar keys generate --global benchmarker --network testnet --fund

# Run benchmarks (deploys fresh contracts + measures each function)
SOURCE=benchmarker bash scripts/benchmark.sh

# Or against existing contracts (skips deployment)
SOURCE=benchmarker \
  ISSUER_REGISTRY_ID=C... \
  CREDENTIAL_VERIFIER_ID=C... \
  PROOF_REGISTRY_ID=C... \
  GATED_POOL_ID=C... \
  bash scripts/benchmark.sh
```

Each invocation prints the raw `--cost` output from the Stellar CLI, which includes:
- `cpu_insns` — CPU instruction count
- `mem_bytes` — Memory bytes used
- `ledger_read_bytes` / `ledger_write_bytes`
- `events_and_return_value_size_bytes`
- `min_resource_fee` in stroops (divide by 10,000,000 for XLM)

---

## References

- [Soroban resource limits and fees](https://developers.stellar.org/docs/networks/resource-limits-fees)
- [BN254 host functions — Protocol 23](https://developers.stellar.org/docs/build/apps/zk)
- [UltraHonk Soroban verifier](https://github.com/yugocabrio/rs-soroban-ultrahonk)
- [stellar contract invoke --cost](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-contract#stellar-contract-invoke)
