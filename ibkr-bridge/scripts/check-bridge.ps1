param(
  [string]$BridgeUrl = "http://127.0.0.1:8765",
  [Parameter(Mandatory = $true)]
  [string]$BridgeToken,
  [string]$CfAccessClientId,
  [string]$CfAccessClientSecret,
  [string]$ProbeTicker,
  [string]$HistoricalSessionDate
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
  $Chain = Invoke-RestMethod -Method POST -Uri "$Base/v1/options/chains" -Headers $Headers -ContentType "application/json" -Body $Body -TimeoutSec 120
  $Chain | ConvertTo-Json -Depth 10

  if ($HistoricalSessionDate) {
    $Contract = $Chain.results |
      ForEach-Object { $_.contracts } |
      Where-Object { $_.ibkrConId -or $_.contractKey } |
      Sort-Object @{ Expression = { if ($_.openInterest -ne $null) { -1 * [int]$_.openInterest } else { 0 } } } |
      Select-Object -First 1
    if (-not $Contract) {
      throw "No returned option contract had enough identity for a historical BID_ASK probe."
    }
    $ContractLabel = if ($Contract.localSymbol) { $Contract.localSymbol } else { $Contract.contractKey }
    Write-Host "Checking $Base/v1/options/historical-bid-ask for $ContractLabel on $HistoricalSessionDate"
    $HistoryBody = @{
      sessionDate = $HistoricalSessionDate
      useRth = 1
      tickType = "BID_ASK"
      sampleTarget = 300
      contracts = @(@{
        ticker = $ProbeTicker
        contractKey = $Contract.contractKey
        ibkrConId = $Contract.ibkrConId
        localSymbol = $Contract.localSymbol
        expiry = $Contract.expiry
        strike = $Contract.strike
        right = $Contract.right
      })
    } | ConvertTo-Json -Depth 8
    Invoke-RestMethod -Method POST -Uri "$Base/v1/options/historical-bid-ask" -Headers $Headers -ContentType "application/json" -Body $HistoryBody -TimeoutSec 180 | ConvertTo-Json -Depth 10
  }
}
