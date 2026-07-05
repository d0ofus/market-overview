param(
  [Parameter(Mandatory = $true)]
  [string]$TunnelToken
)

$ErrorActionPreference = "Stop"
$Cloudflared = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
if (-not $Cloudflared) {
  throw "cloudflared.exe was not found in PATH. Install Cloudflare Tunnel first, then rerun this script."
}

& $Cloudflared.Source service install $TunnelToken
Write-Host "cloudflared service install command completed. Check the Cloudflare Tunnels dashboard for a Healthy connector."
