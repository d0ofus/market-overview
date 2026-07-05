param(
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$BridgeRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$VenvPath = Join-Path $BridgeRoot ".venv"

if (-not (Test-Path $VenvPath)) {
  & $Python -m venv $VenvPath
}

$VenvPython = Join-Path $VenvPath "Scripts\python.exe"
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r (Join-Path $BridgeRoot "requirements.txt") -r (Join-Path $BridgeRoot "requirements-dev.txt")

Write-Host "Bridge virtualenv ready at $VenvPath"
