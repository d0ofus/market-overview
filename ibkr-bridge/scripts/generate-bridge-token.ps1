param(
  [int]$Bytes = 32
)

$buffer = [byte[]]::new($Bytes)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
[Convert]::ToHexString($buffer).ToLowerInvariant()
