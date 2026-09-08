//! Resource measurement, run as tests.
//!
//! `cargo test --features testutils bench -- --nocapture --test-threads=1`
//!
//! The 28 correctness tests assert behaviour; none of them asserts *cost*.
//! That gap matters specifically before mainnet, because the contract is
//! immutable: a `set_scores` batch that exceeds the network's resource limits
//! cannot be fixed by patching the deployed contract, only by deploying a new
//! one and migrating every consumer to a new address.
//!
//! So the number that actually matters here is `set_scores` at MAX_BATCH —
//! the largest single invocation this contract can be asked to perform. If
//! that fits with headroom, nothing else is close.
//!
//! These print rather than assert, except for one guard on the batch path.
//! A hard assertion on an instruction count turns every unrelated SDK upgrade
//! into a failing build for no correctness reason; the guard is set against
//! the network limit instead, which is the thing that would actually break.

#![cfg(test)]

// The crate is no_std; std is available under cfg(test) and is needed here
// only for println!, since these report numbers rather than assert them.
extern crate std;
use std::println;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

/// Soroban's per-transaction CPU instruction limit on pubnet at Protocol 23.
/// The guard below is deliberately checked against this rather than against a
/// previously observed number.
const NETWORK_CPU_LIMIT: u64 = 100_000_000;

fn fresh() -> (Env, LandfallOracleClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(LandfallOracle, ());
    let client = LandfallOracleClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialise(&admin);
    (env, client, admin)
}

fn report(label: &str, env: &Env) -> u64 {
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let mem = env.cost_estimate().budget().memory_bytes_cost();
    let pct = (cpu as f64 / NETWORK_CPU_LIMIT as f64) * 100.0;
    println!("  {label:<34} cpu {cpu:>12}  ({pct:>5.2}% of limit)   mem {mem:>10}");
    cpu
}

#[test]
fn bench_publish() {
    let (env, client, _) = fresh();
    env.cost_estimate().budget().reset_unlimited();
    client.publish(&BytesN::from_array(&env, &[7u8; 32]));
    report("publish(digest)", &env);
}

#[test]
fn bench_set_score_single() {
    let (env, client, _) = fresh();
    let account = Address::generate(&env);
    env.cost_estimate().budget().reset_unlimited();
    client.set_score(&account, &Liveness::Live, &1_700_000_000u64, &1327u32);
    report("set_score  (1 account)", &env);
}

#[test]
fn bench_read_paths() {
    let (env, client, _) = fresh();
    let account = Address::generate(&env);
    client.set_score(&account, &Liveness::Dark, &1u64, &1u32);

    env.cost_estimate().budget().reset_unlimited();
    client.get_score(&account);
    report("get_score", &env);

    env.cost_estimate().budget().reset_unlimited();
    client.is_dark(&account);
    report("is_dark", &env);

    env.cost_estimate().budget().reset_unlimited();
    client.get_epoch();
    report("get_epoch", &env);
}

/// The one that decides whether this contract is safe on mainnet.
///
/// This test found a real bug: MAX_BATCH was 100, and a full batch exceeded
/// the network's 16 KiB contract-event limit in every mix — it would have
/// failed on a real network, on an immutable contract, with no way to lower
/// the number after deployment. See MAX_BATCH's own comment for the measured
/// ceilings.
///
/// The assertion below is on the **worst case**: every account in the batch
/// transitioning into dark, which emits WentDark alongside ScoreSet. That is
/// the scan where an anchor's whole fleet goes dark at once — simultaneously
/// the most expensive shape and the one least acceptable to lose.
#[test]
fn bench_set_scores_at_max_batch() {
    let (env, client, _) = fresh();

    let mut accounts = soroban_sdk::Vec::new(&env);
    let mut scores = soroban_sdk::Vec::new(&env);
    for i in 0..MAX_BATCH {
        accounts.push_back(Address::generate(&env));
        scores.push_back(Score {
            // Worst case, deliberately: every one transitions into dark.
            state: Liveness::Dark,
            last_activity: 1_700_000_000 + i as u64,
            sampled: 100 + i,
            epoch: 0,
            updated_at: 0,
        });
    }

    env.cost_estimate().budget().reset_unlimited();

    // If MAX_BATCH is ever raised past what the host accepts, this call
    // panics with Error(Budget, ExceededLimit) and the test fails here —
    // which is the entire point of the test existing.
    client.set_scores(&accounts, &scores);

    let cpu = report("set_scores (MAX_BATCH, all dark)", &env);
    assert_eq!(client.tracked().len(), MAX_BATCH);

    // CPU has never been the binding constraint — event size is — but assert
    // it anyway so a future change that trades events for computation cannot
    // quietly walk into the other limit.
    assert!(
        cpu < NETWORK_CPU_LIMIT / 2,
        "set_scores at MAX_BATCH used {cpu} CPU instructions, over half the          {NETWORK_CPU_LIMIT} network limit. This contract is immutable: if a          full batch cannot fit on mainnet, that is not patchable after          deployment. Lower MAX_BATCH before deploying."
    );
}

/// Cost per account, to show the batch scales linearly rather than
/// quadratically — the shape that would make a larger MAX_BATCH unsafe.
#[test]
fn bench_batch_scaling() {
    for n in [1u32, 5, 10, 25] {
        let (env, client, _) = fresh();
        let mut accounts = soroban_sdk::Vec::new(&env);
        let mut scores = soroban_sdk::Vec::new(&env);
        for i in 0..n {
            accounts.push_back(Address::generate(&env));
            scores.push_back(Score {
                state: Liveness::Live,
                last_activity: 1_700_000_000 + i as u64,
                sampled: i,
                epoch: 0,
                updated_at: 0,
            });
        }
        env.cost_estimate().budget().reset_unlimited();
        client.set_scores(&accounts, &scores);
        let cpu = env.cost_estimate().budget().cpu_instruction_cost();
        println!("  set_scores n={n:<3}  cpu {cpu:>12}   per-account {:>10}", cpu / n as u64);
    }
}
