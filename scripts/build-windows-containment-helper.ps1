param([string]$OutputDirectory = (Join-Path $PSScriptRoot '../native/windows-containment-helper/artifacts/win-x64'))
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required' }
$project = Join-Path $PSScriptRoot '../native/windows-containment-helper/WindowsContainmentHelper.csproj'
dotnet publish $project -c Release -r win-x64 --self-contained true -o $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw "Containment helper publish failed: $LASTEXITCODE" }
node (Join-Path $PSScriptRoot '../native/windows-containment-helper/pin/build.mjs') $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw "Containment pin build failed: $LASTEXITCODE" }
$executable = Join-Path $OutputDirectory 'lnwjud-containment.exe'
$manifest = @{ schemaVersion = 2; buildId = 'lnwjud-containment-v2'; platform = 'win32'; architecture = 'x64'; filename = 'lnwjud-containment.exe'; sha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant(); pinFilename = 'lnwjud-containment-pin.node'; pinSha256 = (Get-FileHash -LiteralPath (Join-Path $OutputDirectory 'lnwjud-containment-pin.node') -Algorithm SHA256).Hash.ToLowerInvariant() }
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'manifest.json'), ($manifest | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
Write-Host "Verified helper output: $OutputDirectory"
