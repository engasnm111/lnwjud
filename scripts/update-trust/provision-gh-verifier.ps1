# Provision a fixed GitHub CLI attestation verifier without enrolling update trust.
# The archive and extracted executable must both match reviewed SHA-256 pins.
[CmdletBinding()]
param([string]$ArchivePath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$version = '2.103.3'
$archiveHash = '98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0'
$executableHash = 'd303d8ac3f5e9438bf7c977b64dd6425513eae46218f8881d30694f28c1d0dfd'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$destination = Join-Path $repositoryRoot 'tools/update-attestation/gh.exe'
$tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ('lnwjud-gh-verifier-' + [guid]::NewGuid().ToString('N'))
$zip = $null

function Get-PinnedFileSha256([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        # Use the streaming .NET API, not Get-FileHash: the latter may not be
        # loaded in the constrained hosted Windows PowerShell runner.
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

try {
    New-Item -ItemType Directory -Path $tempDirectory -ErrorAction Stop | Out-Null
    if ([string]::IsNullOrWhiteSpace($ArchivePath)) {
        $ArchivePath = Join-Path $tempDirectory "gh_${version}_windows_amd64.zip"
        $uri = "https://github.com/cli/cli/releases/download/v${version}/gh_${version}_windows_amd64.zip"
        Invoke-WebRequest -Uri $uri -OutFile $ArchivePath -MaximumRedirection 5 -TimeoutSec 120 -UseBasicParsing -ErrorAction Stop
    } else {
        $ArchivePath = (Resolve-Path -LiteralPath $ArchivePath -ErrorAction Stop).Path
    }

    if ((Get-PinnedFileSha256 $ArchivePath) -ne $archiveHash) {
        throw 'VERIFIER_ARCHIVE_DIGEST_MISMATCH'
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    $entry = $zip.GetEntry('bin/gh.exe')
    if ($null -eq $entry -or $entry.Length -le 0 -or $entry.Length -gt 100MB) {
        throw 'VERIFIER_ARCHIVE_ENTRY_INVALID'
    }
    $candidate = Join-Path $tempDirectory 'gh.exe'
    $source = $entry.Open()
    try {
        $output = [IO.File]::Create($candidate)
        try { $source.CopyTo($output) } finally { $output.Dispose() }
    } finally { $source.Dispose() }
    $zip.Dispose()
    $zip = $null

    if ((Get-PinnedFileSha256 $candidate) -ne $executableHash) {
        throw 'VERIFIER_EXECUTABLE_DIGEST_MISMATCH'
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $candidate
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch 'O="GitHub, Inc\."') {
        throw 'VERIFIER_AUTHENTICODE_INVALID'
    }
    $reported = @(& $candidate --version)
    if ($LASTEXITCODE -ne 0 -or $reported.Count -eq 0 -or $reported[0] -notmatch '^gh version 2\.103\.3 ') {
        throw 'VERIFIER_VERSION_INVALID'
    }

    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    if (Test-Path -LiteralPath $destination) {
        $existing = Get-Item -LiteralPath $destination -Force
        if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            (Get-PinnedFileSha256 $destination) -ne $executableHash) {
            throw 'VERIFIER_DESTINATION_CONFLICT'
        }
    } else {
        # Atomic create-only: a concurrent replacement must never be overwritten.
        [IO.File]::Copy($candidate, $destination, $false)
    }
    if ((Get-PinnedFileSha256 $destination) -ne $executableHash) {
        throw 'VERIFIER_PUBLICATION_UNVERIFIED'
    }
    Write-Output "VERIFIER_PROVISIONED version=$version sha256=$executableHash"
    Write-Output 'This is a local pinned verifier only; update policy and native installation remain disabled.'
} finally {
    if ($null -ne $zip) { $zip.Dispose() }
    if (Test-Path -LiteralPath $tempDirectory) {
        Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
