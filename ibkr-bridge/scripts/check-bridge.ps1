param(
  [string]$BridgeUrl = "http://127.0.0.1:8765",
  [Parameter(Mandatory = $true)]
  [string]$BridgeToken,
  [string]$CfAccessClientId,
  [string]$CfAccessClientSecret,
  [string]$ProbeTicker,
  [Alias("RthSessionDate")]
  [string]$HistoricalSessionDate,
  [string]$TargetExpiry,
  [int]$MinDte = 1,
  [int]$MaxDte = 90,
  [int]$MaxContractsPerTicker = 40,
  [switch]$ContinueOnUnhealthy
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

function Invoke-BridgeRequest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Method,
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [Parameter(Mandatory = $true)]
    [hashtable]$Headers,
    [string]$ContentType,
    [string]$Body,
    [int]$TimeoutSec = 30
  )

  $Params = @{
    Method = $Method
    Uri = $Uri
    Headers = $Headers
    TimeoutSec = $TimeoutSec
  }
  if ($ContentType) {
    $Params["ContentType"] = $ContentType
  }
  if ($Body) {
    $Params["Body"] = $Body
  }

  try {
    Invoke-RestMethod @Params
  } catch {
    $Response = $_.Exception.Response
    if ($Response) {
      $Stream = $Response.GetResponseStream()
      if ($Stream) {
        $Reader = New-Object System.IO.StreamReader($Stream)
        $ResponseBody = $Reader.ReadToEnd()
        if ($ResponseBody) {
          Write-Host "Bridge error response body:"
          Write-Host $ResponseBody
        }
      }
    }
    throw
  }
}

$Base = $BridgeUrl.TrimEnd("/")
Write-Host "Checking $Base/health"
$Health = Invoke-BridgeRequest -Method GET -Uri "$Base/health" -Headers $Headers -TimeoutSec 30
$Health | ConvertTo-Json -Depth 8

if (-not $Health.ok -and -not $ContinueOnUnhealthy) {
  $IbkrHost = if ($Health.ibkr.host) { $Health.ibkr.host } else { "127.0.0.1" }
  $IbkrPort = if ($Health.ibkr.port) { $Health.ibkr.port } else { "<unknown>" }
  Write-Host ""
  Write-Host "Bridge is running, but IBKR is not reachable at ${IbkrHost}:${IbkrPort}."
  if ($Health.lastError) {
    Write-Host "IBKR connection error: $($Health.lastError)"
  }
  Write-Host "Start/login to IB Gateway or TWS, confirm API sockets are enabled, and verify the port matches IBKR_PORT in .env."
  Write-Host "Use -ContinueOnUnhealthy only when you intentionally want to test endpoint error handling."
  exit 2
}

if ($ProbeTicker) {
  $RequestMinDte = $MinDte
  $RequestMaxDte = $MaxDte
  if ($TargetExpiry) {
    try {
      $TargetExpiryDate = [DateTime]::ParseExact($TargetExpiry, "yyyy-MM-dd", [Globalization.CultureInfo]::InvariantCulture)
    } catch {
      throw "-TargetExpiry must use YYYY-MM-DD format, for example 2026-07-17."
    }
    $TargetDte = ($TargetExpiryDate.Date - (Get-Date).Date).Days
    if ($TargetDte -lt 0) {
      throw "-TargetExpiry $TargetExpiry is in the past for this machine date $((Get-Date).Date.ToString("yyyy-MM-dd"))."
    }
    $RequestMinDte = $TargetDte
    $RequestMaxDte = $TargetDte
  }

  $ExpiryText = if ($TargetExpiry) { ", target option expiry $TargetExpiry" } else { "" }
  Write-Host "Checking $Base/v1/options/chains for $ProbeTicker with DTE $RequestMinDte-$RequestMaxDte$ExpiryText"
  $Body = @{
    tickers = @($ProbeTicker)
    includeGreeks = $true
    includeIvRank = $true
    minDte = $RequestMinDte
    maxDte = $RequestMaxDte
    maxContractsPerTicker = $MaxContractsPerTicker
  } | ConvertTo-Json -Depth 8
  $Chain = Invoke-BridgeRequest -Method POST -Uri "$Base/v1/options/chains" -Headers $Headers -ContentType "application/json" -Body $Body -TimeoutSec 120
  $Chain | ConvertTo-Json -Depth 10

  if ($HistoricalSessionDate) {
    $Underlying = $Chain.results |
      Where-Object { $_.underlyingPrice -ne $null } |
      Select-Object -First 1 -ExpandProperty underlyingPrice

    $CandidateContracts = $Chain.results |
      ForEach-Object { $_.contracts } |
      Where-Object { $_.ibkrConId -or $_.contractKey }

    if ($TargetExpiry) {
      $CandidateContracts = $CandidateContracts | Where-Object { $_.expiry -eq $TargetExpiry }
      if (-not $CandidateContracts) {
        $AvailableExpiries = $Chain.results |
          ForEach-Object { $_.contracts } |
          Where-Object { $_.expiry } |
          Select-Object -ExpandProperty expiry -Unique |
          Sort-Object
        $AvailableText = if ($AvailableExpiries) { $AvailableExpiries -join ", " } else { "<none returned>" }
        throw "No returned option contracts matched -TargetExpiry $TargetExpiry. Available expiries: $AvailableText"
      }
    }

    $Contract = $CandidateContracts |
      Sort-Object `
        @{ Expression = { if ($_.quote -and ($_.quote.bid -ne $null -or $_.quote.ask -ne $null -or $_.quote.last -ne $null)) { 0 } else { 1 } } }, `
        @{ Expression = { if ($_.openInterest -ne $null) { -1 * [int]$_.openInterest } else { 0 } } }, `
        @{ Expression = { if ($Underlying -ne $null -and $_.strike -ne $null) { [Math]::Abs([double]$_.strike - [double]$Underlying) } else { [double]::MaxValue } } } |
      Select-Object -First 1
    if (-not $Contract) {
      throw "No returned option contract had enough identity for a historical BID_ASK probe."
    }
    $ContractLabel = if ($Contract.localSymbol) { $Contract.localSymbol } else { $Contract.contractKey }
    Write-Host "Checking $Base/v1/options/historical-bid-ask for $ContractLabel expiring $($Contract.expiry) using RTH session $HistoricalSessionDate"
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
    Invoke-BridgeRequest -Method POST -Uri "$Base/v1/options/historical-bid-ask" -Headers $Headers -ContentType "application/json" -Body $HistoryBody -TimeoutSec 180 | ConvertTo-Json -Depth 10
  }
}
