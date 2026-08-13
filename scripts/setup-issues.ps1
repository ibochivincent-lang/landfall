<#
    Landfall - create labels and file the backlog as GitHub issues.

    Run once, from the repo root, after pushing:

        gh auth status
        .\scripts\setup-issues.ps1 -WhatIf     # preview
        .\scripts\setup-issues.ps1             # for real

    Labels are idempotent (--force). Issues are NOT - running twice files
    duplicates, so the script refuses if the repo already has any.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$Repo = "")

# NOT 'Stop'. With 'Stop', PowerShell turns anything a native command writes
# to stderr into a TERMINATING error, even when the command succeeded and
# exited 0. `gh` writes progress and rate-limit
# warnings there routinely, and dying midway through would leave the tracker
# half-populated - the worst possible state to resume from.
# stderr is not an error signal; the exit code is, and it is checked below.
$ErrorActionPreference = 'Continue'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI not found. Install it, or file the issues by hand from docs/backlog.md."
}
if (-not $Repo) {
    $Repo = (gh repo view --json nameWithOwner --jq .nameWithOwner) 2>$null
    if (-not $Repo) { throw "Could not detect the repo. Pass -Repo owner/name." }
}

Write-Host "Repo:    $Repo"
Write-Host "Account: $(gh api user --jq .login)"
Write-Host ""

$existing = (gh issue list --repo $Repo --state all --limit 200 --json title --jq '.[].title')
if ($existing) {
    Write-Warning "This repo already has issues. Filing again creates duplicates."
    if ((Read-Host "Type 'yes' to continue") -ne "yes") { Write-Host "Aborted."; exit 0 }
}

# ---- labels ---------------------------------------------------------------
# "good first issue" and "help wanted" use GitHub's canonical spelling with
# spaces. The hyphenated variants do not appear in GitHub's Contribute tab or
# its new-contributor discovery, which is exactly where beginners look.

$labels = @(
    @{ name = "Stellar Wave"; color = "5319E7"; desc = "In scope for the current Drips Stellar Wave cycle" }
    @{ name = "good first issue"; color = "7057FF"; desc = "Scoped, unblocked and reviewer-ready" }
    @{ name = "help wanted"; color = "008672"; desc = "Larger ticket actively looking for an owner" }
    @{ name = "type:feat"; color = "0E8A16"; desc = "New capability" }
    @{ name = "type:bug"; color = "D73A4A"; desc = "Something behaves incorrectly" }
    @{ name = "type:docs"; color = "0075CA"; desc = "Documentation only" }
    @{ name = "type:chore"; color = "CFD3D7"; desc = "Tooling, build, housekeeping" }
    @{ name = "type:test"; color = "BFD4F2"; desc = "Tests only" }
    @{ name = "type:data-dispute"; color = "E99695"; desc = "A published figure is challenged" }
    @{ name = "trivial-100"; color = "C2E0C6"; desc = "Drips Wave: 100 points" }
    @{ name = "medium-150"; color = "FBCA04"; desc = "Drips Wave: 150 points" }
    @{ name = "high-200"; color = "D93F0B"; desc = "Drips Wave: 200 points" }
    @{ name = "module/indexer"; color = "1D76DB"; desc = "Ledger reading and data collection" }
    @{ name = "module/metrics"; color = "1D76DB"; desc = "Metric computation and correctness" }
    @{ name = "module/api"; color = "1D76DB"; desc = "HTTP API" }
    @{ name = "module/sdk"; color = "1D76DB"; desc = "SDK and integrations" }
    @{ name = "module/soroban"; color = "1D76DB"; desc = "On-chain oracle contract" }
    @{ name = "module/cli"; color = "1D76DB"; desc = "Command line interface" }
    @{ name = "module/site"; color = "1D76DB"; desc = "The public site" }
    @{ name = "module/docs"; color = "1D76DB"; desc = "Project documentation" }
)

Write-Host "Creating labels..."
foreach ($l in $labels) {
    if ($PSCmdlet.ShouldProcess($l.name, "create label")) {
        gh label create $l.name --repo $Repo --color $l.color --description $l.desc --force | Out-Null
        Write-Host "  $($l.name)"
    }
}
Write-Host ""

# ---- issues ---------------------------------------------------------------

function Body($scope, $acceptance, $notes) {
    $t = "## Scope`n`n$scope`n`n## Acceptance`n`n$acceptance`n"
    if ($notes) { $t += "`n## Notes`n`n$notes`n" }
    $t += "`n---`n`nSetup and the project invariants: [CONTRIBUTING.md](CONTRIBUTING.md). " +
          "The whole stack runs with ``docker compose up``. " +
          "**Comment to ask for this issue and wait to be assigned** - an unassigned issue is not yours."
    return $t
}

$issues = @(
    @{
        title  = "[DOCS] Write a local testnet deployment guide"
        labels = "type:docs,good first issue,trivial-100,module/docs"
        body   = Body "There is no single page that walks a new contributor from ``git clone`` to a deployed contract on the local Quickstart node. CONTRIBUTING.md covers running the stack; nothing covers deploying." "A new contributor can follow ``docs/local-deployment.md`` start to finish and end up with the oracle deployed to the local network and its contract id in their .env, without asking a question." "Cover: starting the stack, funding an account with friendbot, ``cargo build --target wasm32v1-none --release``, ``stellar contract deploy``, calling ``initialise``, and how to verify it worked."
    },
    @{
        title  = "[FEAT] Add --format json|table to the CLI"
        labels = "type:feat,good first issue,trivial-100,module/cli"
        body   = Body "``packages/indexer/src/cli.ts`` always prints a table and writes JSON to disk. There is no way to pipe the JSON." "``--format json`` emits valid JSON on stdout and nothing else. Table stays the default. Progress messages stay on stderr so piping works." ""
    },
    @{
        title  = "[FEAT] Print a live progress counter during long scans"
        labels = "type:feat,good first issue,trivial-100,module/cli"
        body   = Body "``fetchPayments`` accepts an ``onProgress`` callback that ``cli.ts`` never passes, so a long scan looks frozen." "Scanning a large account shows a record count that updates in place rather than scrolling." ""
    },
    @{
        title  = "[FEAT] Emit a CSV alongside the JSON scan output"
        labels = "type:feat,good first issue,trivial-100,module/cli"
        body   = Body "One row per account with the headline columns, written next to the existing JSON." "``out/scan-*.csv`` is written on every scan and opens cleanly in a spreadsheet." ""
    },
    @{
        title  = "[DOCS] Document every API endpoint with example responses"
        labels = "type:docs,good first issue,trivial-100,module/api"
        body   = Body "``packages/api`` exposes five endpoints and none are documented outside the source." "``docs/api.md`` lists every endpoint with a real example response, including the ``asOf`` and ``staleHours`` fields and the return-rate caveat." ""
    },
    @{
        title  = "[FEAT] Support http:// Horizon URLs for local development"
        labels = "type:feat,good first issue,trivial-100,module/cli"
        body   = Body "``--horizon`` is documented as https only. Verify a local Quickstart node works and document it." "A run against ``http://localhost:8000`` succeeds and the README shows the example." ""
    },
    @{
        title  = "[FEAT] Read SEP-24 memos to correlate transaction legs"
        labels = "type:feat,help wanted,medium-150,module/metrics"
        body   = Body "The highest-value item in the repo. Refund detection matches on counterparty, asset, amount tolerance and time window, which both over- and under-counts (see docs/methodology.md section 5). SEP-24 uses a memo to correlate the two legs directly. ``PaymentRecord`` already carries ``memo``; nothing reads it." "Memo-matched pairs are marked ``confidence: ""memo""`` versus ``""heuristic""`` in the JSON and in the ``refund_pairs`` table, and the report distinguishes the two counts." "This converts the project's core metric from an inference into a measurement. Update docs/methodology.md in the same PR."
    },
    @{
        title  = "[FEAT] Integrate Freighter wallet on the site"
        labels = "type:feat,help wanted,medium-150,module/site"
        body   = Body "The site is read-only. A visitor cannot connect a wallet, so there is no path from 'this anchor is dark' to acting on it, and no way to sign a settlement attestation later." "A Connect Wallet button uses the Freighter API to connect, shows the truncated public key, persists across reloads, and degrades gracefully with a link to install when Freighter is absent." "Read-only for now: connect and display, no transactions. This lands the plumbing that attestation signing (see the attestation issue) will need."
    },
    @{
        title  = "[FEAT] Ingest CAP-67 unified events"
        labels = "type:feat,help wanted,medium-150,module/indexer"
        body   = Body "Protocol 23 makes classic payments emit transfer/mint/burn events with standardised topics. The ``ledger_events`` table and the ``cap67_topic`` enum exist; nothing populates them. Today the indexer pages the REST endpoint per account." "The indexer follows the event stream, writes rows to ``ledger_events``, and marks payments sourced that way as ``cap67_event`` in ``payments.source``. REST remains the fallback for pre-Protocol-23 networks." "One stream replaces N per-account cursors. Mint and burn become distinguishable from transfer instead of being inferred."
    },
    @{
        title  = "[CHORE] Add a deploy script for the oracle contract"
        labels = "type:chore,help wanted,medium-150,module/soroban"
        body   = Body "The contract has 16 passing tests and has never been deployed. There is no script, no contract id, and nothing in the repo invokes it." "``npm run contracts:deploy`` builds the wasm, deploys to the network in ```$SOROBAN_RPC_URL``, calls ``initialise``, and writes the contract id somewhere the indexer can read it. Works against the local Quickstart node with no manual steps." ""
    },
    @{
        title  = "[FEAT] Persist the resume cursor between runs"
        labels = "type:feat,medium-150,module/indexer"
        body   = Body "``fetchPayments`` returns ``newestCursor`` and the ``cursors`` table exists, but the scan never reads or writes it, so every run re-fetches history it already has." "A second run against an unchanged account fetches zero pages." ""
    },
    @{
        title  = "[FEAT] Detect partial refunds"
        labels = "type:feat,medium-150,module/metrics"
        body   = Body "Matching requires amounts to agree within 2 percent, so partial returns are missed entirely." "An outbound that is a meaningful fraction (roughly 20-98 percent) of a prior inbound is recorded with ``is_partial = true`` and counted separately, never folded into the full return rate." ""
    },
    @{
        title  = "[FEAT] Add confidence intervals to the return rate"
        labels = "type:feat,medium-150,module/metrics"
        body   = Body "A rate of 4 percent over 30 payments and over 30,000 are not equivalent claims, but the report presents them identically." "A Wilson score interval is computed and rendered, e.g. ``3.90% +/-1.2``. The existing n= labelling stays." ""
    },
    @{
        title  = "[FEAT] Roll metrics up to the domain level"
        labels = "type:feat,medium-150,module/metrics"
        body   = Body "An anchor may operate several accounts. The report lists each separately, so a reader has to aggregate by eye." "One row per domain in the table, per-account detail retained in the JSON, and the fully-dark-domain rule still works." ""
    },
    @{
        title  = "[FEAT] Handle account merges and deletions"
        labels = "type:feat,medium-150,module/indexer"
        body   = Body "``account_merge`` operations are discarded by ``normalise``. An anchor account being merged away is a strong signal." "Merges are detected and surfaced, and a merged-away account is distinguished from a merely dormant one." ""
    },
    @{
        title  = "[TEST] Add an end-to-end test against the local Quickstart node"
        labels = "type:test,help wanted,medium-150,module/indexer"
        body   = Body "Every test today runs against a mock or a fixture. Nothing exercises the indexer against a real Stellar network." "A test that boots the compose stack, funds an account, makes payments, runs a scan, and asserts the rows landed in Postgres. Skipped unless an env var is set, so the default suite stays offline." ""
    },
    @{
        title  = "[FEAT] Signed settlement receipt ingest"
        labels = "type:feat,help wanted,high-200,module/api"
        body   = Body "The fiat leg is invisible on-chain, so it has to be attested. The ``attestations`` table exists and nothing writes to it." "An endpoint accepts a receipt (SEP-38 quote reference, quoted amount, on-chain tx hash, landed amount, signature), verifies the signature against the referenced transaction, and stores it. A forged receipt is rejected; an unverified one never reaches a published figure." "Binding each receipt to a real on-chain transaction is what makes spamming attestations cost real money."
    },
    @{
        title  = "[FEAT] Slippage metric: quoted versus landed"
        labels = "type:feat,high-200,module/metrics"
        body   = Body "The gap between the SEP-38 quoted amount and what actually landed. Nobody in the ecosystem measures this." "Per-anchor median slippage with sample counts, suppressed below a data floor and labelled with n." "Depends on receipt ingest."
    },
    @{
        title  = "[FEAT] Publish dataset digests to the oracle after each scan"
        labels = "type:feat,high-200,module/soroban"
        body   = Body "The contract's ``publish`` and ``set_scores`` are tested but never called. The scan computes everything needed and stops at Postgres." "After a successful persisted scan, the indexer hashes the dataset, calls ``publish`` with the digest, and batches ``set_scores``. The digest is recomputable from the published data by a third party." "Closes the loop in docs/architecture.md, which currently shows a path nothing walks."
    },
    @{
        title  = "[FEAT] Publish @landfall/sdk with pickAnchor()"
        labels = "type:feat,help wanted,high-200,module/sdk"
        body   = Body "The site advertises an SDK that does not exist. Distribution is meant to be a function wallets call, not a dashboard people visit." "A published package exposing ``pickAnchor({from, to, amount})`` that returns a ranked list with confidence, with types, working against the public API." ""
    },
    @{
        title  = "[FEAT] MCP server exposing anchor quality to payment agents"
        labels = "type:feat,high-200,module/sdk"
        body   = Body "An agent that can pay still has to decide who to pay, and there is no machine-readable answer today." "An MCP client can list tools and retrieve rankings with confidence values." ""
    }
)

Write-Host "Filing $($issues.Count) issues..."
$n = 0
foreach ($i in $issues) {
    if ($PSCmdlet.ShouldProcess($i.title, "create issue")) {
        $url = gh issue create --repo $Repo --title $i.title --body $i.body --label $i.labels
        if ($LASTEXITCODE -ne 0 -or -not $url) {
            # Report and carry on. A partial tracker is recoverable - the script
            # skips issues whose titles already exist - but only if you can see
            # which ones did not land.
            Write-Host ("  FAILED: " + $i.title) -ForegroundColor Red
        } else {
            Write-Host "  $url"
            $n++
        }
        Start-Sleep -Milliseconds 400
    }
}

Write-Host ""
Write-Host "Done. $n issues across $($labels.Count) labels."
Write-Host "Next: sync the repo in Drips, then apply it to the Stellar Wave."
