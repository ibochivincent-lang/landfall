#![cfg(test)]
extern crate std;
use std::{println, panic::{catch_unwind, AssertUnwindSafe}};
use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

/// True if a batch of `n` accounts, all transitioning into `state`, fits the
/// network's transaction resource limits. Uses catch_unwind because an
/// exceeded host limit panics rather than returning an error to the contract.
fn fits(n: u32, state: Liveness) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(LandfallOracle, ());
        let client = LandfallOracleClient::new(&env, &id);
        client.initialise(&Address::generate(&env));
        let mut accounts = soroban_sdk::Vec::new(&env);
        let mut scores = soroban_sdk::Vec::new(&env);
        for i in 0..n {
            accounts.push_back(Address::generate(&env));
            scores.push_back(Score {
                state, last_activity: 1_700_000_000 + i as u64,
                sampled: i, epoch: 0, updated_at: 0,
            });
        }
        client.set_scores(&accounts, &scores);
    })).is_ok()
}

#[test]
// Ignored by default: this is a diagnostic you run deliberately when
// changing MAX_BATCH or the events a write emits, not a regression test. It
// runs ~40 invocations and writes a test snapshot for each, which is noise in
// an ordinary `cargo test` and in CI.
//
//   cargo test probe_worst_case_ceiling -- --ignored --nocapture
#[ignore]
fn probe_worst_case_ceiling() {
    // Worst case: every account transitions into dark, emitting WentDark
    // alongside ScoreSet — two events per account instead of one.
    println!("\n  all-dark (2 events/account), does it fit?");
    for n in [20u32, 30, 35, 40, 45, 50] {
        println!("    n={n:<3} {}", if fits(n, Liveness::Dark) { "fits" } else { "EXCEEDS LIMIT" });
    }
    println!("\n  all-live (1 event/account), for comparison:");
    for n in [60u32, 70, 71, 80] {
        println!("    n={n:<3} {}", if fits(n, Liveness::Live) { "fits" } else { "EXCEEDS LIMIT" });
    }
    println!("\n  MAX_BATCH currently: {MAX_BATCH}\n");
}
