$ErrorActionPreference = "Stop"
$BridgeRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Python = Join-Path $BridgeRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
  & (Join-Path $BridgeRoot "scripts\setup-venv.ps1")
}

& $Python -m pytest (Join-Path $BridgeRoot "tests")
