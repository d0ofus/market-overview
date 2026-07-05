param(
  [string]$BridgeUrl = "http://127.0.0.1:8765",
  [string]$BridgeToken
)

$ErrorActionPreference = "Stop"
$Cloudflared = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
if (-not $Cloudflared) {
  throw "cloudflared.exe was not found in PATH. Install cloudflared first, then rerun this script."
}

if ($BridgeToken) {
  Write-Host "Checking local bridge before starting a temporary Cloudflare tunnel..."
  & (Join-Path $PSScriptRoot "check-bridge.ps1") -BridgeUrl $BridgeUrl -BridgeToken $BridgeToken
}

Write-Host ""
Write-Host "Starting temporary Cloudflare Quick Tunnel for $BridgeUrl"
Write-Host "Copy the generated https://*.trycloudflare.com URL from the cloudflared output."
Write-Host "Keep this PowerShell window open while testing; closing it stops the tunnel."
Write-Host ""

& $Cloudflared.Source tunnel --url $BridgeUrl
