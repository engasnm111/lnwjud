# Provision the real OS-protected containment service only on disposable Windows CI runners.
# This script is intentionally unavailable for normal developer machines.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_RUN_ID -notmatch '^\d+$') {
  throw 'CI_CONTAINMENT_RUNNER_REQUIRED'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'CI_CONTAINMENT_ADMINISTRATOR_REQUIRED'
}
if (Get-Service -Name 'LnwjudContainment' -ErrorAction SilentlyContinue) {
  throw 'CI_CONTAINMENT_EXISTING_SERVICE_REFUSED'
}
$source = Join-Path $PSScriptRoot '..\native\windows-containment-helper\artifacts\win-x64'
$source = [IO.Path]::GetFullPath($source)
$manifestFile = Join-Path $source 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) { throw 'CI_CONTAINMENT_MANIFEST_MISSING' }
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 2 -or $manifest.buildId -ne 'lnwjud-containment-v2' -or
    $manifest.filename -ne 'lnwjud-containment.exe' -or $manifest.pinFilename -ne 'lnwjud-containment-pin.node') {
  throw 'CI_CONTAINMENT_MANIFEST_INVALID'
}
$names = @('lnwjud-containment.exe', 'lnwjud-containment-pin.node', 'manifest.json')
$installRoot = Join-Path $env:ProgramFiles ('lnwjud-ci-' + $env:GITHUB_RUN_ID)
$target = Join-Path $installRoot 'resources\native-containment'
if (Test-Path -LiteralPath $installRoot) { throw 'CI_CONTAINMENT_INSTALL_ROOT_EXISTS' }
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach ($name in $names) {
  $from = Join-Path $source $name
  $to = Join-Path $target $name
  if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { throw "CI_CONTAINMENT_FILE_MISSING: $name" }
  Copy-Item -LiteralPath $from -Destination $to -ErrorAction Stop
  if ((Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash) {
    throw "CI_CONTAINMENT_COPY_MISMATCH: $name"
  }
}
$installedImage = Join-Path $target 'lnwjud-containment.exe'
$actualHelper = (Get-FileHash -LiteralPath $installedImage -Algorithm SHA256).Hash.ToLowerInvariant()
$actualPin = (Get-FileHash -LiteralPath (Join-Path $target 'lnwjud-containment-pin.node') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHelper -ne $manifest.sha256 -or $actualPin -ne $manifest.pinSha256) {
  throw 'CI_CONTAINMENT_HASH_MISMATCH'
}
& $installedImage service-install
if ($LASTEXITCODE -ne 0) { throw "CI_CONTAINMENT_INSTALL_FAILED: $LASTEXITCODE" }
$service = Get-CimInstance Win32_Service -Filter "Name='LnwjudContainment'"
if ($null -eq $service -or $service.State -ne 'Running' -or $service.PathName -notlike "*$installedImage*") {
  throw 'CI_CONTAINMENT_SERVICE_ATTESTATION_FAILED'
}
Write-Host "CI_CONTAINMENT_SERVICE_READY sha256=$actualHelper"
