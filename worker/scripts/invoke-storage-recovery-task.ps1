param([Parameter(Mandatory=$true)][string]$ConfigurationPath)

$ErrorActionPreference = 'Stop'
$RecoveryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$RecoveryConfig = [IO.Path]::GetFullPath($ConfigurationPath)
if (-not $RecoveryConfig.StartsWith((Join-Path $RecoveryRoot 'worker/tmp/'), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'storage-task-configuration-outside-workspace'
}
Set-Location -LiteralPath $RecoveryRoot
# Read the same signed-in user's existing secret environment after logon.
# Neither the task definition nor its JSON configuration contains credentials.
$env:CLOUDFLARE_API_TOKEN = [Environment]::GetEnvironmentVariable('CLOUDFLARE_API_TOKEN', 'User')
if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) { throw 'storage-task-cloudflare-credential-unavailable' }
$env:CLOUDFLARE_EOD_D1_TOKEN = $env:CLOUDFLARE_API_TOKEN
$RecoveryConfiguration = Get-Content -LiteralPath $RecoveryConfig -Raw | ConvertFrom-Json
$RecoveryStartedAt = [DateTimeOffset]::UtcNow
& node (Join-Path $RecoveryRoot 'node_modules/tsx/dist/cli.mjs') (Join-Path $RecoveryRoot 'worker/scripts/continue-storage-rollout.ts') $RecoveryConfig
$RecoveryExitCode = $LASTEXITCODE
& node (Join-Path $RecoveryRoot 'node_modules/tsx/dist/cli.mjs') (Join-Path $RecoveryRoot 'worker/scripts/publish-storage-recovery-status.ts') $RecoveryConfig
$RecoveryReportExitCode = $LASTEXITCODE
$RecoveryStatusPath = Join-Path $RecoveryRoot 'worker/tmp/storage-recovery-status.json'
if (Test-Path -LiteralPath $RecoveryStatusPath) {
  $RecoveryStatus = Get-Content -LiteralPath $RecoveryStatusPath -Raw | ConvertFrom-Json
  $RecoveryVerifiedAt = [DateTimeOffset]::MinValue
  $RecoveryFresh = [DateTimeOffset]::TryParse([string]$RecoveryStatus.updatedAt, [ref]$RecoveryVerifiedAt) -and $RecoveryVerifiedAt -ge $RecoveryStartedAt -and $RecoveryVerifiedAt -le [DateTimeOffset]::UtcNow
  if ($RecoveryExitCode -eq 0 -and $RecoveryReportExitCode -eq 0 -and $RecoveryStatus.status -eq 'completed' -and $RecoveryStatus.codeRevision -eq $RecoveryConfiguration.codeRevision -and $RecoveryFresh) {
    Disable-ScheduledTask -TaskName 'MarketOverview-EodStorageRecovery' -ErrorAction SilentlyContinue | Out-Null
  }
}
exit $RecoveryExitCode
