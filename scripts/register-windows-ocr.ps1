# Builds, signs, and registers the sparse package that gives the WinRT OCR
# helper package identity (Wave 3). Two modes:
#   dev (default): creates/reuses a self-signed certificate, trusts it in
#                  LocalMachine\TrustedPeople (requires an elevated prompt for
#                  the trust step), and registers the package for the user.
#   release:       -ReleaseCertPfx/-ReleaseCertPassword with the real release
#                  certificate; the publisher in the manifest must match it.
# Requires: dotnet SDK 8+, Windows SDK makeappx.exe + signtool.exe (searched
# from the machine's ProgramFiles(x86)/ProgramFiles Windows SDK roots).
[CmdletBinding()]
param(
  [string]$ReleaseCertPfx,
  [string]$ReleaseCertPassword,
  [string]$DevCertSubject = 'CN=lnwjud-windows-ocr-dev'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$ocrDir = Join-Path $projectRoot 'native\windows-ocr'
$binDir = Join-Path $ocrDir 'bin'
$helper = Join-Path $binDir 'lnwjud-windows-ocr.exe'
if (-not (Test-Path $helper)) {
  Write-Error "Helper not built. Run scripts\build-windows-ocr.ps1 first."
}

function Find-SdkTool([string]$Name) {
  $found = Get-Command $Name -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }

  $programFilesRoots = @(
    [System.Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
    $env:ProgramFiles
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

  foreach ($programFilesRoot in $programFilesRoots) {
    $kitsRoot = Join-Path $programFilesRoot 'Windows Kits\10\bin'
    if (-not (Test-Path -LiteralPath $kitsRoot -PathType Container)) { continue }
    $candidate = Get-ChildItem -LiteralPath $kitsRoot -Directory |
      ForEach-Object { Join-Path $_.FullName "x64\$Name" } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Sort-Object -Descending |
      Select-Object -First 1
    if ($candidate) { return $candidate }
  }
  Write-Error "$Name not found. Install the Windows SDK (makeappx/signtool) or add it to PATH."
}

$makeappx = Find-SdkTool 'makeappx.exe'
$signtool = Find-SdkTool 'signtool.exe'
Write-Host "makeappx: $makeappx"
Write-Host "signtool: $signtool"

# Resolve the certificate and the publisher string it implies.
if ($ReleaseCertPfx) {
  if (-not $ReleaseCertPassword) { Write-Error '-ReleaseCertPassword is required with -ReleaseCertPfx.' }
  $publisher = & $signtool dump /f $ReleaseCertPfx /p $ReleaseCertPassword |
    Select-String -Pattern 'Issuer:\s+(CN=.+)$'
  if (-not $publisher) { Write-Error 'Could not read the certificate subject. Is the password correct?' }
  $publisher = $publisher.Matches[0].Groups[1].Value.Trim()
} else {
  $existing = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq $DevCertSubject -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if ($existing) {
    Write-Host "Reusing dev certificate $($existing.Thumbprint)"
  } else {
    $created = New-SelfSignedCertificate -Type Custom -Subject $DevCertSubject `
      -KeyUsage DigitalSignature -FriendlyName 'lnwjud Windows OCR dev signing' `
      -CertStoreLocation 'Cert:\CurrentUser\My' `
      -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
    Write-Host "Created dev certificate $($created.Thumbprint)"
  }
  $cert = $existing ?? $created
  $publisher = $cert.Subject
  # Sparse-package signature validation requires the signer in TrustedPeople
  # (machine scope). Best-effort with clear guidance when not elevated.
  try {
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new('TrustedPeople', 'LocalMachine')
    $store.Open('ReadWrite')
    $store.Add($cert)
    $store.Close()
    Write-Host 'Trusted the dev certificate in LocalMachine\TrustedPeople.'
  } catch {
    Write-Warning "Could not write to LocalMachine\TrustedPeople ($($_.Exception.Message))."
    Write-Warning 'Run this script from an elevated prompt once, or import the cert manually:'
    Write-Warning "  certutil -addstore TrustedPeople ``"$($cert.Subject)``" (after exporting the public key)"
  }
}

Write-Host "Publisher: $publisher"

# Stage the MSIX payload (manifest with the real publisher + assets).
$staging = Join-Path $ocrDir 'obj\sparse-staging'
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item $staging -ItemType Directory | Out-Null
$manifest = Get-Content (Join-Path $ocrDir 'sparse-package.appxmanifest') -Raw
$manifest = $manifest.Replace('CN=REPLACE_WITH_SIGNING_CERTIFICATE', $publisher)
Set-Content (Join-Path $staging 'AppxManifest.xml') -Value $manifest -Encoding UTF8
Copy-Item (Join-Path $ocrDir 'Assets') -Destination (Join-Path $staging 'Assets') -Recurse

$msix = Join-Path $ocrDir 'obj\lnwjud-windows-ocr.sparse.msix'
& $makeappx pack /v /h sha256 /d $staging /p $msix /nw
if ($LASTEXITCODE -ne 0) { Write-Error 'makeappx failed.' }

if ($ReleaseCertPfx) {
  & $signtool sign /fd SHA256 /f $ReleaseCertPfx /p $ReleaseCertPassword $msix
} else {
  & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint $msix
}
if ($LASTEXITCODE -ne 0) { Write-Error 'signtool failed.' }

Add-AppxPackage -Path $msix -ExternalLocation $binDir
Write-Host 'Sparse package registered with external location.'

# Verify identity end to end through the helper's probe op.
$probe = '{"op":"probe"}' | & $helper
Write-Host "Helper probe: $probe"
if ($probe -notmatch '"package_identity":\s*true') {
  Write-Error 'Registration did not grant package identity to the helper.'
}
Write-Host 'Wave 3 registration complete: vision OCR should now report available.'
