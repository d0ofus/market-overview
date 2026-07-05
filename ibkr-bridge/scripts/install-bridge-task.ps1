param(
  [ValidateSet("AtLogOn", "AtStartup")]
  [string]$Trigger = "AtLogOn",
  [string]$TaskName = "MarketCommandIbkrBridge"
)

$ErrorActionPreference = "Stop"
$BridgeRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$StartScript = Join-Path $BridgeRoot "scripts\start-bridge.ps1"
$PowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path (Join-Path $BridgeRoot ".env"))) {
  throw "Missing .env. Copy .env.example to .env and set IBKR_BRIDGE_TOKEN before installing the task."
}

$Action = New-ScheduledTaskAction -Execute $PowerShell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$StartScript`""
$TaskTrigger = if ($Trigger -eq "AtStartup") {
  New-ScheduledTaskTrigger -AtStartup
} else {
  New-ScheduledTaskTrigger -AtLogOn
}
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $TaskTrigger -Settings $Settings -Description "Runs the Market Command IBKR read-only options bridge." -Force | Out-Null
Write-Host "Scheduled task '$TaskName' installed with trigger $Trigger."
