param(
  [int]$Bytes = 32
)

$buffer = [byte[]]::new($Bytes)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($buffer)
} finally {
  $rng.Dispose()
}

($buffer | ForEach-Object { $_.ToString("x2") }) -join ""
