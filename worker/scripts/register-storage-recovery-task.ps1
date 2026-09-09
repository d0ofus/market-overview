param(
  [Parameter(Mandatory=$true)][string]$ConfigurationPath,
  [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$RecoveryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$RecoveryConfig = [IO.Path]::GetFullPath($ConfigurationPath)
if (-not $RecoveryConfig.StartsWith((Join-Path $RecoveryRoot 'worker/tmp/'), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'storage-task-configuration-outside-workspace'
}
$TaskConfig = Get-Content -LiteralPath $RecoveryConfig -Raw | ConvertFrom-Json
if ($TaskConfig.version -ne 1 -or $TaskConfig.autoActivate -ne $true -or $TaskConfig.codeRevision -notmatch '^[a-f0-9]{40}$') {
  throw 'storage-task-configuration-invalid'
}
$CurrentRevision = (& git -C $RecoveryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $CurrentRevision -ne $TaskConfig.codeRevision) { throw 'storage-task-checkout-mismatch' }
& git -C $RecoveryRoot diff --quiet HEAD
if ($LASTEXITCODE -ne 0) { throw 'storage-task-checkout-dirty' }
$RunAt = [DateTimeOffset]::Parse($TaskConfig.afterUtc).ToLocalTime().DateTime
$RecoveryUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('CLOUDFLARE_API_TOKEN','User'))) {
  throw 'storage-task-persistent-credential-required'
}
if ($ValidateOnly) { Write-Output 'Recovery task configuration validated; no task registered.'; exit 0 }
$RecoveryScript = Join-Path $RecoveryRoot 'worker/scripts/invoke-storage-recovery-task.ps1'
$ExistingRecovery = Get-ScheduledTask -TaskName 'MarketOverview-EodStorageRecovery' -ErrorAction SilentlyContinue
if ($ExistingRecovery -and -not (@($ExistingRecovery.Actions | Where-Object { $_.Arguments -like ('*' + $RecoveryScript + '*') }).Count)) {
  throw 'storage-task-existing-task-conflict'
}
$TaskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $RecoveryScript + '" -ConfigurationPath "' + $RecoveryConfig + '"'
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $TaskArguments -WorkingDirectory $RecoveryRoot
$Timer = New-ScheduledTaskTrigger -Once -At $RunAt -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 14)
$Logon = New-ScheduledTaskTrigger -AtLogOn -User $RecoveryUser
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 75) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$Principal = New-ScheduledTaskPrincipal -UserId $RecoveryUser -LogonType Interactive -RunLevel Limited
$Task = New-ScheduledTask -Action $Action -Trigger @($Timer,$Logon) -Settings $Settings -Principal $Principal -Description 'Resume the reviewed EOD storage rollout after quota reset; acceptance gates control public cutover.'
Register-ScheduledTask -TaskName 'MarketOverview-EodStorageRecovery' -InputObject $Task -Force | Select-Object TaskName,State
