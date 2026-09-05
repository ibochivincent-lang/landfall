<#
    Landfall - bring the GitHub repo up to the standard the approved
    Stellar Wave repos hold.

    Observed on every approved repo: a description, a homepage link, topics
    set for discoverability, and complexity labels on issues. None of it is
    hard; all of it is checked.

    Run from the repo root after pushing:

        gh auth status                  # confirm the right account
        .\scripts\setup-repo.ps1

    Safe to re-run. Sets metadata and labels only - it files no issues.
    Use scripts\setup-issues.ps1 for those.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Repo = "",
    [string]$Homepage = "https://landfall-ib.vercel.app"
)

# NOT 'Stop'. With 'Stop', PowerShell turns anything a native command writes
# to stderr into a TERMINATING error, even when the command succeeded and
# exited 0. `gh` writes progress and warnings there routinely.
# stderr is not an error signal; the exit code is, and it is checked below.
$ErrorActionPreference = 'Continue'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI not found. Install it, or set these by hand in repo Settings."
}

if (-not $Repo) {
    $Repo = (gh repo view --json nameWithOwner --jq .nameWithOwner) 2>$null
    if (-not $Repo) { throw "Could not detect the repo. Pass -Repo owner/name." }
}

Write-Host "Repo:    $Repo"
Write-Host "Account: $(gh api user --jq .login)"
Write-Host ""

# ---- description and homepage ---------------------------------------------

$description = "Ledger-derived settlement record for Stellar anchors. We don't ask anchors how they're doing - we read what they actually did."

if ($PSCmdlet.ShouldProcess($Repo, "set description and homepage")) {
    gh repo edit $Repo --description $description --homepage $Homepage | Out-Null
    Write-Host "Description and homepage set."
}

# ---- topics ----------------------------------------------------------------
# Discoverability. Approved repos all carry these; an untagged repo is
# invisible to anyone browsing the ecosystem.

$topics = @(
    "stellar", "soroban", "anchors", "sep-24", "sep-38",
    "stablecoin", "remittance", "defi", "open-data", "typescript"
)

if ($PSCmdlet.ShouldProcess($Repo, "set topics")) {
    # NOT $args - that is an automatic variable and assigning to it
    # misbehaves under Windows PowerShell 5.1.
    $topicArgs = @()
    foreach ($t in $topics) { $topicArgs += "--add-topic"; $topicArgs += $t }
    gh repo edit $Repo @topicArgs | Out-Null
    Write-Host "Topics set: $($topics -join ', ')"
}

# ---- labels ----------------------------------------------------------------
# Complexity tiers match Drips Wave point values. The "Stellar Wave" label is
# what marks an issue as in-scope for the current cycle.

$labels = @(
    @{ name = "Stellar Wave";     color = "5319E7"; desc = "In scope for the current Drips Stellar Wave cycle" }
    @{ name = "trivial-100";      color = "0E8A16"; desc = "Drips Wave: 100 points" }
    @{ name = "medium-150";       color = "FBCA04"; desc = "Drips Wave: 150 points" }
    @{ name = "high-200";         color = "D93F0B"; desc = "Drips Wave: 200 points" }
    @{ name = "good first issue"; color = "7057FF"; desc = "Scoped, unblocked and reviewer-ready" }
    @{ name = "help wanted";      color = "008672"; desc = "Larger ticket actively looking for an owner" }
    @{ name = "module/indexer";   color = "1D76DB"; desc = "Horizon indexing and data collection" }
    @{ name = "module/metrics";   color = "1D76DB"; desc = "Metric computation and correctness" }
    @{ name = "module/sdk";       color = "1D76DB"; desc = "SDK, API and integrations" }
    @{ name = "module/soroban";   color = "1D76DB"; desc = "On-chain oracle contract" }
    @{ name = "module/cli";       color = "1D76DB"; desc = "Command line interface and output" }
    @{ name = "module/site";      color = "1D76DB"; desc = "The public site" }
)

Write-Host ""
Write-Host "Creating labels..."
foreach ($l in $labels) {
    if ($PSCmdlet.ShouldProcess($l.name, "create label")) {
        gh label create $l.name --repo $Repo --color $l.color --description $l.desc --force | Out-Null
        Write-Host "  $($l.name)"
    }
}

# ---- report ----------------------------------------------------------------

Write-Host ""
Write-Host "Checklist:"
$files = @{
    "README.md"           = "readme"
    "LICENSE"             = "licence"
    "CONTRIBUTING.md"     = "contributing guide"
    "docker-compose.yml"  = "local stack"
    "DEVELOPMENT.md"      = "development guide"
    "CODE_OF_CONDUCT.md"  = "code of conduct"
    "SECURITY.md"         = "security policy"
    "vercel.json"         = "deploy config"
    ".github/workflows/ci.yml" = "CI workflow"
    "packages/web/index.html" = "site"
    ".github/pull_request_template.md" = "PR template"
    ".github/ISSUE_TEMPLATE/bug_report.yml" = "issue templates"
}
foreach ($f in $files.Keys | Sort-Object) {
    $mark = if (Test-Path $f) { "  ok  " } else { "  MISSING " }
    Write-Host "$mark $f  ($($files[$f]))"
}

Write-Host ""
Write-Host "Still manual:"
Write-Host "  - Deploy the site: vercel.com -> Add New -> Project -> import this repo."
Write-Host "    Settings are already in vercel.json; accept the defaults."
Write-Host "  - Consider moving the repo into a GitHub organisation. Almost every"
Write-Host "    approved Stellar Wave repo lives under an org, not a personal account."
Write-Host "  - File the backlog: .\scripts\setup-issues.ps1"
