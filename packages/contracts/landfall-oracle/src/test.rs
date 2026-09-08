#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events},
    xdr::{ContractEventBody, ScVal},
    Address, BytesN, Env,
};

fn setup() -> (Env, LandfallOracleClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(LandfallOracle, ());
    let client = LandfallOracleClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialise(&admin);
    (env, client, admin)
}

#[test]
fn initialises_with_an_admin_and_zero_epoch() {
    let (_, client, admin) = setup();
    assert_eq!(client.admin(), admin);
    assert_eq!(client.get_epoch(), 0);
    assert_eq!(client.get_digest(), None);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn cannot_initialise_twice() {
    let (env, client, _) = setup();
    // Silently re-keying a reputation oracle would be catastrophic; it must fail.
    client.initialise(&Address::generate(&env));
}

#[test]
fn publish_bumps_the_epoch_and_stores_the_digest() {
    let (env, client, _) = setup();
    let digest = BytesN::from_array(&env, &[7u8; 32]);

    assert_eq!(client.publish(&digest), 1);
    assert_eq!(client.get_epoch(), 1);
    assert_eq!(client.get_digest(), Some(digest.clone()));

    let second = BytesN::from_array(&env, &[9u8; 32]);
    assert_eq!(client.publish(&second), 2);
    assert_eq!(client.get_digest(), Some(second));
}

#[test]
fn stores_and_returns_a_score() {
    let (env, client, _) = setup();
    let account = Address::generate(&env);
    client.publish(&BytesN::from_array(&env, &[1u8; 32]));
    client.set_score(&account, &Liveness::Live, &1_700_000_000u64, &1327u32);

    let s = client.get_score(&account).unwrap();
    assert_eq!(s.state, Liveness::Live);
    assert_eq!(s.last_activity, 1_700_000_000);
    assert_eq!(s.sampled, 1327);
    assert_eq!(s.epoch, 1);
}

#[test]
fn unknown_account_has_no_score() {
    let (env, client, _) = setup();
    assert_eq!(client.get_score(&Address::generate(&env)), None);
}

#[test]
fn is_dark_is_false_for_an_unknown_account() {
    let (env, client, _) = setup();
    // Absence of a score is not evidence of dormancy. A caller must check
    // get_score() is Some before reading `false` as reassurance.
    assert!(!client.is_dark(&Address::generate(&env)));
}

#[test]
fn no_activity_is_not_dark() {
    let (env, client, _) = setup();
    let issuer = Address::generate(&env);
    // An issuer moves value through trustlines, so an empty payment history
    // is normal structure rather than dormancy.
    client.set_score(&issuer, &Liveness::NoActivity, &0u64, &0u32);
    assert!(!client.is_dark(&issuer));
    assert_eq!(client.get_score(&issuer).unwrap().state, Liveness::NoActivity);
}

#[test]
fn going_dark_emits_a_dark_event_once() {
    let (env, client, _) = setup();
    let account = Address::generate(&env);

    // count_topic reports the most recent invocation only, so each assertion
    // below is about the events of that one call. That is the sharper test
    // anyway: we care whether a given write emitted, not about a running total.
    client.set_score(&account, &Liveness::Live, &100u64, &10u32);
    assert_eq!(count_topic(&env, "dark"), 0, "no dark event while live");

    client.set_score(&account, &Liveness::Dark, &100u64, &10u32);
    assert_eq!(count_topic(&env, "dark"), 1, "transition into dark emits once");

    // Still dark on the next scan. The transition already fired, so this write
    // must stay quiet — consumers are woken by changes, not by steady state.
    client.set_score(&account, &Liveness::Dark, &100u64, &11u32);
    assert_eq!(count_topic(&env, "dark"), 0, "staying dark does not re-emit");
}

#[test]
fn recovering_then_going_dark_again_emits_a_second_event() {
    let (env, client, _) = setup();
    let account = Address::generate(&env);
    client.set_score(&account, &Liveness::Dark, &1u64, &5u32);
    assert_eq!(count_topic(&env, "dark"), 1, "first transition");
    client.set_score(&account, &Liveness::Live, &2u64, &5u32);
    assert_eq!(count_topic(&env, "dark"), 0, "recovery is not a dark event");
    client.set_score(&account, &Liveness::Dark, &3u64, &5u32);
    assert_eq!(count_topic(&env, "dark"), 1, "going dark again emits again");
}

#[test]
fn every_write_emits_a_score_event() {
    let (env, client, _) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.set_score(&a, &Liveness::Live, &1u64, &1u32);
    assert_eq!(count_topic(&env, "score"), 1);
    client.set_score(&b, &Liveness::Slow, &2u64, &2u32);
    assert_eq!(count_topic(&env, "score"), 1);
}

#[test]
fn tracked_accumulates_without_duplicates() {
    let (env, client, _) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.set_score(&a, &Liveness::Live, &1u64, &1u32);
    client.set_score(&a, &Liveness::Dark, &1u64, &1u32);
    client.set_score(&b, &Liveness::Live, &1u64, &1u32);
    assert_eq!(client.tracked().len(), 2);
}

#[test]
fn batch_writes_all_scores() {
    let (env, client, _) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let accounts = soroban_sdk::vec![&env, a.clone(), b.clone()];
    let scores = soroban_sdk::vec![
        &env,
        Score { state: Liveness::Dark, last_activity: 10, sampled: 62, epoch: 0, updated_at: 0 },
        Score { state: Liveness::Live, last_activity: 20, sampled: 745, epoch: 0, updated_at: 0 },
    ];
    client.set_scores(&accounts, &scores);

    // Count first. Every client call is an invocation, and events().all()
    // reports only the most recent one — a get_score() here would reset the
    // window to empty before we looked.
    assert_eq!(count_topic(&env, "score"), 2, "one score event per account");
    assert_eq!(count_topic(&env, "dark"), 1, "only the dark account transitions");

    assert_eq!(client.get_score(&a).unwrap().state, Liveness::Dark);
    assert_eq!(client.get_score(&b).unwrap().sampled, 745);
}

#[test]
fn batching_authorises_once_not_per_account() {
    // Regression. set_scores used to call the public set_score in a loop, so
    // require_auth ran twice in one frame and the host rejected it with
    // Error(Auth, ExistingValue) — the batch endpoint panicked every time it
    // was called on-chain. Authorisation now happens once, at the entry point.
    let (env, client, _) = setup();
    let accounts = soroban_sdk::vec![
        &env,
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env)
    ];
    let scores = soroban_sdk::vec![
        &env,
        Score { state: Liveness::Live, last_activity: 1, sampled: 1, epoch: 0, updated_at: 0 },
        Score { state: Liveness::Dark, last_activity: 2, sampled: 2, epoch: 0, updated_at: 0 },
        Score { state: Liveness::Slow, last_activity: 3, sampled: 3, epoch: 0, updated_at: 0 },
    ];
    client.set_scores(&accounts, &scores);
    assert_eq!(client.tracked().len(), 3);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn empty_batch_is_rejected() {
    let (env, client, _) = setup();
    client.set_scores(
        &soroban_sdk::vec![&env],
        &soroban_sdk::vec![&env],
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn mismatched_batch_lengths_are_rejected() {
    let (env, client, _) = setup();
    // Silently mis-assigning scores to accounts is worse than failing.
    client.set_scores(
        &soroban_sdk::vec![&env, Address::generate(&env), Address::generate(&env)],
        &soroban_sdk::vec![
            &env,
            Score { state: Liveness::Live, last_activity: 1, sampled: 1, epoch: 0, updated_at: 0 }
        ],
    );
}

#[test]
fn admin_can_be_transferred() {
    let (env, client, _) = setup();
    let next = Address::generate(&env);
    client.set_admin(&next);
    assert_eq!(client.admin(), next);
}

// -------------------------------------------------------------- helpers

/// Count emitted events whose first topic symbol matches `name`.
///
/// SDK 27 returns `ContractEvents`, which exposes the raw XDR slice rather
/// than an iterator of decoded tuples, so we read the topic off the wire.
fn count_topic(env: &Env, name: &str) -> u32 {
    env.events()
        .all()
        .events()
        .iter()
        .filter(|e| {
            let ContractEventBody::V0(v0) = &e.body;
            matches!(
                v0.topics.first(),
                Some(ScVal::Symbol(sym)) if sym.0.as_slice() == name.as_bytes()
            )
        })
        .count() as u32
}

// ---------------------------------------------------------------- roles
//
// The publisher/admin split exists because Soroban's built-in account
// contract always checks a Stellar account's MEDIUM threshold, so one
// address cannot have a lower bar for "write a score" than for "hand over
// the contract". While both shared a gate, the hourly CI key necessarily
// also held takeover authority.
//
// These tests use mock_auths rather than mock_all_auths on purpose:
// mock_all_auths makes every require_auth pass, which would make a
// privilege-escalation test silently vacuous — it would pass whether or not
// the split works.

use soroban_sdk::{testutils::MockAuth, testutils::MockAuthInvoke, IntoVal};

/// Admin and a separate publisher, with the publisher already installed.
fn setup_split() -> (Env, LandfallOracleClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(LandfallOracle, ());
    let client = LandfallOracleClient::new(&env, &id);
    let admin = Address::generate(&env);
    let publisher = Address::generate(&env);
    client.initialise(&admin);
    client.set_publisher(&publisher);
    (env, client, admin, publisher)
}

#[test]
fn publisher_defaults_to_the_admin_when_never_set() {
    // A contract deployed before DataKey::Publisher existed has no publisher
    // stored. It must keep working exactly as it did, not brick.
    let (_, client, admin) = setup();
    assert_eq!(client.publisher(), admin);
}

#[test]
fn admin_can_install_a_separate_publisher() {
    let (_, client, admin, publisher) = setup_split();
    assert_eq!(client.publisher(), publisher);
    assert_eq!(client.admin(), admin, "installing a publisher must not move admin");
}

#[test]
fn rotating_the_publisher_emits_the_handover() {
    // count_topic reports the most recent invocation's events, not a running
    // total — see recovering_then_going_dark_again_emits_a_second_event, which
    // asserts 1 / 0 / 1 for the same reason. So each rotation is checked for
    // its own event rather than for a cumulative count.
    let (env, client, _, _) = setup_split();
    assert_eq!(count_topic(&env, "set_publisher"), 1, "installing a publisher emits");

    client.set_publisher(&Address::generate(&env));
    assert_eq!(count_topic(&env, "set_publisher"), 1, "every rotation must be publicly visible");

    // A write must not masquerade as a role change.
    client.set_score(&Address::generate(&env), &Liveness::Live, &1u64, &1u32);
    assert_eq!(count_topic(&env, "set_publisher"), 0, "a score write is not a handover");
}

#[test]
fn the_publisher_alone_can_write_scores() {
    // The point of the split: a hot key that writes hourly, authorised by
    // nothing but itself.
    let (env, client, _, publisher) = setup_split();
    let account = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &publisher,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "set_score",
            args: (account.clone(), Liveness::Live, 100u64, 5u32).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.set_score(&account, &Liveness::Live, &100u64, &5u32);
    assert_eq!(client.get_score(&account).unwrap().sampled, 5);
}

#[test]
fn the_publisher_cannot_take_the_contract() {
    // The escalation this whole change exists to prevent. With only the
    // publisher's signature available, set_admin must fail.
    let (env, client, _, publisher) = setup_split();
    let attacker = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &publisher,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "set_admin",
            args: (attacker.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    assert!(
        client.try_set_admin(&attacker).is_err(),
        "a leaked hourly publishing key must never be able to hand over the oracle",
    );
}

#[test]
fn the_publisher_cannot_rotate_itself() {
    // A publisher that could reassign its own role would be an admin wearing
    // a different name, and the split would buy nothing.
    let (env, client, _, publisher) = setup_split();
    let attacker = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &publisher,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "set_publisher",
            args: (attacker.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    assert!(client.try_set_publisher(&attacker).is_err());
}

#[test]
fn the_admin_can_rotate_a_leaked_publisher() {
    // The recovery path. If the CI secret leaks, the cold admin closes the
    // window without the contract ever changing hands.
    let (env, client, admin, leaked) = setup_split();
    let fresh = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "set_publisher",
            args: (fresh.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.set_publisher(&fresh);

    assert_eq!(client.publisher(), fresh);
    assert_ne!(client.publisher(), leaked, "the leaked key must no longer be the publisher");
}

#[test]
fn a_rotated_out_publisher_can_no_longer_write() {
    let (env, client, _, leaked) = setup_split();
    let fresh = Address::generate(&env);
    client.set_publisher(&fresh); // still under mock_all_auths from setup_split

    let account = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &leaked,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "set_score",
            args: (account.clone(), Liveness::Live, 1u64, 1u32).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    assert!(
        client.try_set_score(&account, &Liveness::Live, &1u64, &1u32).is_err(),
        "rotation must actually revoke the old key, not merely add a new one",
    );
}

#[test]
fn the_publisher_can_publish_a_digest() {
    let (env, client, _, publisher) = setup_split();
    let digest = BytesN::from_array(&env, &[3u8; 32]);

    env.mock_auths(&[MockAuth {
        address: &publisher,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "publish",
            args: (digest.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    assert_eq!(client.publish(&digest), 1);
    assert_eq!(client.get_digest(), Some(digest));
}
