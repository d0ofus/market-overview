param(
  [string]$HostOverride,
  [int]$PortOverride
)

$ErrorActionPreference = "Stop"
$BridgeRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Python = Join-Path $BridgeRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
  throw "Bridge virtualenv not found. Run scripts\setup-venv.ps1 first."
}

if (-not (Test-Path (Join-Path $BridgeRoot ".env"))) {
  throw "Missing .env. Copy .env.example to .env and set IBKR_BRIDGE_TOKEN before starting."
}

$HostValue = if ($HostOverride) { $HostOverride } else { "127.0.0.1" }
$PortValue = if ($PortOverride) { $PortOverride } else { 8765 }

Push-Location $BridgeRoot
try {
  & $Python -m uvicorn app.main:app --host $HostValue --port $PortValue
} finally {
  Pop-Location
}
