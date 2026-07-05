param(
  [string]$BridgeUrl = "http://127.0.0.1:8765",
  [Parameter(Mandatory = $true)]
  [string]$BridgeToken,
  [string]$CfAccessClientId,
  [string]$CfAccessClientSecret,
  [string]$ProbeTicker
)

$ErrorActionPreference = "Stop"
$Headers = @{
  Authorization = "Bearer $BridgeToken"
}
if ($CfAccessClientId) {
  $Headers["CF-Access-Client-Id"] = $CfAccessClientId
}
if ($CfAccessClientSecret) {
  $Headers["CF-Access-Client-Secret"] = $CfAccessClientSecret
}

$Base = $BridgeUrl.TrimEnd("/")
Write-Host "Checking $Base/health"
$Health = Invoke-RestMethod -Method GET -Uri "$Base/health" -Headers $Headers -TimeoutSec 30
$Health | ConvertTo-Json -Depth 8

if ($ProbeTicker) {
  Write-Host "Checking $Base/v1/options/chains for $ProbeTicker"
  $Body = @{
    tickers = @($ProbeTicker)
    includeGreeks = $true
    includeIvRank = $true
    minDte = 14
    maxDte = 90
    maxContractsPerTicker = 20
  } | ConvertTo-Json -Depth 8
  Invoke-RestMethod -Method POST -Uri "$Base/v1/options/chains" -Headers $Headers -ContentType "application/json" -Body $Body -TimeoutSec 120 | ConvertTo-Json -Depth 10
}
