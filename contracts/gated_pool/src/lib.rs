#![no_std]
//! GatedPool
//!
//! A DeFi pool that gates **deposits** behind a valid KYC proof in the
//! ProofRegistry. Withdrawals are open to the authorized balance owner even
//! after their credential expires or is revoked.
//!
//! ### Real Token Transfer & Demo Modes
//! - **Real Token Transfer Mode**: When initialized with a token address
//!   (`token: Some(Address)`), `deposit` and `withdraw` perform real token
//!   transfers using the Soroban `token::Client`. The pool contract holds
//!   the deposited tokens. In `deposit`, tokens are transferred from caller to
//!   the pool before balance updates. In `withdraw`, tokens are transferred from
//!   the pool to the caller before reducing the balance. If any transfer fails
//!   (e.g., insufficient funds or authorization rejection), the transaction
//!   reverts immediately, preventing state divergence.
//! - **Reference Demo Mode**: When initialized with `token: None`, balances are
//!   tracked as a self-contained internal ledger without moving actual token
//!   value. This mode is explicitly intended for isolated reference demos.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    symbol_short, token, Address, Env, Symbol, Vec,
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
const CONTRACT_VERSION: u32 = 1_001_000; // 1.1.0 encoded as (major * 1000000) + (minor * 1000) + patch

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
    Token,
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
    /// `token` is an optional configured token contract address. When provided,
    /// real transfers are executed on deposits and withdrawals.
    pub fn __constructor(
        env: Env,
        registry: Address,
        required_type: Symbol,
        min_threshold: Option<u64>,
        token: Option<Address>,
    ) {
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage()
            .instance()
            .set(&DataKey::RequiredType, &required_type);
        env.storage()
            .instance()
            .set(&DataKey::MinThreshold, &min_threshold);
        if let Some(t) = token {
            env.storage().instance().set(&DataKey::Token, &t);
        }
    }

    /// Returns the contract version as an encoded u32.
    /// Encoding: (major * 1000000) + (minor * 1000) + patch
    /// Example: 1.2.3 -> 1002003
    pub fn version(env: Env) -> u32 {
        let _ = env; // Silence unused warning
        CONTRACT_VERSION
    }

    /// Deposit `amount`. Requires a currently-valid proof for the configured claim.
    /// If a token contract is configured, transfers `amount` from `caller` to the pool.
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

        // If real token is configured, perform transfer from caller to pool contract.
        // Transfer failure (e.g. insufficient funds) will panic and revert the transaction,
        // preventing the internal ledger balance from diverging.
        if let Some(token_addr) = env.storage().instance().get::<_, Address>(&DataKey::Token) {
            let token_client = token::Client::new(&env, &token_addr);
            token_client.transfer(&caller, &env.current_contract_address(), &amount);
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
    /// If a token contract is configured, transfers `amount` from the pool to `caller`.
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

        // If real token is configured, transfer from pool contract to caller.
        // Transfer failure will panic and revert the transaction, leaving caller balance intact.
        if let Some(token_addr) = env.storage().instance().get::<_, Address>(&DataKey::Token) {
            let token_client = token::Client::new(&env, &token_addr);
            token_client.transfer(&env.current_contract_address(), &caller, &amount);
        }

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

    pub fn token_address(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Token)
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
