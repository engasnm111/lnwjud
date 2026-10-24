# Build an installable v5.9.0 validation candidate on the actual Windows developer machine.
# This script does not stage, commit, clean, reset, push, start, stop, or mutate any service.
# Run it from a LOCAL PowerShell terminal after inspecting source changes.
[CmdletBinding()]
param([switch]$RequireInstalledService)
# Bootstrap mode builds a replacement for the installed service and cannot
# claim that the *old* installed service passed native dispatch acceptance.
# -RequireInstalledService additionally enforces end-to-end tests once the
# repaired installer has been installed. Never mark these tests as passed in bootstrap mode.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$versionFile = Join-Path $repositoryRoot 'package.json'
$testProject = Join-Path $repositoryRoot 'native\windows-containment-helper\tests\ContainmentNativeTests.csproj'
$installerDirectory = Join-Path $repositoryRoot 'apps\desktop\dist\installers'
$logDirectory = Join-Path $repositoryRoot '.audit\v5.9.0-rebuild'
$startedUtc = (Get-Date).ToUniversalTime()
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$transcriptPath = Join-Path $logDirectory ("validation-$stamp.log")
$transcriptStarted = $false

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    Write-Host ("[RUN] " + $Executable + ' ' + ($Arguments -join ' '))
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw ("Command failed (exit " + $LASTEXITCODE + '): ' + $Executable + ' ' + ($Arguments -join ' ')) }
}

Push-Location $repositoryRoot
try {
    Start-Transcript -LiteralPath $transcriptPath -ErrorAction Stop | Out-Null
    $transcriptStarted = $true
    Write-Host "Windows v5.9.0 candidate build; source folder: $repositoryRoot"
    foreach ($executable in @('git', 'node', 'corepack', 'dotnet', 'powershell.exe')) {
        if (-not (Get-Command $executable -ErrorAction SilentlyContinue)) { throw "Missing required executable: $executable" }
    }
    $version = (Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json).version
    if ($version -ne '5.9.0') { throw "Refusing to package unexpected version $version" }
    $branch = (& git branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'dev') { throw "Expected development branch dev, got $branch" }
    Write-Host '[INFO] Dirty source and all untracked files are preserved; this is a candidate, not a released SHA.'
    Invoke-Checked 'git' @('status','--short')
    Invoke-Checked 'corepack' @('pnpm@10.15.0','install','--frozen-lockfile')
    Invoke-Checked 'dotnet' @('run','--project',$testProject,'-c','Release')
    Invoke-Checked 'corepack' @('pnpm@10.15.0','--filter','@lnwjud/process','exec','vitest','run','src/windows-native-authority-service.test.ts','src/windows-native-attempt.test.ts')
    if ($RequireInstalledService) {
        Invoke-Checked 'corepack' @('pnpm@10.15.0','--filter','@lnwjud/process','exec','vitest','run','src/windows-native-authority.test.ts')
    } else {
        Write-Warning '[DEFERRED, NOT PASSED] windows-native-authority.test.ts requires a working, matching installed SCM service. A new installer is needed to test this safely; it will be mandatory after user installation and before public release.'
    }
    Invoke-Checked 'corepack' @('pnpm@10.15.0','--filter','@lnwjud/application','exec','vitest','run','src/process-service.test.ts')
    Invoke-Checked 'corepack' @('pnpm@10.15.0','--filter','@lnwjud/desktop','exec','vitest','run','tests/release-notes.test.ts')
    Invoke-Checked 'corepack' @('pnpm@10.15.0','typecheck')
    Invoke-Checked 'powershell.exe' @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $repositoryRoot 'scripts\package-windows.ps1'))

    $expected = @("lnwjud-Setup-$version.exe", "lnwjud-Setup-$version.exe.blockmap",
        "lnwjud-Portable-$version.exe", 'latest.yml', 'portable.yml', 'SHA256SUMS.txt', 'PROVENANCE.json')
    foreach ($name in $expected) {
        $file = Join-Path $installerDirectory $name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing package artifact: $file" }
        if ((Get-Item -LiteralPath $file).LastWriteTimeUtc -lt $startedUtc.AddSeconds(-30)) {
            throw "Found a stale package artifact instead of a rebuilt file: $file"
        }
    }
    $hashes = foreach ($name in @("lnwjud-Setup-$version.exe", "lnwjud-Portable-$version.exe")) {
        $file = Join-Path $installerDirectory $name
        $item = Get-Item -LiteralPath $file
        [pscustomobject]@{
            Filename = $item.Name
            Bytes = $item.Length
            SHA256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
            Path = $item.FullName
        }
    }
    $hashPath = Join-Path $logDirectory ("candidate-sha256-$stamp.txt")
    $hashes | Format-Table -AutoSize | Out-String -Width 4096 | Set-Content -LiteralPath $hashPath -Encoding UTF8
    if ($RequireInstalledService) {
        Write-Host 'BUILD_AND_TARGETED_TESTS_PASSED; installed-service tests ran (not full official release acceptance)'
    } else {
        Write-Warning 'BOOTSTRAP_INSTALLER_CREATED; INSTALLED_NATIVE_SERVICE_ACCEPTANCE_NOT_RUN. This is not an official release.'
    }
    $hashes | Format-List | Out-Host
    Write-Host "Candidate checksums: $hashPath"
    Write-Host "Validation log: $transcriptPath"
    Write-Host 'Install the Setup candidate manually, then reconnect lnwjud-pc and run native shell/process acceptance.'
}
catch {
    Write-Error ("BUILD_BLOCKED: " + $_.Exception.Message)
    throw
}
finally {
    if ($transcriptStarted) { Stop-Transcript | Out-Null }
    Pop-Location
}
