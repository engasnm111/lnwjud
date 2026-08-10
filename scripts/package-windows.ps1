$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$desktopDirectory = Join-Path $repositoryRoot 'apps\desktop'
$installerDirectory = Join-Path $desktopDirectory 'dist\installers'

Push-Location $repositoryRoot
try {
    & corepack pnpm@10.15.0 --filter @lnwjud/desktop package:windows
    if ($LASTEXITCODE -ne 0) {
        throw "Windows packaging failed with exit code $LASTEXITCODE"
    }

    if (-not (Test-Path -LiteralPath $installerDirectory -PathType Container)) {
        throw "Installer directory was not created: $installerDirectory"
    }

    $installers = @(Get-ChildItem -LiteralPath $installerDirectory -Filter '*.exe' -File)
    if ($installers.Count -eq 0) {
        throw "No Windows installer was produced in $installerDirectory"
    }

    $installers | Select-Object -ExpandProperty FullName
}
finally {
    Pop-Location
}
