param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $repoRoot 'native\windows-ocr\bin'
$helperPath = Join-Path $binDir 'lnwjud-windows-ocr.exe'

New-Item -ItemType Directory -Path $binDir -Force | Out-Null

if ((-not $Force) -and (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
  Write-Host "Windows OCR helper already prepared: $helperPath"
  exit 0
}

$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if ($null -eq $dotnet) {
  Write-Host 'Optional Windows OCR helper was not built because the .NET SDK is unavailable. Core installer/portable packaging will continue without OCR.'
  exit 0
}

$sdkLines = @(& $dotnet.Source --list-sdks 2>$null)
if ($LASTEXITCODE -ne 0 -or $sdkLines.Count -eq 0) {
  Write-Host 'Optional Windows OCR helper was not built because no .NET SDK is installed. Core installer/portable packaging will continue without OCR.'
  exit 0
}

& (Join-Path $PSScriptRoot 'build-windows-ocr.ps1')
if ($LASTEXITCODE -ne 0) {
  throw "Windows OCR helper build failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
  throw "Windows OCR helper build completed without producing: $helperPath"
}

Write-Host "Windows OCR helper prepared: $helperPath"
