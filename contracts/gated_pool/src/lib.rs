#![no_std]
//! GatedPool (demo)
//!
//! A mock DeFi pool that gates **deposits** behind a valid KYC proof in the
//! ProofRegistry. Withdrawals are open to the authorized balance owner even
//! after their credential expires or is revoked. This is the contract that
//! makes the demo concrete: same call, two outcomes — "Access Denied" without
//! a proof, "Access Granted" after one is submitted.
//!
//! Balances are tracked as a plain ledger here (no real token transfer) to keep
//! the demo self-contained; swap in a token client for production.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Env, Symbol, Vec,
};

// ── Event payload structs ───────────────────────────────────────────────────

/// Payload emitted when a caller successfully deposits into the gated pool.
/// Topics: (symbol_short!("gate_pool"), symbol_short!("deposit"))
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventDeposit {
    pub caller: Address,
    pub amount: i128,
    pub new_balance: i128,
}

/// Payload emitted when a caller successfully withdraws from the gated pool.
/// Topics: (symbol_short!("gate_pool"), symbol_short!("withdraw"))
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventWithdraw {
    pub caller: Address,
    pub amount: i128,
    pub new_balance: i128,
}

// Persistent-entry lifetime management (~5s ledgers).
const DAY_IN_LEDGERS: u32 = 17280;
const BALANCE_BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const BALANCE_TTL: u32 = 120 * DAY_IN_LEDGERS;

// ── Contract versioning ──────────────────────────────────────────────────────
// Semantic version: MAJOR.MINOR.PATCH
// Increment MAJOR on breaking changes (new entry points, changed ABI)
// Increment MINOR on additive changes (new events, new query endpoints)
// Increment PATCH on bug fixes with no ABI changes
const CONTRACT_VERSION: u32 = 1_000_000; // 1.0.0 encoded as (major * 1000000) + (minor * 1000) + patch

/// Typed client for the deployed ProofRegistry contract. Declared as an
/// interface so this contract links only the client, not the registry's
/// exported wasm symbols.
#[contractclient(name = "RegistryClient")]
pub trait RegistryInterface {
    fn check_claim(
        env: Env,
        holder: Address,
        credential_type: Symbol,
        min_threshold: Option<u64>,
        trusted_issuers: Option<Vec<Address>>,
    ) -> bool;
}

#[contracttype]
pub enum DataKey {
    Registry,
    RequiredType,
    MinThreshold,
    Balance(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    NotKycVerified = 2,
    InvalidAmount = 3,
    InsufficientBalance = 4,
}

#[contract]
pub struct GatedPool;

#[contractimpl]
impl GatedPool {
    /// `registry` is the deployed ProofRegistry contract address.
    pub fn __constructor(
        env: Env,
        registry: Address,
        required_type: Symbol,
        min_threshold: Option<u64>,
    ) {
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage()
            .instance()
            .set(&DataKey::RequiredType, &required_type);
        env.storage()
            .instance()
            .set(&DataKey::MinThreshold, &min_threshold);
    }

    /// Returns the contract version as an encoded u32.
    /// Encoding: (major * 1000000) + (minor * 1000) + patch
    /// Example: 1.2.3 -> 1002003
    pub fn version(env: Env) -> u32 {
        let _ = env; // Silence unused warning
        CONTRACT_VERSION
    }

    /// Deposit `amount`. Requires a currently-valid proof for the configured claim.
    #[allow(deprecated)]
    pub fn deposit(env: Env, caller: Address, amount: i128) {
        caller.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }

        let registry = RegistryClient::new(&env, &Self::registry(&env));
        let verified = registry.check_claim(
            &caller,
            &Self::required_type(&env),
            &Self::min_threshold(&env),
            &None,
        );
        if !verified {
            panic_with_error!(&env, Error::NotKycVerified);
        }

        let balance = Self::balance_of(&env, &caller) + amount;
        Self::set_balance(&env, &caller, balance);

        env.events().publish(
            (symbol_short!("gate_pool"), symbol_short!("deposit")),
            EventDeposit {
                caller,
                amount,
                new_balance: balance,
            },
        );
    }

    /// Withdraw `amount` from the caller's balance.
    ///
    /// Withdrawal does not require a current credential: a holder retains
    /// access to their own funds after the credential used for deposit expires
    /// or is revoked. The caller must still authorize the operation, provide a
    /// positive amount, and stay within their recorded balance.
    #[allow(deprecated)]
    pub fn withdraw(env: Env, caller: Address, amount: i128) {
        caller.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let balance = Self::balance_of(&env, &caller);
        if amount > balance {
            panic_with_error!(&env, Error::InsufficientBalance);
        }
        let remaining = balance
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with_error!(&env, Error::InsufficientBalance));
        Self::set_balance(&env, &caller, remaining);

        env.events().publish(
            (symbol_short!("gate_pool"), symbol_short!("withdraw")),
            EventWithdraw {
                caller,
                amount,
                new_balance: remaining,
            },
        );
    }

    pub fn get_balance(env: Env, account: Address) -> i128 {
        Self::balance_of(&env, &account)
    }

    pub fn registry_address(env: Env) -> Address {
        Self::registry(&env)
    }

    pub fn gate(env: Env) -> (Symbol, Option<u64>) {
        (Self::required_type(&env), Self::min_threshold(&env))
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
            .extend_ttl(&key, BALANCE_BUMP_THRESHOLD, BALANCE_TTL);
    }

    fn registry(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Registry)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }

    fn required_type(env: &Env) -> Symbol {
        env.storage()
            .instance()
            .get(&DataKey::RequiredType)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }

    fn min_threshold(env: &Env) -> Option<u64> {
        env.storage()
            .instance()
            .get(&DataKey::MinThreshold)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }
}

#[cfg(test)]
mod test;
