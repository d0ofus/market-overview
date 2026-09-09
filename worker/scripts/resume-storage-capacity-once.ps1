param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedCommit,
  [Parameter(Mandatory = $true)][string]$AfterUtc,
  [switch]$ValidateOnly
)

# One-time local diagnostic retry. This is not an application scheduler and
# only starts an authorized storage transfer when explicitly configured below.
# Credentials are inherited from the launching process; no secret is written.
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$RetryAt = [DateTimeOffset]::Parse($AfterUtc).ToUniversalTime()
$StatePath = Join-Path $RepoRoot 'worker/tmp/storage-capacity-retry.json'
$LogPath = Join-Path $RepoRoot 'worker/tmp/storage-capacity-retry.log'
Set-Location -LiteralPath $RepoRoot

function Assert-ReviewedCheckout {
  $Revision = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $Revision -ne $ExpectedCommit) { throw 'storage-retry-checkout-changed' }
  & git diff --quiet HEAD
  if ($LASTEXITCODE -ne 0) { throw 'storage-retry-checkout-dirty' }
}
function Write-RetryState([string]$Status, [string]$Reason = '') {
  @{ status = $Status; reason = $Reason; nextAttemptAt = $RetryAt.ToString('o');
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o'); pid = $PID; codeRevision = $ExpectedCommit } |
    ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
}

Assert-ReviewedCheckout
foreach ($Name in @('CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_EOD_D1_TOKEN','EOD_MARKET_DATABASE_ID','EOD_OPS_DATABASE_ID','EOD_SNAPSHOT_RUN_ID','STORAGE_SNAPSHOT_PATH')) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name))) { throw "storage-retry-missing-$Name" }
}
$Snapshot = [IO.Path]::GetFullPath($env:STORAGE_SNAPSHOT_PATH)
$RunMatch = [regex]::Match($env:EOD_SNAPSHOT_RUN_ID, '^eod:(shadow|active):(?<session>\d{4}-\d{2}-\d{2}):(daily|reconcile|backfill|maintenance)$')
if (-not $RunMatch.Success) { throw 'storage-retry-run-id-invalid' }
$SessionDate = $RunMatch.Groups['session'].Value
$WorkspacePrefix = $RepoRoot.TrimEnd('\') + '\'
if (-not $Snapshot.StartsWith($WorkspacePrefix, [StringComparison]::OrdinalIgnoreCase) -or -not $Snapshot.EndsWith('.sqlite')) {
  throw 'storage-retry-snapshot-outside-workspace'
}
if ($ValidateOnly) { Write-Output 'Storage capacity retry configuration validated.'; exit 0 }

try {
  Write-RetryState 'queued'
  while ([DateTimeOffset]::UtcNow -lt $RetryAt) {
    $Seconds = [Math]::Min(60, [Math]::Max(1, [Math]::Ceiling(($RetryAt - [DateTimeOffset]::UtcNow).TotalSeconds)))
    Start-Sleep -Seconds $Seconds
  }
  Assert-ReviewedCheckout
  Write-RetryState 'capturing'
  & npx.cmd --no-install tsx worker/scripts/market-storage-snapshot.ts *> $LogPath
  if ($LASTEXITCODE -ne 0) { throw 'storage-retry-capture-incomplete' }
  Write-RetryState 'analyzing'
  # The stored history snapshot is diagnostic only. Preliminary capacity
  # evidence still cannot authorize production transfer or cutover.
  & python worker/scripts/analyze-eod-storage.py --source-sqlite $Snapshot `
    --tickers-json "$Snapshot.tickers.json" --session-date $SessionDate `
    --history-sqlite worker/tmp/eod-storage-history.sqlite `
    --output worker/tmp/eod-storage-analysis.json *>> $LogPath
  if ($LASTEXITCODE -ne 0) { throw 'storage-retry-analysis-incomplete' }
  Write-RetryState 'analysis-complete' 'preliminary-capacity-only-no-cutover'
  if ($env:EOD_STORAGE_START_APPROVED -eq 'true') {
    Assert-ReviewedCheckout
    $env:EOD_STORAGE_EXPECTED_COMMIT = $ExpectedCommit
    $env:EOD_STORAGE_ANALYSIS_PATH = Join-Path $RepoRoot 'worker/tmp/eod-storage-analysis.json'
    $env:EOD_STORAGE_SNAPSHOT_IDENTITY_PATH = "$Snapshot.identity.json"
    $env:EOD_STORAGE_FROZEN_INPUT_PATH = "$Snapshot.tickers.json"
    Write-RetryState 'storage-preflight' 'authorized-relocation-only-public-cutover-remains-gated'
    & node --import tsx worker/scripts/start-storage-migration-once.ts *>> $LogPath
    if ($LASTEXITCODE -ne 0) { throw 'storage-retry-relocation-start-incomplete' }
    Write-RetryState 'storage-dispatched' 'accepted-dispatch-not-completed-transfer'
  }
} catch {
  $Reason = $_.Exception.Message
  if ($Reason -notmatch '^storage-retry-[a-z-]+$') { $Reason = 'storage-retry-stopped' }
  Write-RetryState 'paused' $Reason
  exit 1
}
