$ErrorActionPreference = 'Stop'

$version = '0.0.13'
$assetName = "tunnel-client-v$version-windows-amd64.zip"
$assetUrl = "https://github.com/openai/tunnel-client/releases/download/v$version/$assetName"
$expectedSha256 = '17113162b353906bbb884c3ed7620facba5cc72b5fdc94fd54fd7208c7166edb'
$requiredFileNames = @(
    'tunnel-client.exe',
    'cloudflared.exe',
    'cloudflared-manifest.json',
    'LICENSE',
    'NOTICE',
    "tunnel-client-v$version-windows-amd64-licenses.txt",
    "tunnel-client-v$version-windows-amd64.spdx.json"
)

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
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    throw "tunnel-client SHA-256 mismatch. expected=$expectedSha256 actual=$actual"
}

if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

$archiveFiles = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File)
if ($archiveFiles.Count -ne $requiredFileNames.Count) {
    throw "Expected exactly $($requiredFileNames.Count) files in $assetName, found $($archiveFiles.Count)"
}
foreach ($requiredFileName in $requiredFileNames) {
    $matches = @($archiveFiles | Where-Object { $_.Name -ceq $requiredFileName })
    if ($matches.Count -ne 1) {
        throw "Expected exactly one $requiredFileName in $assetName, found $($matches.Count)"
    }
    if ($matches[0].DirectoryName -ne $extractRoot) {
        throw "Expected $requiredFileName at the archive root in $assetName"
    }
}
$unexpected = @($archiveFiles | Where-Object { $requiredFileNames -cnotcontains $_.Name })
if ($unexpected.Count -gt 0) {
    throw "Unexpected file(s) in ${assetName}: $($unexpected.Name -join ', ')"
}

if (Test-Path -LiteralPath $bundleRoot) { Remove-Item -LiteralPath $bundleRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $bundleRoot | Out-Null
foreach ($requiredFileName in $requiredFileNames) {
    Copy-Item -LiteralPath (Join-Path $extractRoot $requiredFileName) -Destination (Join-Path $bundleRoot $requiredFileName) -Force
}

$tunnelClientPath = Join-Path $bundleRoot 'tunnel-client.exe'
$cloudflaredPath = Join-Path $bundleRoot 'cloudflared.exe'
$cloudflaredManifestPath = Join-Path $bundleRoot 'cloudflared-manifest.json'
$tunnelClientSha256 = Get-Sha256Hex $tunnelClientPath
$cloudflaredSha256 = Get-Sha256Hex $cloudflaredPath
$cloudflaredManifestSha256 = Get-Sha256Hex $cloudflaredManifestPath
$cloudflaredManifest = Get-Content -LiteralPath $cloudflaredManifestPath -Raw | ConvertFrom-Json
$cloudflaredVersion = [string]$cloudflaredManifest.version
if ([string]::IsNullOrWhiteSpace($cloudflaredVersion)) {
    throw 'cloudflared-manifest.json is missing version'
}

$manifest = @(
    'OpenAI tunnel-client bundled by lnwjud',
    "version=$version",
    "asset=$assetName",
    "source=$assetUrl",
    "asset_sha256=$expectedSha256",
    "tunnel_client_sha256=$tunnelClientSha256",
    "cloudflared_version=$cloudflaredVersion",
    "cloudflared_sha256=$cloudflaredSha256",
    "cloudflared_manifest_sha256=$cloudflaredManifestSha256",
    "archive_files=$($requiredFileNames -join ';')",
    "prepared_at_utc=$([DateTime]::UtcNow.ToString('o'))"
) -join "`r`n"
[IO.File]::WriteAllText((Join-Path $bundleRoot 'BUNDLED_TUNNEL_CLIENT.txt'), $manifest + "`r`n", [Text.UTF8Encoding]::new($false))

Write-Host "Bundled tunnel-client runtime set: $bundleRoot"
Write-Host "Archive SHA-256: $expectedSha256"
Write-Host "tunnel-client.exe SHA-256: $tunnelClientSha256"
Write-Host "cloudflared.exe v$cloudflaredVersion SHA-256: $cloudflaredSha256"
Write-Host "cloudflared-manifest.json SHA-256: $cloudflaredManifestSha256"
