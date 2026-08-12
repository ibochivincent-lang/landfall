<#
    Landfall - create Wave labels and file the backlog as GitHub issues.

    Run once, from the repo root, after pushing:

        gh auth status              # confirm you are ibochivincent-lang
        .\scripts\setup-issues.ps1

    Idempotent for labels (uses --force). NOT idempotent for issues - running
    it twice files 16 duplicates. Use -WhatIf first if unsure.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Repo = ""
)

$ErrorActionPreference = "Stop"

# ---- preflight -------------------------------------------------------------

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI not found. Install it, or create the issues by hand from docs/backlog.md."
}

if (-not $Repo) {
    $Repo = (gh repo view --json nameWithOwner --jq .nameWithOwner) 2>$null
    if (-not $Repo) { throw "Could not detect the repo. Pass -Repo owner/name." }
}

$account = (gh api user --jq .login)
Write-Host "Repo:    $Repo"
Write-Host "Account: $account"
Write-Host ""

$existing = (gh issue list --repo $Repo --state all --limit 200 --json title --jq '.[].title')
if ($existing) {
    Write-Warning "This repo already has issues. Filing again will create duplicates."
    $go = Read-Host "Type 'yes' to continue"
    if ($go -ne "yes") { Write-Host "Aborted."; exit 0 }
}

# ---- labels ----------------------------------------------------------------
# Complexity tiers match Drips Wave point values.

$labels = @(
    @{ name = "Stellar Wave";     color = "5319E7"; desc = "In scope for the current Drips Stellar Wave cycle" }
    @{ name = "trivial-100";      color = "0E8A16"; desc = "Drips Wave: 100 points" }
    @{ name = "medium-150";       color = "FBCA04"; desc = "Drips Wave: 150 points" }
    @{ name = "high-200";         color = "D93F0B"; desc = "Drips Wave: 200 points" }
    @{ name = "good-first-issue"; color = "7057FF"; desc = "Good entry point for a new contributor" }
    @{ name = "module/indexer";   color = "1D76DB"; desc = "Horizon indexing and data collection" }
    @{ name = "module/metrics";   color = "1D76DB"; desc = "Metric computation and correctness" }
    @{ name = "module/sdk";       color = "1D76DB"; desc = "SDK, API and integrations" }
    @{ name = "module/soroban";   color = "1D76DB"; desc = "On-chain oracle contract" }
    @{ name = "module/cli";       color = "1D76DB"; desc = "Command line interface and output" }
)

Write-Host "Creating labels..."
foreach ($l in $labels) {
    if ($PSCmdlet.ShouldProcess($l.name, "create label")) {
        gh label create $l.name --repo $Repo --color $l.color --description $l.desc --force | Out-Null
        Write-Host "  $($l.name)"
    }
}
Write-Host ""

# ---- issues ----------------------------------------------------------------

function Body($scope, $acceptance, $notes = "") {
    $text = "## Scope`n`n$scope`n`n## Acceptance`n`n$acceptance`n"
    if ($notes) { $text += "`n## Notes`n`n$notes`n" }
    $text += "`n---`n`nSee [docs/backlog.md](docs/backlog.md) for the full backlog and " +
             "[CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. " +
             "If you are working through a bounty program, wait to be assigned before you start coding."
    return $text
}

$issues = @(
    # ---------------- Trivial: 100 ----------------
    @{
        title  = "Add --format json|table to the CLI"
        labels = "Stellar Wave,trivial-100,good-first-issue,module/cli"
        body   = Body `
            "``src/cli.ts`` always prints a table and writes JSON to disk. Add a ``--format`` flag so the JSON can go to stdout for piping." `
            "``--format json`` emits valid JSON on stdout and nothing else. Table remains the default. Progress messages stay on stderr."
    },
    @{
        title  = "Support http:// Horizon URLs for local development"
        labels = "Stellar Wave,trivial-100,good-first-issue,module/cli"
        body   = Body `
            "``--horizon`` is documented as https only. Verify a local Horizon or quickstart image works and document the flag in the README." `
            "A run against ``http://localhost:8000`` succeeds and the README shows the example."
    },
    @{
        title  = "Print a live progress counter during long scans"
        labels = "Stellar Wave,trivial-100,good-first-issue,module/cli"
        body   = Body `
            "``fetchPayments`` accepts an ``onProgress`` callback that ``cli.ts`` never passes. Wire it to a single-line updating counter on stderr." `
            "Scanning a large account shows a live record count that updates in place rather than scrolling."
    },
    @{
        title  = "Add --min-volume suppression alongside --min-inbound"
        labels = "Stellar Wave,trivial-100,module/metrics"
        body   = Body `
            "Some accounts have many tiny payments that clear the dust threshold but still carry no real volume. Add a per-asset volume floor." `
            "Accounts below the floor are excluded from the headline but still listed in the table with their true figures." `
            "Follow the existing suppression pattern - never silently drop a row, mark it."
    },
    @{
        title  = "Emit a CSV alongside the JSON scan output"
        labels = "Stellar Wave,trivial-100,good-first-issue,module/cli"
        body   = Body `
            "Write one row per account with the headline columns, next to the existing JSON." `
            "``out/scan-*.csv`` is written on every scan and opens cleanly in a spreadsheet."
    },

    # ---------------- Medium: 150 ----------------
    @{
        title  = "Read SEP-24 memos to correlate transaction legs"
        labels = "Stellar Wave,medium-150,module/metrics"
        body   = Body `
            "The highest-value item in the repo. Refund detection currently matches on counterparty, asset, amount tolerance and time window, which both over- and under-counts (see docs/methodology.md section 5). SEP-24 uses memos to correlate legs - read them and correlate directly." `
            "Memo-matched pairs are marked ``confidence: ""memo""`` versus ``""heuristic""`` in the JSON, and the report distinguishes the two counts." `
            "This converts the project's core metric from an inference into a measurement. Update docs/methodology.md in the same PR."
    },
    @{
        title  = "Persist the resume cursor between runs"
        labels = "Stellar Wave,medium-150,module/indexer"
        body   = Body `
            "``fetchPayments`` returns ``newestCursor`` and nothing stores it. Write a small state file keyed by account so later runs only fetch new records." `
            "A second run against an unchanged account fetches zero pages. State file location is configurable and gitignored."
    },
    @{
        title  = "Detect partial refunds"
        labels = "Stellar Wave,medium-150,module/metrics"
        body   = Body `
            "Matching requires amounts to agree within 2 percent, so partial returns are missed entirely. Detect an outbound that is a meaningful fraction (roughly 20-98 percent) of a prior inbound." `
            "Partial returns appear as a separate count and are never folded into the full return rate."
    },
    @{
        title  = "Add confidence intervals to the return rate"
        labels = "Stellar Wave,medium-150,module/metrics"
        body   = Body `
            "A rate of 4 percent over 30 payments and over 30,000 are not equivalent claims. Compute a Wilson score interval and render it." `
            "The table shows the interval (e.g. ``3.90%% +/-1.2``) and the headline states it. Existing n= labelling stays."
    },
    @{
        title  = "Roll metrics up to the domain level for multi-account anchors"
        labels = "Stellar Wave,medium-150,module/metrics"
        body   = Body `
            "An anchor may operate several accounts. Aggregate to the domain while keeping per-account detail in the JSON." `
            "The table shows one row per domain. Per-account records remain in the JSON output. The fully-dark domain rule keeps working."
    },
    @{
        title  = "Handle account merges and deletions"
        labels = "Stellar Wave,medium-150,module/indexer"
        body   = Body `
            "``account_merge`` operations are discarded by ``normalise``. An anchor account being merged away is a strong signal that should surface." `
            "Merges are detected and reported. A merged-away account is distinguished from a merely dormant one."
    },

    # ---------------- High: 200 ----------------
    @{
        title  = "Signed settlement receipt ingest (Layer 2)"
        labels = "Stellar Wave,high-200,module/sdk"
        body   = Body `
            "Accept a settlement receipt containing the SEP-38 quote reference, quoted amount, on-chain transaction hash, landed amount and a signature. Verify the signature against the referenced transaction before storing." `
            "A forged receipt is rejected. A valid one is accepted and linked to its ledger record. A receipt whose ``stellar_tx`` does not exist, or was not signed by the claimed key, is refused." `
            "This closes the fiat-leg gap that ledger data alone cannot cover. Binding receipts to real transactions is what makes attestation spam cost money."
    },
    @{
        title  = "Slippage metric: quoted versus landed amount"
        labels = "Stellar Wave,high-200,module/metrics"
        body   = Body `
            "Once receipt ingest lands, compute the gap between the SEP-38 quoted amount and the attested landed amount." `
            "Per-anchor median slippage with sample counts, suppressed below a data floor and labelled with n." `
            "Depends on the settlement receipt issue. This is the metric the ecosystem is currently missing entirely."
    },
    @{
        title  = "Publish @landfall/sdk with pickAnchor()"
        labels = "Stellar Wave,high-200,module/sdk"
        body   = Body `
            "A publishable package exposing ``pickAnchor({from, to, amount})`` returning a ranked list with confidence." `
            "Package builds, ships types, and returns rankings against the public API." `
            "This is the distribution strategy - wallets embed it and the end user never sees the brand. Do not build a consumer dashboard instead."
    },
    @{
        title  = "MCP server exposing anchor quality to payment agents"
        labels = "Stellar Wave,high-200,module/sdk"
        body   = Body `
            "Expose the dataset over MCP so payment agents can query anchor reliability natively." `
            "An MCP client can list tools and retrieve rankings with confidence values." `
            "Positions Landfall for x402-style agentic payments, where an agent that can pay still has to decide who to pay."
    },
    @{
        title  = "Soroban oracle publishing signed score digests"
        labels = "Stellar Wave,high-200,module/soroban"
        body   = Body `
            "An on-chain contract publishing periodic signed digests so other Soroban contracts can route programmatically." `
            "Contract deployed to testnet, digests verifiable against the published dataset, contract tests included, MIT licensed." `
            "Must be open source - this is a commitment in the grant application."
    }
)

Write-Host "Filing $($issues.Count) issues..."
$created = 0
foreach ($i in $issues) {
    if ($PSCmdlet.ShouldProcess($i.title, "create issue")) {
        $url = gh issue create --repo $Repo --title $i.title --body $i.body --label $i.labels
        Write-Host "  $url"
        $created++
        Start-Sleep -Milliseconds 400   # stay clear of secondary rate limits
    }
}

Write-Host ""
Write-Host "Done. $created issues filed across $($labels.Count) labels."
Write-Host ""
Write-Host "Next: sync the repo in Drips, then apply it to the Stellar Wave."
