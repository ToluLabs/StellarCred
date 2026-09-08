# Anti-Sybil Distribution — Verified-Human-Once Claims

> Reference implementation: [`contracts/human_airdrop`](../contracts/human_airdrop) ·
> SDK helper: [`frontend/packages/sdk/src/airdrop.ts`](../frontend/packages/sdk/src/airdrop.ts) ·
> Live demo: **HumanDrop** in the [apps gallery](../frontend/app/apps) (`/apps/humandrop`)

StellarCred proves *properties of a human* without revealing who they are. That
is enough to gate access ("is this wallet KYC'd?"), but it is **not** enough to
distribute a fixed allocation: nothing stops one person from proving the same
credential from fifty wallets and claiming fifty times.

This document describes the pattern that closes that gap — the **per-app
nullifier** — how to plug it into a distribution contract, exactly what it
guarantees, and, just as importantly, what it does not.

---

## 1. The primitive: per-app nullifiers

`ProofRegistry` records the **identity commitment** of every proof it verifies:
public-input field 0, the circuit's Poseidon2 binding of the credential's value
and the issuer's salt. Two facts make it useful:

* it is **independent of the wallet address** that submitted the proof, and
* it is **constant** for as long as the credential is valid.

From it, the registry derives an app-scoped pseudonym:

```
nullifier = sha256( identity_commitment || app_scope )
```

```rust
// contracts/proof_registry/src/lib.rs
pub fn app_nullifier(
    env: Env,
    holder: Address,
    credential_type: Symbol,
    app_scope: Bytes,               // e.g. b"stellarcred:airdrop:humandrop-2026"
    min_threshold: Option<u64>,
    trusted_issuers: Option<Vec<Address>>,
) -> Option<BytesN<32>>             // None unless the claim is currently valid
```

`app_nullifier` returns `None` — never a nullifier — when the claim is missing,
expired, revoked, below `min_threshold`, or from an issuer outside
`trusted_issuers`. A nullifier therefore always implies a *currently valid*
credential.

**Properties**

| Property | Why |
|---|---|
| Sybil-resistant | 50 wallets sharing one credential produce one nullifier. |
| Scope-unlinkable | Two campaigns hash different scopes, so their nullifiers cannot be correlated. |
| Non-revealing | The nullifier is a hash of a hash; it discloses no attribute, and cannot be reversed to the credential or the person. |
| Deterministic off-chain | The SDK's `deriveNullifier` reproduces the exact bytes, so front-ends can pre-check without a transaction. |

---

## 2. The pattern: `human_airdrop`

`human_airdrop` is a small, deployable reference contract that turns the
primitive into a claim gate. A **campaign** holds the scope, the credential
rule, the payout, the budget and the window; the contract stores one
`Spent(campaign_id, nullifier)` entry per human that has claimed.

```rust
create_campaign(campaign_id, scope, credential_type, min_threshold,
                trusted_issuers, amount, budget, max_claims, start, end)
claim(caller, campaign_id) -> BytesN<32>       // the reference distributor
consume(consumer, campaign_id, holder) -> BytesN<32>  // for YOUR contract
eligibility(campaign_id, holder) -> Eligibility        // non-mutating pre-flight
has_claimed(campaign_id, holder) -> bool
is_spent(campaign_id, nullifier) -> bool
nullifier_for(campaign_id, holder) -> Option<BytesN<32>>
```

`claim` enforces, in order: campaign exists → active → inside its window →
budget/claim-cap headroom → caller holds a valid credential → **this human has
not already claimed in this campaign**. Failures are typed contract errors
(`CampaignInactive`, `NotVerifiedHuman`, `AlreadyClaimed`, `BudgetExhausted`, …)
so callers can react precisely.

### Consuming it from your own distributor

`consume` is the integration point: it burns a human's one-shot claim and hands
you the nullifier, without paying anything out itself. Your contract keeps full
control of its own economics (token transfer, NFT mint, quota grant).

```rust
// inside YourAirdrop::claim(...)
let gate = HumanAirdropClient::new(&env, &gate_address);
let nullifier = gate.consume(
    &env.current_contract_address(), // the consumer authorises itself
    &campaign_id,
    &holder,
);
// One-claim-per-human is now enforced. Do the payout.
token.transfer(&env.current_contract_address(), &holder, &amount);
```

`consumer.require_auth()` means only the contract being consumed *for* can burn
a claim — a third party cannot grief a human by spending their nullifier.

### Off-chain (SDK)

```ts
import { createHumanClaim } from "@stellarcred/sdk";

const drop = createHumanClaim({
  contractId: process.env.HUMAN_AIRDROP_ID!,
  registryId: process.env.PROOF_REGISTRY_ID,
});

const check = await drop.canClaim("drop1", wallet);
// { eligible: false, reason: "AlreadyClaimed",
//   message: "This human has already claimed in this campaign.",
//   nullifier: "ac90ac63…" }
```

Every SDK method is read-only simulation — the SDK never signs. `deriveNullifier`
is pure and isomorphic (node + browser), and is pinned to the contract by a
shared test vector asserted in both
`contracts/human_airdrop/src/test.rs` and `frontend/packages/sdk/src/airdrop.test.ts`.

---

## 3. Guarantees

Within one campaign, with credential type `T` and scope `S`:

1. **One claim per credential.** Distinct claims require distinct nullifiers,
   and a nullifier is a deterministic function of the credential commitment.
2. **Wallet-count independence.** Creating more addresses does not create more
   claims; funding, age or activity of an address is irrelevant.
3. **Validity at claim time.** A claim requires a live credential: expired,
   revoked, under-threshold or untrusted-issuer credentials yield no nullifier.
4. **Cross-campaign privacy.** A human's nullifiers in two campaigns are
   independent hashes; observers cannot link the two claims from chain data.
5. **No identity disclosure.** Events carry the nullifier only. Indexers can
   count unique humans without learning who they are.
6. **Idempotent under retries.** A re-submitted `claim` transaction fails with
   `AlreadyClaimed` rather than double-paying.
7. **Consumer isolation.** Only the authorised consumer address can burn a
   claim, and the burn is atomic with the surrounding transaction — if your
   payout reverts, the nullifier is not spent.

---

## 4. Limits — read this before you rely on it

The nullifier makes claims **one-per-credential**. "One per human" is only as
true as the issuer's own uniqueness policy. Concretely:

| Limit | Consequence | Mitigation |
|---|---|---|
| **Multiple issuers.** A person credentialed by two registered issuers holds two commitments → two nullifiers. | Sybil factor equal to the number of issuers they can enrol with. | Set `trusted_issuers` to a single issuer (or a set with cross-issuer de-duplication) for the campaign. |
| **Re-issuance.** If an issuer re-issues the same person a credential with a fresh salt, the commitment — and the nullifier — changes. | A patient attacker can re-enrol to claim again. | Issuers must make re-issuance deterministic per person (stable salt derivation), or campaigns must close before re-issuance windows. |
| **Weak KYC.** If the issuer will credential the same human twice under different identity documents, nothing downstream can tell. | Uniqueness is inherited from the issuer, not created by the chain. | Choose issuers with de-duplication; state the assumption publicly. |
| **Credential transfer / sale.** The credential secret is bearer material: whoever holds it can prove it. A person can sell their unused claim. | Allocation reaches the buyer, not the enrolled human. | Out of scope on-chain. Reduce incentive (small allocations), or add liveness/attestation at claim time. |
| **Compromised issuer key.** A stolen key mints arbitrary commitments → arbitrary nullifiers. | Unlimited Sybils. | `IssuerRegistry` key rotation and revocation; monitor issuance volume; see [THREAT_MODEL.md](THREAT_MODEL.md). |
| **Nullifiers are public.** Anyone can see how many humans claimed and when, and can test a *guessed* commitment against a nullifier. | Commitments are high-entropy (Poseidon2 with a random salt), so guessing is infeasible — but do not use a low-entropy scope+value scheme. | Keep issuer salt entropy at the level documented in [ARCHITECTURE.md](ARCHITECTURE.md#commitment-layout-and-the-salt-entropy-requirement). |
| **Scope reuse.** Two campaigns sharing a scope share a nullifier space: a claim in one blocks the other, and the two become linkable. | Unintended cross-campaign coupling. | Use a globally unique scope string per campaign (the contract requires 1–64 bytes; a URN-style string is recommended). |
| **Revocation after claiming.** Revoking a credential does not claw back an already-distributed allocation, and the spent nullifier remains spent. | A revoked human keeps what they claimed and cannot claim again. | Intentional: distributions are final. Pause the campaign (`set_active`) if an issuer is compromised mid-drop. |
| **Not proof-of-personhood.** StellarCred proves *credentials*, not biometric uniqueness. | The pattern is as Sybil-resistant as the credential rule behind it. | Compose with a personhood issuer if you need stronger guarantees. |
| **Demo ledger.** The reference contract credits an internal balance instead of transferring a real token. | Not production-ready as-is. | Swap `set_balance` for a `token::Client` transfer, or use `consume` from your own distributor. |

---

## 5. Try it

* **Demo:** `/apps/humandrop` in the frontend — derives real nullifiers with the
  SDK and shows a second wallet of the same human being rejected.
* **Contract tests:** `cargo test -p human_airdrop` — 19 tests including
  `sybil_second_wallet_with_same_credential_is_rejected` and
  `external_distributor_consumes_one_claim_per_human`, all against real
  UltraHonk proofs from `fixtures/`.
* **SDK tests:** `pnpm --dir frontend/packages/sdk test`.
