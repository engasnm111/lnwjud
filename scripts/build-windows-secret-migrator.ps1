$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repositoryRoot 'native\windows-secret-migrator\lnwjud-windows-secret-migrator.csproj'
$output = Join-Path $repositoryRoot 'native\windows-secret-migrator\bin\win-x64'
$hashPath = Join-Path $output 'lnwjud-windows-secret-migrator.sha256'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'dotnet SDK is required to build the Windows secret migrator'
}

if (Test-Path -LiteralPath $output) {
    Remove-Item -LiteralPath $output -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $output | Out-Null

dotnet publish $project --configuration Release --runtime win-x64 --self-contained true --output $output /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true /p:EnableWindowsTargeting=true

$executable = Join-Path $output 'lnwjud-windows-secret-migrator.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw 'Windows secret migrator publish did not produce the expected executable'
}
Get-ChildItem -LiteralPath $output -File | Where-Object { $_.FullName -ne $executable } | Remove-Item -Force
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $hash = [BitConverter]::ToString($sha256.ComputeHash([System.IO.File]::ReadAllBytes($executable))).Replace('-', '').ToLowerInvariant()
}
finally {
    $sha256.Dispose()
}
Set-Content -LiteralPath $hashPath -Value "$hash  lnwjud-windows-secret-migrator.exe" -Encoding ascii
Write-Host "Built $executable"
Write-Host "SHA-256 $hash"
