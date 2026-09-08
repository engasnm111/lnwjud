# Repairs only the official v4.56.0 Windows helper metadata filename.
# No user data, secrets, application binaries, or existing files are replaced.
[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\lnwjud')
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $InstallDirectory).ProviderPath
$directory = Join-Path $root 'resources\windows-secret-migrator'
$helper = Join-Path $directory 'lnwjud-windows-secret-migrator.exe'
$source = Join-Path $directory 'lnwjud-windows-secret-migrator.sha256'
$destination = Join-Path $directory 'lnwjud-windows-secret-migrator.exe.sha256'

# This digest comes from the published v4.56.0 Windows provenance.
$expected = '5a6c64343000a2a100e12742fa1240f192817d48cb5981e9644c9d291c491afe'
foreach ($file in @($helper, $source)) {
    $item = Get-Item -LiteralPath $file -Force
    if ($item.PSIsContainer) { throw 'Expected a regular release file.' }
    $cursor = $item
    while ($null -ne $cursor) {
        if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Refusing a linked or redirected installation path.'
        }
        if ($cursor -is [IO.FileInfo]) { $cursor = $cursor.Directory } else { $cursor = $cursor.Parent }
    }
}
if ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'This is not the verified official v4.56.0 helper. No changes made.'
}
$metadata = [IO.File]::ReadAllText($source).Trim()
if ($metadata -notmatch '^([0-9a-fA-F]{64})\s+lnwjud-windows-secret-migrator\.exe$' -or $Matches[1].ToLowerInvariant() -ne $expected) {
    throw 'Release metadata does not match the verified helper. No changes made.'
}
if (Test-Path -LiteralPath $destination) {
    $existing = Get-Item -LiteralPath $destination -Force
    if ($existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Refusing to overwrite existing metadata.'
    }
    if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath $source).Hash) {
        throw 'Existing compatibility metadata differs. No changes made.'
    }
    Write-Host 'Already repaired. You can reopen lnwjud.'
    return
}
[IO.File]::Copy($source, $destination, $false)
if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath $source).Hash) {
    throw 'Copied metadata verification failed. Do not launch the application.'
}
Write-Host 'Startup metadata repaired. Reopen lnwjud. Your data and secrets were not changed.'
