#![no_std]
//! GatedPool (demo)
//!
//! A mock DeFi pool that gates **deposits** behind a valid KYC proof in the
//! ProofRegistry. Withdrawals are open. This is the contract that makes the demo
//! concrete: same call, two outcomes — "Access Denied" without a proof, "Access
//! Granted" after one is submitted.
//!
//! Balances are tracked as a plain ledger here (no real token transfer) to keep
//! the demo self-contained; swap in a token client for production.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Env, Symbol, Vec,
};

// Persistent-entry lifetime management (~5s ledgers).
const DAY_IN_LEDGERS: u32 = 17280;
const BALANCE_BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const BALANCE_TTL: u32 = 120 * DAY_IN_LEDGERS;

/// Typed client for the deployed ProofRegistry contract. Declared as an
/// interface so this contract links only the client, not the registry's
/// exported wasm symbols.
#[contractclient(name = "RegistryClient")]
pub trait RegistryInterface {
    fn is_verified(
        env: Env,
        holder: Address,
        credential_type: Symbol,
        trusted_issuers: Option<Vec<Address>>,
    ) -> (bool, u64, u64);
}

#[contracttype]
pub enum DataKey {
    Registry,
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
    pub fn __constructor(env: Env, registry: Address) {
        env.storage().instance().set(&DataKey::Registry, &registry);
    }

    /// Deposit `amount`. Requires a currently-valid KYC proof for `caller`.
    pub fn deposit(env: Env, caller: Address, amount: i128) {
        caller.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }

        let registry = RegistryClient::new(&env, &Self::registry(&env));
        let (verified, _at, _expiry) = registry.is_verified(&caller, &symbol_short!("kyc"), &None);
        if !verified {
            panic_with_error!(&env, Error::NotKycVerified);
        }

        let balance = Self::balance_of(&env, &caller) + amount;
        Self::set_balance(&env, &caller, balance);
    }

    /// Withdraw `amount`. Open — no proof required.
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

    pub fn get_balance(env: Env, account: Address) -> i128 {
        Self::balance_of(&env, &account)
    }

    pub fn registry_address(env: Env) -> Address {
        Self::registry(&env)
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
}

mod test;
