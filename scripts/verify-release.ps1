[CmdletBinding()]
param(
    [switch]$SkipWindowsPackaging
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$previousSourceDirtyAtStart = $env:LNWJUD_SOURCE_DIRTY_AT_START

function Invoke-ReleaseStage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    Write-Host "==> $Name"
    & corepack pnpm@10.15.0 @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Release stage '$Name' failed with exit code $LASTEXITCODE"
    }
}

function Assert-RepositoryChecks {
    Write-Host '==> git diff --check'
    & git diff --check
    if ($LASTEXITCODE -ne 0) {
        throw "git diff --check failed with exit code $LASTEXITCODE"
    }

    $trackedFiles = @(git ls-files)
    $requiredTrackedFiles = @(
        'docs/architecture/MUTATION_SAFETY_MATRIX.md'
    )
    $missingRequiredTrackedFiles = @($requiredTrackedFiles | Where-Object { $_ -notin $trackedFiles })
    if ($missingRequiredTrackedFiles.Count -gt 0) {
        throw "Required release files are not tracked: $($missingRequiredTrackedFiles -join ', ')"
    }

    $forbiddenTrackedFiles = @($trackedFiles | Where-Object {
        $normalized = $_.Replace('\', '/')
        (($normalized -match '(^|/)(\.env|\.env\..+)$') -and ($normalized -notmatch '(^|/)\.env\.example$')) -or
        ($normalized -match '(^|/)(.+\.(pem|key)|id_rsa.*|id_ed25519.*|\.ssh/.*|\.aws/.*|credentials\.json)$')
    })
    if ($forbiddenTrackedFiles.Count -gt 0) {
        throw "Forbidden secret-like tracked paths found: $($forbiddenTrackedFiles -join ', ')"
    }
}

Push-Location $repositoryRoot
try {
    $sourceStatusAtStart = @(git status --porcelain=v1 --untracked-files=normal)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect repository status before release verification"
    }
    $sourceDirtyAtStart = (($sourceStatusAtStart -join "`n").Trim().Length -gt 0)
    $env:LNWJUD_SOURCE_DIRTY_AT_START = if ($sourceDirtyAtStart) { '1' } else { '0' }
    if ($env:GITHUB_ACTIONS -eq 'true' -and $sourceDirtyAtStart) {
        throw "GitHub release verification requires a clean source tree before verification begins"
    }

    Assert-RepositoryChecks
    Invoke-ReleaseStage 'install --frozen-lockfile' @('install', '--frozen-lockfile')
    Invoke-ReleaseStage 'lint' @('lint')
    Invoke-ReleaseStage 'typecheck' @('typecheck')
    Invoke-ReleaseStage 'test:release' @('test:release')
    Invoke-ReleaseStage 'test:acceptance' @('test:acceptance')
    Invoke-ReleaseStage 'test:integration' @('test:integration')
    Invoke-ReleaseStage 'test:e2e' @('test:e2e')
    Invoke-ReleaseStage 'build' @('build')
    Invoke-ReleaseStage 'docs:tools:check' @('docs:tools:check')
    Invoke-ReleaseStage 'test:packaging' @('test:packaging')
    Invoke-ReleaseStage 'test:release-gate' @('test:release-gate')

    if ($SkipWindowsPackaging) {
        Write-Host '==> package:windows (skipped for non-main CI)'
    }
    else {
        Invoke-ReleaseStage 'package:windows' @('package:windows')

        $installerDirectory = Join-Path $repositoryRoot 'apps\desktop\dist\installers'
        if (-not (Test-Path -LiteralPath $installerDirectory -PathType Container)) {
            throw "Packaged-app smoke could not find installer directory: $installerDirectory"
        }
        $rootPackage = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
        $requiredWindowsArtifacts = @(
            "lnwjud-Setup-$($rootPackage.version).exe",
            "lnwjud-Setup-$($rootPackage.version).exe.blockmap",
            "lnwjud-Portable-$($rootPackage.version).exe",
            'latest.yml',
            'portable.yml',
            'SHA256SUMS.txt',
            'PROVENANCE.json'
        )
        foreach ($artifactName in $requiredWindowsArtifacts) {
            $artifactPath = Join-Path $installerDirectory $artifactName
            if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
                throw "Packaged-app smoke could not find required Windows artifact '$artifactName' in: $installerDirectory"
            }
            Write-Host "Packaged-app smoke artifact: $artifactPath"
        }
    }
    Assert-RepositoryChecks
    Write-Host 'Release verification gate completed.'
}
finally {
    if ($null -eq $previousSourceDirtyAtStart) {
        Remove-Item Env:LNWJUD_SOURCE_DIRTY_AT_START -ErrorAction SilentlyContinue
    }
    else {
        $env:LNWJUD_SOURCE_DIRTY_AT_START = $previousSourceDirtyAtStart
    }
    Pop-Location
}
