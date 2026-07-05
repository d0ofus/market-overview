param(
  [Parameter(Mandatory = $true)]
  [string]$BridgeEndpoint,
  [Parameter(Mandatory = $true)]
  [string]$BridgeToken,
  [string]$CfAccessClientId,
  [string]$CfAccessClientSecret
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$WorkerRoot = Join-Path $RepoRoot "worker"

Push-Location $WorkerRoot
try {
  $BridgeEndpoint | npx wrangler secret put IBKR_OPTIONS_ENDPOINT
  $BridgeToken | npx wrangler secret put IBKR_OPTIONS_TOKEN
  if ($CfAccessClientId) {
    $CfAccessClientId | npx wrangler secret put IBKR_OPTIONS_CF_ACCESS_CLIENT_ID
  }
  if ($CfAccessClientSecret) {
    $CfAccessClientSecret | npx wrangler secret put IBKR_OPTIONS_CF_ACCESS_CLIENT_SECRET
  }
} finally {
  Pop-Location
}

Write-Host "Worker bridge secrets have been submitted. IBKR_OPTIONS_ENABLED remains controlled by worker/wrangler.toml."
