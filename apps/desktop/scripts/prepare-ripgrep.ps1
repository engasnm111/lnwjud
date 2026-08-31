$ErrorActionPreference = 'Stop'

$version = '15.2.0'
$assetName = "ripgrep-$version-x86_64-pc-windows-msvc.zip"
$assetUrl = "https://github.com/BurntSushi/ripgrep/releases/download/$version/$assetName"
$expectedSha256 = '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5'

$desktopRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $desktopRoot 'build'
$vendorRoot = Join-Path $buildRoot 'vendor'
$zipPath = Join-Path $vendorRoot $assetName
$extractRoot = Join-Path $vendorRoot "ripgrep-$version-windows-x64"
$bundleRoot = Join-Path $buildRoot 'runtime-tools\ripgrep'

New-Item -ItemType Directory -Force -Path $vendorRoot | Out-Null

function Get-Sha256Hex([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $bytes = $sha256.ComputeHash($stream)
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Test-ExpectedHash([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $actual = Get-Sha256Hex $Path
    return $actual -eq $expectedSha256
}

if (-not (Test-ExpectedHash $zipPath)) {
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Write-Host "Downloading official ripgrep v$version for Windows x64..."
    Invoke-WebRequest -UseBasicParsing -Uri $assetUrl -OutFile $zipPath
}

if (-not (Test-ExpectedHash $zipPath)) {
    $actual = if (Test-Path -LiteralPath $zipPath) { Get-Sha256Hex $zipPath } else { '<missing>' }
    throw "ripgrep SHA-256 mismatch. expected=$expectedSha256 actual=$actual"
}

if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

$executables = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter 'rg.exe')
if ($executables.Count -ne 1) {
    throw "Expected exactly one rg.exe in $assetName, found $($executables.Count)"
}

if (Test-Path -LiteralPath $bundleRoot) { Remove-Item -LiteralPath $bundleRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $bundleRoot | Out-Null
Copy-Item -LiteralPath $executables[0].FullName -Destination (Join-Path $bundleRoot 'rg.exe') -Force

$notices = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File | Where-Object { $_.Name -match '(?i)^(license|unlicense|copying|notice)' })
foreach ($notice in $notices) {
    $destination = Join-Path $bundleRoot $notice.Name
    if (-not (Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath $notice.FullName -Destination $destination -Force }
}

$manifest = @(
    "ripgrep bundled by lnwjud",
    "version=$version",
    "asset=$assetName",
    "source=$assetUrl",
    "asset_sha256=$expectedSha256",
    "prepared_at_utc=$([DateTime]::UtcNow.ToString('o'))"
) -join "`r`n"
[IO.File]::WriteAllText((Join-Path $bundleRoot 'BUNDLED_RIPGREP.txt'), $manifest + "`r`n", [Text.UTF8Encoding]::new($false))

$exeHash = Get-Sha256Hex (Join-Path $bundleRoot 'rg.exe')
Write-Host "Bundled rg.exe: $(Join-Path $bundleRoot 'rg.exe')"
Write-Host "Archive SHA-256: $expectedSha256"
Write-Host "Executable SHA-256: $exeHash"
