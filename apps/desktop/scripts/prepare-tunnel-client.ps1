$ErrorActionPreference = 'Stop'

$desktopRoot = Split-Path -Parent $PSScriptRoot
Push-Location $desktopRoot
try {
    & node scripts/prepare-tunnel-client.mjs
    if ($LASTEXITCODE -ne 0) {
        throw "Target-native tunnel-client preparation failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
