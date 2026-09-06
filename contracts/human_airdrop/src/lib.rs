#![no_std]
// `create_campaign` takes `env` + 10 campaign parameters. Grouping them into a
// struct would change the on-chain ABI that deploy scripts and the SDK depend
// on, and the lint fires through macro expansion (contractimpl /
// contractclient) where item-level `#[allow]` is not propagated — so it is
// suppressed at the crate level, matching `proof_registry`.
#![allow(clippy::too_many_arguments)]
//! HumanAirdrop — a ready-made "verified-human-once" distribution pattern.
//!
//! This is the plug-and-play anti-Sybil layer on top of StellarCred's per-app
//! nullifiers (`ProofRegistry::app_nullifier`). It answers, on-chain and in one
//! call, the question every airdrop/quota contract needs answered:
//!
//! > *Has this human already claimed in this campaign?*
//!
//! ## How the guarantee works
//!
//! A campaign carries an **app scope** — arbitrary bytes chosen by the
//! distributor, e.g. `b"stellarcred:airdrop:humandrop-2026"`. For a holder
//! with a valid credential, the ProofRegistry derives
//!
//! ```text
//! nullifier = sha256( identity_commitment || app_scope )
//! ```
//!
//! `identity_commitment` is public-input field 0 of the ZK proof — the
//! circuit's binding of the credential's attributes and the issuer's salt. It
//! does **not** depend on the wallet address that submitted the proof, so a
//! Sybil operator who spreads one credential across 50 addresses derives the
//! *same* nullifier 50 times and can claim exactly once. Because the scope is
//! hashed in, the same human's nullifiers in two different campaigns are
//! unlinkable to each other.
//!
//! ## Two ways to use it
//!
//! 1. **Reference distributor** — call [`HumanAirdrop::claim`]. The contract
//!    checks the credential, burns the human's one-shot claim for the
//!    campaign, and credits `amount` to the caller's balance.
//! 2. **Consumable primitive** — any *other* distribution contract calls
//!    [`HumanAirdrop::consume`] with its own contract address. That burns the
//!    human's claim for the campaign (returning the nullifier for the
//!    distributor's own bookkeeping) and lets the caller do whatever payout it
//!    likes — token transfer, NFT mint, quota grant.
//!
//! Balances here are a plain ledger (no token transfer) to keep the demo
//! self-contained, exactly like `gated_pool`; swap in a token client for
//! production.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Bytes, BytesN, Env, Symbol, Vec,
};

// ── Persistent-entry lifetime management (~5s ledgers) ──────────────────────
const DAY_IN_LEDGERS: u32 = 17280;
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const ENTRY_TTL: u32 = 180 * DAY_IN_LEDGERS;

/// Hard cap on a campaign's scope bytes — keeps nullifier derivation cheap and
/// campaign entries small.
const MAX_SCOPE_LEN: u32 = 64;

/// Typed client for the deployed ProofRegistry. Declared as an interface so
/// this contract links only the client, not the registry's wasm symbols.
#[contractclient(name = "RegistryClient")]
pub trait RegistryInterface {
    fn check_claim(
        env: Env,
        holder: Address,
        credential_type: Symbol,
        min_threshold: Option<u64>,
        trusted_issuers: Option<Vec<Address>>,
    ) -> bool;

    fn app_nullifier(
        env: Env,
        holder: Address,
        credential_type: Symbol,
        app_scope: Bytes,
        min_threshold: Option<u64>,
        trusted_issuers: Option<Vec<Address>>,
    ) -> Option<BytesN<32>>;
}

// ── Types ───────────────────────────────────────────────────────────────────

/// A distribution campaign: one claim per verified human, for as long as the
/// window is open and the budget lasts.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Campaign {
    /// App scope mixed into every nullifier for this campaign. Two campaigns
    /// with different scopes are independent (and mutually unlinkable).
    pub scope: Bytes,
    /// Credential the claimant must hold (e.g. `kyc`).
    pub credential_type: Symbol,
    /// Optional minimum threshold for parameterised credentials (age, funds…).
    pub min_threshold: Option<u64>,
    /// Optional issuer allowlist. `None` accepts any registered issuer.
    pub trusted_issuers: Option<Vec<Address>>,
    /// Payout per human.
    pub amount: i128,
    /// Total distributable budget.
    pub budget: i128,
    /// Budget already distributed.
    pub distributed: i128,
    /// Number of humans that have claimed.
    pub claims: u32,
    /// Hard cap on claims (`0` = unlimited, budget still applies).
    pub max_claims: u32,
    /// Claim window (unix seconds). `end == 0` means "no end".
    pub start: u64,
    pub end: u64,
    /// Admin kill-switch.
    pub active: bool,
}

/// Why a holder can (or cannot) claim right now. Returned by
/// [`HumanAirdrop::eligibility`] so an SDK/frontend can render an accurate
/// reason without simulating a failing `claim`.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Eligibility {
    Eligible,
    CampaignNotFound,
    CampaignInactive,
    CampaignNotStarted,
    CampaignEnded,
    NotVerifiedHuman,
    AlreadyClaimed,
    BudgetExhausted,
}

/// Payload emitted when a campaign is created.
/// Topics: ("humandrop", "created", campaign_id)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventCampaignCreated {
    pub admin: Address,
    pub credential_type: Symbol,
    pub amount: i128,
    pub budget: i128,
}

/// Payload emitted when a verified human claims.
/// Topics: ("humandrop", "claimed", campaign_id)
///
/// Note the payload carries the **nullifier**, not any credential data: an
/// indexer can count unique humans per campaign without learning who they are.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventClaimed {
    pub caller: Address,
    pub nullifier: BytesN<32>,
    pub amount: i128,
    pub claims: u32,
}

/// Payload emitted when an external distribution contract consumes a human's
/// one-shot claim. Topics: ("humandrop", "consumed", campaign_id)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventConsumed {
    pub consumer: Address,
    pub holder: Address,
    pub nullifier: BytesN<32>,
    pub claims: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Registry,
    /// campaign_id -> Campaign
    Campaign(Symbol),
    /// (campaign_id, nullifier) -> true. The one-claim-per-human record.
    Spent(Symbol, BytesN<32>),
    /// Demo payout ledger.
    Balance(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    CampaignExists = 2,
    CampaignNotFound = 3,
    CampaignInactive = 4,
    CampaignNotStarted = 5,
    CampaignEnded = 6,
    /// No valid credential for this campaign's requirement — the caller is not
    /// a verified human (or the proof expired / was revoked / is below the
    /// threshold / is from an untrusted issuer).
    NotVerifiedHuman = 7,
    /// This human already claimed in this campaign. The anti-Sybil stop.
    AlreadyClaimed = 8,
    BudgetExhausted = 9,
    InvalidAmount = 10,
    InvalidWindow = 11,
    InvalidScope = 12,
    InsufficientBalance = 13,
}

#[contract]
pub struct HumanAirdrop;

#[contractimpl]
impl HumanAirdrop {
    /// `registry` is the deployed ProofRegistry contract address.
    pub fn __constructor(env: Env, admin: Address, registry: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Registry, &registry);
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    /// Create a campaign. `scope` is the app-scope byte string mixed into every
    /// nullifier; use something globally unique to this campaign so nullifiers
    /// cannot be correlated with another app's.
    #[allow(deprecated)]
    pub fn create_campaign(
        env: Env,
        campaign_id: Symbol,
        scope: Bytes,
        credential_type: Symbol,
        min_threshold: Option<u64>,
        trusted_issuers: Option<Vec<Address>>,
        amount: i128,
        budget: i128,
        max_claims: u32,
        start: u64,
        end: u64,
    ) {
        let admin = Self::admin(env.clone());
        admin.require_auth();

        if env
            .storage()
            .persistent()
            .has(&DataKey::Campaign(campaign_id.clone()))
        {
            panic_with_error!(&env, Error::CampaignExists);
        }
        if scope.is_empty() || scope.len() > MAX_SCOPE_LEN {
            panic_with_error!(&env, Error::InvalidScope);
        }
        if amount <= 0 || budget < amount {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if end != 0 && end <= start {
            panic_with_error!(&env, Error::InvalidWindow);
        }

        let campaign = Campaign {
            scope,
            credential_type: credential_type.clone(),
            min_threshold,
            trusted_issuers,
            amount,
            budget,
            distributed: 0,
            claims: 0,
            max_claims,
            start,
            end,
            active: true,
        };
        Self::put_campaign(&env, &campaign_id, &campaign);

        env.events().publish(
            (
                symbol_short!("humandrop"),
                symbol_short!("created"),
                campaign_id,
            ),
            EventCampaignCreated {
                admin,
                credential_type,
                amount,
                budget,
            },
        );
    }

    /// Admin kill-switch for a campaign.
    pub fn set_active(env: Env, campaign_id: Symbol, active: bool) {
        Self::admin(env.clone()).require_auth();
        let mut campaign = Self::require_campaign(&env, &campaign_id);
        campaign.active = active;
        Self::put_campaign(&env, &campaign_id, &campaign);
    }

    /// Top up a campaign's budget.
    pub fn fund(env: Env, campaign_id: Symbol, extra_budget: i128) {
        Self::admin(env.clone()).require_auth();
        if extra_budget <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut campaign = Self::require_campaign(&env, &campaign_id);
        campaign.budget = campaign
            .budget
            .checked_add(extra_budget)
            .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidAmount));
        Self::put_campaign(&env, &campaign_id, &campaign);
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        Self::admin(env.clone()).require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    // ── The distribution flow ───────────────────────────────────────────────

    /// Claim once, as a verified human, in `campaign_id`.
    ///
    /// Enforces, in order: campaign exists → is active → is inside its window
    /// → caller holds a valid credential → **this human has not already
    /// claimed in this campaign** → budget/claim cap remains. Returns the
    /// consumed nullifier.
    #[allow(deprecated)]
    pub fn claim(env: Env, caller: Address, campaign_id: Symbol) -> BytesN<32> {
        caller.require_auth();

        let mut campaign = Self::require_open_campaign(&env, &campaign_id);
        let nullifier = Self::require_nullifier(&env, &caller, &campaign);
        Self::burn_nullifier(&env, &campaign_id, &nullifier, &mut campaign);

        let balance = Self::balance_of(&env, &caller) + campaign.amount;
        Self::set_balance(&env, &caller, balance);
        let amount = campaign.amount;
        let claims = campaign.claims;
        Self::put_campaign(&env, &campaign_id, &campaign);

        env.events().publish(
            (
                symbol_short!("humandrop"),
                symbol_short!("claimed"),
                campaign_id,
            ),
            EventClaimed {
                caller,
                nullifier: nullifier.clone(),
                amount,
                claims,
            },
        );

        nullifier
    }

    /// Consume `holder`'s one-shot claim in `campaign_id` **on behalf of an
    /// external distribution contract**, without paying anything out here.
    ///
    /// This is the integration point for your own airdrop/quota contract:
    ///
    /// ```ignore
    /// // inside YourAirdrop::claim(...)
    /// let gate = HumanAirdropClient::new(&env, &gate_address);
    /// let nullifier = gate.consume(
    ///     &env.current_contract_address(), // the consumer authorises itself
    ///     &campaign_id,
    ///     &holder,
    /// );
    /// // one-claim-per-human is now enforced; do your own payout.
    /// ```
    ///
    /// `consumer` must authorize the call, so only the contract (or account)
    /// being consumed *for* can burn a claim. Panics with `AlreadyClaimed` if
    /// this human already claimed in this campaign.
    #[allow(deprecated)]
    pub fn consume(
        env: Env,
        consumer: Address,
        campaign_id: Symbol,
        holder: Address,
    ) -> BytesN<32> {
        consumer.require_auth();

        let mut campaign = Self::require_open_campaign(&env, &campaign_id);
        let nullifier = Self::require_nullifier(&env, &holder, &campaign);
        Self::burn_nullifier(&env, &campaign_id, &nullifier, &mut campaign);
        let claims = campaign.claims;
        Self::put_campaign(&env, &campaign_id, &campaign);

        env.events().publish(
            (
                symbol_short!("humandrop"),
                symbol_short!("consumed"),
                campaign_id,
            ),
            EventConsumed {
                consumer,
                holder,
                nullifier: nullifier.clone(),
                claims,
            },
        );

        nullifier
    }

    /// Withdraw claimed funds from the demo ledger.
    pub fn withdraw(env: Env, caller: Address, amount: i128) {
        caller.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let balance = Self::balance_of(&env, &caller);
        if amount > balance {
            panic_with_error!(&env, Error::InsufficientBalance);
        }
        Self::set_balance(&env, &caller, balance - amount);
    }

    // ── Views ───────────────────────────────────────────────────────────────

    /// Has the nullifier already been consumed in this campaign?
    pub fn is_spent(env: Env, campaign_id: Symbol, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Spent(campaign_id, nullifier))
    }

    /// The per-campaign nullifier for `holder`, or `None` when `holder` has no
    /// valid credential for the campaign's requirement.
    pub fn nullifier_for(env: Env, campaign_id: Symbol, holder: Address) -> Option<BytesN<32>> {
        let campaign = Self::get_campaign(env.clone(), campaign_id)?;
        Self::nullifier(&env, &holder, &campaign)
    }

    /// Has *this human* (not merely this address) already claimed here?
    /// `false` when the holder has no valid credential — use
    /// [`HumanAirdrop::eligibility`] to tell those cases apart.
    pub fn has_claimed(env: Env, campaign_id: Symbol, holder: Address) -> bool {
        match Self::nullifier_for(env.clone(), campaign_id.clone(), holder) {
            Some(n) => Self::is_spent(env, campaign_id, n),
            None => false,
        }
    }

    /// Full, non-mutating pre-flight of [`HumanAirdrop::claim`].
    pub fn eligibility(env: Env, campaign_id: Symbol, holder: Address) -> Eligibility {
        let campaign = match Self::get_campaign(env.clone(), campaign_id.clone()) {
            Some(c) => c,
            None => return Eligibility::CampaignNotFound,
        };
        if !campaign.active {
            return Eligibility::CampaignInactive;
        }
        let now = env.ledger().timestamp();
        if now < campaign.start {
            return Eligibility::CampaignNotStarted;
        }
        if campaign.end != 0 && now >= campaign.end {
            return Eligibility::CampaignEnded;
        }
        if Self::exhausted(&campaign) {
            return Eligibility::BudgetExhausted;
        }
        match Self::nullifier(&env, &holder, &campaign) {
            None => Eligibility::NotVerifiedHuman,
            Some(n) => {
                if Self::is_spent(env, campaign_id, n) {
                    Eligibility::AlreadyClaimed
                } else {
                    Eligibility::Eligible
                }
            }
        }
    }

    pub fn get_campaign(env: Env, campaign_id: Symbol) -> Option<Campaign> {
        env.storage()
            .persistent()
            .get::<_, Campaign>(&DataKey::Campaign(campaign_id))
    }

    /// Unique humans that have claimed in this campaign.
    pub fn claims_count(env: Env, campaign_id: Symbol) -> u32 {
        Self::get_campaign(env, campaign_id)
            .map(|c| c.claims)
            .unwrap_or(0)
    }

    pub fn remaining_budget(env: Env, campaign_id: Symbol) -> i128 {
        Self::get_campaign(env, campaign_id)
            .map(|c| c.budget - c.distributed)
            .unwrap_or(0)
    }

    pub fn get_balance(env: Env, account: Address) -> i128 {
        Self::balance_of(&env, &account)
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    pub fn registry_address(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Registry)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    // ── Internals ───────────────────────────────────────────────────────────

    fn require_campaign(env: &Env, campaign_id: &Symbol) -> Campaign {
        env.storage()
            .persistent()
            .get::<_, Campaign>(&DataKey::Campaign(campaign_id.clone()))
            .unwrap_or_else(|| panic_with_error!(env, Error::CampaignNotFound))
    }

    /// Campaign that exists, is active, is inside its window and still has
    /// budget/claim headroom — or a precise panic explaining which of those
    /// failed.
    fn require_open_campaign(env: &Env, campaign_id: &Symbol) -> Campaign {
        let campaign = Self::require_campaign(env, campaign_id);
        if !campaign.active {
            panic_with_error!(env, Error::CampaignInactive);
        }
        let now = env.ledger().timestamp();
        if now < campaign.start {
            panic_with_error!(env, Error::CampaignNotStarted);
        }
        if campaign.end != 0 && now >= campaign.end {
            panic_with_error!(env, Error::CampaignEnded);
        }
        if Self::exhausted(&campaign) {
            panic_with_error!(env, Error::BudgetExhausted);
        }
        campaign
    }

    fn exhausted(campaign: &Campaign) -> bool {
        (campaign.max_claims != 0 && campaign.claims >= campaign.max_claims)
            || campaign.budget - campaign.distributed < campaign.amount
    }

    /// Ask the ProofRegistry for the holder's campaign-scoped nullifier. The
    /// registry only returns one when the underlying claim is currently valid
    /// (not revoked, not expired, issuer trusted, threshold met).
    fn nullifier(env: &Env, holder: &Address, campaign: &Campaign) -> Option<BytesN<32>> {
        let registry = RegistryClient::new(env, &Self::registry_address(env.clone()));
        registry.app_nullifier(
            holder,
            &campaign.credential_type,
            &campaign.scope,
            &campaign.min_threshold,
            &campaign.trusted_issuers,
        )
    }

    fn require_nullifier(env: &Env, holder: &Address, campaign: &Campaign) -> BytesN<32> {
        Self::nullifier(env, holder, campaign)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotVerifiedHuman))
    }

    /// The anti-Sybil stop: record the nullifier as spent for this campaign,
    /// rejecting a second claim by the same human through any address.
    fn burn_nullifier(
        env: &Env,
        campaign_id: &Symbol,
        nullifier: &BytesN<32>,
        campaign: &mut Campaign,
    ) {
        let key = DataKey::Spent(campaign_id.clone(), nullifier.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(env, Error::AlreadyClaimed);
        }
        env.storage().persistent().set(&key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, ENTRY_TTL);

        campaign.claims += 1;
        campaign.distributed += campaign.amount;
    }

    fn put_campaign(env: &Env, campaign_id: &Symbol, campaign: &Campaign) {
        let key = DataKey::Campaign(campaign_id.clone());
        env.storage().persistent().set(&key, campaign);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, ENTRY_TTL);
    }

    fn balance_of(env: &Env, account: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(account.clone()))
            .unwrap_or(0)
    }

    fn set_balance(env: &Env, account: &Address, balance: i128) {
        let key = DataKey::Balance(account.clone());
        env.storage().persistent().set(&key, &balance);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, ENTRY_TTL);
    }
}

mod test;
