$ErrorActionPreference = 'Stop'

$version = '0.0.13'
$assetName = "tunnel-client-v$version-windows-amd64.zip"
$assetUrl = "https://github.com/openai/tunnel-client/releases/download/v$version/$assetName"
$expectedSha256 = '17113162b353906bbb884c3ed7620facba5cc72b5fdc94fd54fd7208c7166edb'

$desktopRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $desktopRoot 'build'
$vendorRoot = Join-Path $buildRoot 'vendor'
$zipPath = Join-Path $vendorRoot $assetName
$extractRoot = Join-Path $vendorRoot "tunnel-client-v$version-windows-amd64"
$bundleRoot = Join-Path $buildRoot 'tunnel-client'

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
    Write-Host "Downloading official OpenAI tunnel-client v$version for Windows x64..."
    Invoke-WebRequest -UseBasicParsing -Uri $assetUrl -OutFile $zipPath
}

if (-not (Test-ExpectedHash $zipPath)) {
    $actual = if (Test-Path -LiteralPath $zipPath) { Get-Sha256Hex $zipPath } else { '<missing>' }
    throw "tunnel-client SHA-256 mismatch. expected=$expectedSha256 actual=$actual"
}

if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

$executables = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter 'tunnel-client.exe')
if ($executables.Count -ne 1) {
    throw "Expected exactly one tunnel-client.exe in $assetName, found $($executables.Count)"
}

if (Test-Path -LiteralPath $bundleRoot) { Remove-Item -LiteralPath $bundleRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $bundleRoot | Out-Null
Copy-Item -LiteralPath $executables[0].FullName -Destination (Join-Path $bundleRoot 'tunnel-client.exe') -Force

$notices = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File | Where-Object { $_.Name -match '(?i)(license|notice|spdx)' })
foreach ($notice in $notices) {
    $destination = Join-Path $bundleRoot $notice.Name
    if (-not (Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath $notice.FullName -Destination $destination -Force }
}

$manifest = @(
    "OpenAI tunnel-client bundled by lnwjud",
    "version=$version",
    "asset=$assetName",
    "source=$assetUrl",
    "asset_sha256=$expectedSha256",
    "prepared_at_utc=$([DateTime]::UtcNow.ToString('o'))"
) -join "`r`n"
[IO.File]::WriteAllText((Join-Path $bundleRoot 'BUNDLED_TUNNEL_CLIENT.txt'), $manifest + "`r`n", [Text.UTF8Encoding]::new($false))

$exeHash = Get-Sha256Hex (Join-Path $bundleRoot 'tunnel-client.exe')
Write-Host "Bundled tunnel-client.exe: $(Join-Path $bundleRoot 'tunnel-client.exe')"
Write-Host "Archive SHA-256: $expectedSha256"
Write-Host "Executable SHA-256: $exeHash"
