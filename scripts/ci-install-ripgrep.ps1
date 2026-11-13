# Use the fixed official ripgrep v14.1.1 Windows MSVC build for CI.
# Do not replace this SHA-256 pin without independent official release verification.
[CmdletBinding()]
param([string]$DestinationName = 'ripgrep-ci')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$version = '14.1.1'
$expectedArchiveSha256 = 'd0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1'
$primaryUrl = 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip'
$apiUrl = 'https://api.github.com/repos/BurntSushi/ripgrep/releases/assets/191354245'

if ($DestinationName -notmatch '^[A-Za-z0-9._-]{1,80}$' -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { throw 'RIPGREP_CI_DESTINATION_REFUSED' }

$existing = Get-Command rg -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    & rg --version
    if ($LASTEXITCODE -ne 0) { throw 'RIPGREP_CI_EXISTING_EXECUTABLE_FAILED' }
    return
}

$destinationDirectory = Join-Path $env:RUNNER_TEMP $DestinationName
if (Test-Path -LiteralPath $destinationDirectory) { throw 'RIPGREP_CI_DESTINATION_CONFLICT' }
New-Item -ItemType Directory -Path $destinationDirectory -ErrorAction Stop | Out-Null
$archive = Join-Path $destinationDirectory 'ripgrep.zip'
$downloaded = $false
foreach ($sourceUrl in @($primaryUrl, $apiUrl)) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $request = @{ Uri = $sourceUrl; OutFile = $archive; MaximumRedirection = 5
                          TimeoutSec = 90; UseBasicParsing = $true; ErrorAction = 'Stop' }
            if ($sourceUrl -eq $apiUrl) {
                $request.Headers = @{ Accept = 'application/octet-stream'; 'User-Agent' = 'lnwjud-pinned-ripgrep' }
            }
            Invoke-WebRequest @request
            $downloaded = $true
            break
        } catch {
            $statusCode = $null
            $responseProperty = $_.Exception.PSObject.Properties['Response']
            if ($null -ne $responseProperty -and $null -ne $responseProperty.Value) {
                $statusCode = [int]$responseProperty.Value.StatusCode
            }
            if ($null -eq $statusCode -and $_.Exception.Message -match '^(?:HTTP\s+)?(408|429|500|502|503|504)(?:\b|\s)') {
                $statusCode = [int]$Matches[1]
            }
            $transientStatus = $statusCode -in @(408, 429, 500, 502, 503, 504)
            $transientTransport = $_.Exception -is [System.Net.WebException] -and
                $_.Exception.Status -in @([System.Net.WebExceptionStatus]::Timeout, [System.Net.WebExceptionStatus]::ConnectionClosed)
            # pwsh 7 reports configured HttpClient timeouts without WebException.Status.
            $httpClientTimeout = $_.Exception.Message -match 'configured HttpClient[.]Timeout of [0-9]+ seconds elapsing'
            if (-not $transientStatus -and -not $transientTransport -and -not $httpClientTimeout) { throw }
            if (Test-Path -LiteralPath $archive) {
                Remove-Item -LiteralPath $archive -Force -ErrorAction Stop
            }
            if ($attempt -eq 3) {
                if ($sourceUrl -eq $apiUrl) { throw }
                break
            }
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
    if ($downloaded) { break }
}
if (-not $downloaded) { throw 'RIPGREP_CI_DOWNLOAD_UNAVAILABLE' }
# The 2-MiB official asset is capped before reading so hashing does not depend
# on PowerShell module auto-loading on clean hosted Windows images.
$archiveSize = (Get-Item -LiteralPath $archive -ErrorAction Stop).Length
if ($archiveSize -lt 1 -or $archiveSize -gt 4MB) { throw 'RIPGREP_CI_ARCHIVE_SIZE_REFUSED' }
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $actualArchiveSha256 = [BitConverter]::ToString(
        $sha256.ComputeHash([System.IO.File]::ReadAllBytes($archive))
    ).Replace('-', '').ToLowerInvariant()
} finally { $sha256.Dispose() }
if ($actualArchiveSha256 -cne $expectedArchiveSha256) { throw 'RIPGREP_CI_ARCHIVE_DIGEST_MISMATCH' }

Expand-Archive -LiteralPath $archive -DestinationPath $destinationDirectory -ErrorAction Stop
$rgExecutables = @(Get-ChildItem -LiteralPath $destinationDirectory -Filter rg.exe -File -Recurse)
if ($rgExecutables.Count -ne 1) { throw 'RIPGREP_CI_ARCHIVE_LAYOUT_REFUSED' }
$target = Join-Path $destinationDirectory 'rg.exe'
if ($rgExecutables[0].FullName -cne $target) {
    Copy-Item -LiteralPath $rgExecutables[0].FullName -Destination $target -ErrorAction Stop
}
$env:PATH = "$destinationDirectory;$env:PATH"
if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_PATH)) {
    $destinationDirectory | Out-File -LiteralPath $env:GITHUB_PATH -Encoding utf8 -Append
}
& $target --version
if ($LASTEXITCODE -ne 0) { throw 'RIPGREP_CI_EXECUTION_FAILED' }
