#![no_std]
//! # Landfall oracle
//!
//! Publishes settlement-quality digests for Stellar anchors on-chain, so that
//! other contracts can route on the same data a wallet reads from the API.
//!
//! ## What this contract deliberately does not do
//!
//! It does not store the dataset. It stores a **digest** of the dataset plus a
//! small liveness state per account. The full record stays off-chain where it
//! is cheap, and anyone can re-derive the digest from the published data to
//! prove the two agree. An oracle that asks you to trust it has missed the
//! point of being an oracle.
//!
//! It also does not move value, so it emits no CAP-67 asset events. CAP-67
//! standardises `transfer` / `mint` / `burn` / `clawback` for asset movement;
//! faking those topics for a scoring update would corrupt exactly the event
//! stream this project depends on. What we do instead is follow the same
//! convention — a symbol topic first, structured data after — so a CAP-67-aware
//! indexer can consume our events with the same machinery.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    Address, BytesN, Env, Vec,
};

// ---------------------------------------------------------------- events
//
// Declared with #[contractevent] so the topic symbols and data shape are part
// of the contract spec rather than string literals scattered through the
// implementation. An indexer generates its decoder from the spec instead of
// guessing, which is the same reason CAP-67 standardised asset events.

/// Emitted once, at initialisation.
#[contractevent(topics = ["init"])]
pub struct Initialised {
    pub admin: Address,
}

/// A new dataset digest. Consumers watch this to know a fresh scan exists
/// without polling the API.
#[contractevent(topics = ["publish"])]
pub struct Published {
    #[topic]
    pub epoch: u64,
    pub digest: BytesN<32>,
    pub admin: Address,
}

/// Emitted on every score write.
#[contractevent(topics = ["score"])]
pub struct ScoreSet {
    #[topic]
    pub account: Address,
    pub state: Liveness,
    pub last_activity: u64,
    pub sampled: u32,
    pub epoch: u64,
}

/// Emitted only on the transition into dormancy. The change is what a
/// consumer needs waking up for; the steady state is not.
#[contractevent(topics = ["dark"])]
pub struct WentDark {
    #[topic]
    pub account: Address,
    pub last_activity: u64,
    pub epoch: u64,
}

/// Admin handover, emitted so the change is visible in the public event
/// stream and not only in contract state.
#[contractevent(topics = ["set_admin"])]
pub struct AdminChanged {
    pub previous: Address,
    pub next: Address,
}

// ---------------------------------------------------------------- storage

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// sha256 of the most recently published dataset.
    Digest,
    /// Monotonic publication counter, so consumers can detect a missed update.
    Epoch,
    /// Per-account score.
    Score(Address),
    /// Every account the oracle has ever scored.
    Tracked,
}

/// Liveness, mirroring the off-chain classification exactly.
///
/// `NoActivity` is not `Dark`. An issuer account moves value through
/// trustlines rather than payments, so an empty payment history is normal
/// structure, not dormancy. Collapsing the two manufactures a finding.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Liveness {
    Live = 0,
    Slow = 1,
    Dark = 2,
    NoActivity = 3,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub struct Score {
    pub state: Liveness,
    /// Ledger timestamp of the account's last on-chain settlement.
    /// Zero when the account has no payment history at all.
    pub last_activity: u64,
    /// Records behind the classification. Consumers should treat a thin
    /// sample with suspicion rather than trusting the label alone.
    pub sampled: u32,
    /// Epoch this score was written in.
    pub epoch: u64,
    pub updated_at: u64,
}

// ---------------------------------------------------------------- errors

#[contracterror]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialised = 1,
    NotInitialised = 2,
    NotAuthorised = 3,
    EmptyBatch = 4,
    TooManyAccounts = 5,
}

/// Bounded so a single publication cannot exceed the resource limits and
/// strand the oracle mid-update.
const MAX_BATCH: u32 = 100;

const TTL_THRESHOLD: u32 = 30 * 17_280; // ~30 days of ledgers
const TTL_EXTEND: u32 = 90 * 17_280;    // extend to ~90 days

// ---------------------------------------------------------------- contract

#[contract]
pub struct LandfallOracle;

#[contractimpl]
impl LandfallOracle {
    /// One-time setup. Fails loudly rather than silently re-keying, because a
    /// silent admin change on a reputation oracle is the whole ballgame.
    pub fn initialise(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialised);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Epoch, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::Tracked, &Vec::<Address>::new(&env));

        Initialised { admin }.publish(&env);
    }

    /// Publish a new dataset digest and bump the epoch.
    ///
    /// Emits `("publish", epoch)` with the digest, so an indexer can notice a
    /// new dataset without polling the API.
    pub fn publish(env: Env, digest: BytesN<32>) -> u64 {
        let admin = Self::require_admin(&env);

        let epoch: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Epoch)
            .unwrap_or(0)
            + 1;

        env.storage().instance().set(&DataKey::Digest, &digest);
        env.storage().instance().set(&DataKey::Epoch, &epoch);
        Self::bump(&env);

        Published { epoch, digest, admin }.publish(&env);

        epoch
    }

    /// Write one account's score.
    ///
    /// Emits `("score", account)` on every write, and additionally
    /// `("dark", account)` when an account crosses into dormancy — the
    /// transition is the thing worth waking a consumer up for, not the
    /// steady state.
    pub fn set_score(
        env: Env,
        account: Address,
        state: Liveness,
        last_activity: u64,
        sampled: u32,
    ) {
        Self::require_admin(&env);
        Self::write_score(&env, &account, state, last_activity, sampled);
    }

    /// Shared writer. Deliberately does NOT authorise.
    ///
    /// `require_auth` may only be called once per frame — a second call in the
    /// same invocation fails with Error(Auth, ExistingValue). Batching used to
    /// re-enter the public `set_score`, which made `set_scores` panic on-chain
    /// every time. Authorisation belongs at the entry point, once.
    fn write_score(
        env: &Env,
        account: &Address,
        state: Liveness,
        last_activity: u64,
        sampled: u32,
    ) {
        let epoch: u64 = env.storage().instance().get(&DataKey::Epoch).unwrap_or(0);

        let previous: Option<Score> = env
            .storage()
            .persistent()
            .get(&DataKey::Score(account.clone()));

        let score = Score {
            state,
            last_activity,
            sampled,
            epoch,
            updated_at: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Score(account.clone()), &score);
        env.storage().persistent().extend_ttl(
            &DataKey::Score(account.clone()),
            TTL_THRESHOLD,
            TTL_EXTEND,
        );

        Self::track(env, account);

        ScoreSet {
            account: account.clone(),
            state,
            last_activity,
            sampled,
            epoch,
        }
        .publish(env);

        let was_dark = matches!(previous.as_ref().map(|p| p.state), Some(Liveness::Dark));
        if state == Liveness::Dark && !was_dark {
            WentDark { account: account.clone(), last_activity, epoch }.publish(env);
        }
    }

    /// Write a batch in one transaction. Same events as `set_score`.
    pub fn set_scores(env: Env, accounts: Vec<Address>, scores: Vec<Score>) {
        Self::require_admin(&env);
        if accounts.is_empty() {
            panic_with_error!(&env, Error::EmptyBatch);
        }
        if accounts.len() > MAX_BATCH {
            panic_with_error!(&env, Error::TooManyAccounts);
        }
        // A mismatched pair would silently mis-assign scores to accounts,
        // which on a reputation oracle is worse than failing.
        if accounts.len() != scores.len() {
            panic_with_error!(&env, Error::EmptyBatch);
        }

        for i in 0..accounts.len() {
            let account = accounts.get(i).unwrap();
            let s = scores.get(i).unwrap();
            Self::write_score(&env, &account, s.state, s.last_activity, s.sampled);
        }
    }

    // ------------------------------------------------------------ reads

    pub fn get_score(env: Env, account: Address) -> Option<Score> {
        env.storage().persistent().get(&DataKey::Score(account))
    }

    pub fn get_digest(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::Digest)
    }

    pub fn get_epoch(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::Epoch).unwrap_or(0)
    }

    pub fn tracked(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Tracked)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Convenience for routing contracts: is this account currently dark?
    /// Returns false for an unknown account — absence of a score is not
    /// evidence of dormancy, and a caller should check `get_score` is `Some`
    /// before treating a `false` as reassurance.
    pub fn is_dark(env: Env, account: Address) -> bool {
        matches!(
            env.storage()
                .persistent()
                .get::<DataKey, Score>(&DataKey::Score(account))
                .map(|s| s.state),
            Some(Liveness::Dark)
        )
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialised))
    }

    /// Hand the oracle to a new admin. Emits so the change is publicly visible
    /// in the event stream rather than only in contract state.
    pub fn set_admin(env: Env, new_admin: Address) {
        let current = Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        AdminChanged { previous: current, next: new_admin }.publish(&env);
    }

    // ------------------------------------------------------------ internal

    fn require_admin(env: &Env) -> Address {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialised));
        admin.require_auth();
        admin
    }

    fn track(env: &Env, account: &Address) {
        let mut tracked: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Tracked)
            .unwrap_or_else(|| Vec::new(env));
        if !tracked.contains(account) {
            tracked.push_back(account.clone());
            env.storage().instance().set(&DataKey::Tracked, &tracked);
        }
    }

    fn bump(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
    }
}

#[cfg(test)]
mod test;
