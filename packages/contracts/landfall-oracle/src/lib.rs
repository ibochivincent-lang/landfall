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
    /// The address that signed this publication. Named `publisher` rather
    /// than `admin` since the write path split from the admin path — the
    /// hourly key that signs this is deliberately NOT the key that can
    /// hand over the contract.
    pub publisher: Address,
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

/// Publisher handover, emitted for the same reason as `AdminChanged`: the
/// hot key that writes scores hourly is the one most likely to be rotated
/// after a leak, and that rotation should be publicly visible.
#[contractevent(topics = ["set_publisher"])]
pub struct PublisherChanged {
    pub previous: Address,
    pub next: Address,
}

// ---------------------------------------------------------------- storage

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// Schema version of this contract's stored data. Unset means version 1 —
    /// what a contract deployed before this key existed reads as. See
    /// `storage_version` for why this exists in a contract that cannot be
    /// upgraded.
    StorageVersion,
    /// The address allowed to write scores and digests, but NOT to change
    /// either role. Unset means "same as Admin", which is what a contract
    /// deployed before this key existed reads as — see `require_publisher`.
    Publisher,
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

/// Schema version of the stored data.
///
/// Bumped when the *shape* of anything in storage changes — a new field on
/// `Score`, a repurposed `DataKey` — never for a behaviour change that leaves
/// storage alone. A consumer reads it to know whether it understands what it
/// is decoding, instead of discovering a mismatch as a malformed value.
const STORAGE_VERSION: u32 = 1;

/// Bounded so a single publication cannot exceed the network's transaction
/// resource limits and strand the oracle mid-update.
///
/// **Measured, not guessed — and the original 100 was wrong.** The binding
/// limit is not CPU, it is the 16 KiB cap on contract event size. Each
/// account emits a `ScoreSet`; an account transitioning into dark emits a
/// `WentDark` as well. Measured against the host in `src/bench_probe.rs`:
///
///   all-live (1 event/account):  70 fits, 71 exceeds
///   all-dark (2 events/account): 35 fits, 40 exceeds
///
/// So a full batch of 100 would have failed on a real network in every mix,
/// and a batch sized for the average would fail exactly when it mattered
/// most — the scan where a whole anchor's fleet goes dark at once is both
/// the worst case for event size and the one nobody can afford to lose.
///
/// 25 is the worst case (35) with roughly 30% headroom. The headroom is not
/// timidity: this contract has no upgrade path, so if a future protocol
/// version raises per-event costs there is no way to lower this number on a
/// deployed contract. Sizing for the worst case at the widest margin the
/// throughput can absorb is the only correction available in advance.
///
/// Cost of the change: 108 tracked accounts become 5 batches rather than 2.
const MAX_BATCH: u32 = 25;

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
        env.storage().instance().set(&DataKey::StorageVersion, &STORAGE_VERSION);
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
        let publisher = Self::require_publisher(&env);

        let epoch: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Epoch)
            .unwrap_or(0)
            + 1;

        env.storage().instance().set(&DataKey::Digest, &digest);
        env.storage().instance().set(&DataKey::Epoch, &epoch);
        Self::bump(&env);

        Published { epoch, digest, publisher }.publish(&env);

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
        Self::require_publisher(&env);
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
        Self::require_publisher(&env);
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

    /// The address currently allowed to write scores and digests. Falls back
    /// to the admin when no publisher has been set, matching
    /// `require_publisher`, so this getter never disagrees with the gate.
    pub fn publisher(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Publisher)
            .or_else(|| env.storage().instance().get(&DataKey::Admin))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialised))
    }

    /// Schema version of the stored data.
    ///
    /// **This contract has no upgrade path, deliberately.** There is no
    /// `update_current_contract_wasm` here and there is not going to be one.
    /// An admin who can replace the bytecode can redefine what `publish`
    /// means — a strictly larger power than writing a wrong score, and
    /// undetectable from the outside without diffing Wasm hashes. For a
    /// contract whose entire purpose is being a tamper-resistant reputation
    /// record, upgradeability would hand back the property it exists to
    /// provide. See docs/TRUST.md.
    ///
    /// So this version is not a migration marker. It is a compatibility
    /// declaration: a new schema means a **new deployment at a new address**,
    /// and consumers move to it deliberately rather than waking up to
    /// different semantics at the same address. Reading it lets a consumer
    /// refuse to decode a version it does not understand.
    ///
    /// Returns 1 for a contract deployed before this key existed.
    pub fn storage_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::StorageVersion)
            .unwrap_or(1)
    }

    /// Hand the oracle to a new admin. Emits so the change is publicly visible
    /// in the event stream rather than only in contract state.
    pub fn set_admin(env: Env, new_admin: Address) {
        let current = Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        AdminChanged { previous: current, next: new_admin }.publish(&env);
    }

    /// Rotate the publishing key. **Admin only** — a publisher that could
    /// reassign its own role would be an admin wearing a different name, and
    /// the split would buy nothing.
    ///
    /// This is the recovery path for the hot key: if the CI secret leaks, the
    /// cold admin rotates it here, and the attacker's window closes without
    /// the contract ever changing hands.
    pub fn set_publisher(env: Env, new_publisher: Address) {
        Self::require_admin(&env);
        let previous = Self::publisher(env.clone());
        env.storage().instance().set(&DataKey::Publisher, &new_publisher);
        PublisherChanged { previous, next: new_publisher }.publish(&env);
    }

    // ------------------------------------------------------------ internal

    /// Authorises a role change. Deliberately separate from
    /// `require_publisher` — see that function for why the split exists.
    fn require_admin(env: &Env) -> Address {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialised));
        admin.require_auth();
        admin
    }

    /// Authorises a data write.
    ///
    /// This split is the whole point of the two-role design. Soroban's
    /// built-in account contract always checks a Stellar account's **medium**
    /// threshold, so one address cannot have a lower bar for "write a score"
    /// than for "hand the contract to someone else". While `publish`,
    /// `set_scores` and `set_admin` shared a gate, the hourly CI key
    /// necessarily also held takeover authority — and making that key
    /// multisig to fix it would have stopped the hourly publish, since CI
    /// signs with one key.
    ///
    /// Splitting the roles lets the publisher stay a single hot key whose
    /// worst case is writing bad scores (visible in the event stream,
    /// recomputable from Horizon, correctable by the admin) while the admin
    /// becomes a cold multisig account that never has to sign hourly.
    ///
    /// Falls back to the admin when no publisher is set, so a contract
    /// deployed before this key existed keeps working exactly as it did.
    fn require_publisher(env: &Env) -> Address {
        let publisher: Address = env
            .storage()
            .instance()
            .get(&DataKey::Publisher)
            .or_else(|| env.storage().instance().get(&DataKey::Admin))
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialised));
        publisher.require_auth();
        publisher
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

mod bench;

mod bench_probe;
