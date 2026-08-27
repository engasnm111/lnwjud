$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$desktopDirectory = Join-Path $repositoryRoot 'apps\desktop'
$installerDirectory = Join-Path $desktopDirectory 'dist\installers'
$rootPackage = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
$expectedArtifacts = @(
    "lnwjud-Setup-$($rootPackage.version).exe",
    "lnwjud-Setup-$($rootPackage.version).exe.blockmap",
    "lnwjud-Portable-$($rootPackage.version).exe",
    'latest.yml',
    'portable.yml',
    'SHA256SUMS.txt',
    'PROVENANCE.json'
)
$capturedSourceDirtyAtStart = $false

Push-Location $repositoryRoot
try {
    if ([string]::IsNullOrWhiteSpace($env:LNWJUD_SOURCE_DIRTY_AT_START)) {
        $sourceStatusAtStart = @(git status --porcelain=v1 --untracked-files=normal)
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to inspect repository status before Windows packaging"
        }
        $sourceDirtyAtStart = (($sourceStatusAtStart -join "`n").Trim().Length -gt 0)
        $env:LNWJUD_SOURCE_DIRTY_AT_START = if ($sourceDirtyAtStart) { '1' } else { '0' }
        $capturedSourceDirtyAtStart = $true
    }
    & corepack pnpm@10.15.0 --filter @lnwjud/desktop package:windows
    if ($LASTEXITCODE -ne 0) {
        throw "Windows packaging failed with exit code $LASTEXITCODE"
    }

    if (-not (Test-Path -LiteralPath $installerDirectory -PathType Container)) {
        throw "Installer directory was not created: $installerDirectory"
    }

    $produced = foreach ($artifactName in $expectedArtifacts) {
        $artifactPath = Join-Path $installerDirectory $artifactName
        if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
            throw "Required Windows artifact was not produced: $artifactPath"
        }
        Get-Item -LiteralPath $artifactPath
    }

    $produced | Select-Object -ExpandProperty FullName
}
finally {
    if ($capturedSourceDirtyAtStart) {
        Remove-Item Env:LNWJUD_SOURCE_DIRTY_AT_START -ErrorAction SilentlyContinue
    }
    Pop-Location
}
