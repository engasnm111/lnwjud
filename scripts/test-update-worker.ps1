param(
    [string]$WorkerPath = ''
)

$ErrorActionPreference = 'Stop'
if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) {
    throw 'UPDATE_WORKER_NATIVE_TESTS_REQUIRE_WINDOWS'
}
$repositoryRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($WorkerPath)) {
    $WorkerPath = Join-Path $repositoryRoot 'apps\desktop\build\update-worker\lnwjud-update-worker.exe'
}
$WorkerPath = (Resolve-Path -LiteralPath $WorkerPath -ErrorAction Stop).Path
$project = Join-Path $repositoryRoot 'native\update-worker\tests\WindowsUpdateWorker.Tests.csproj'
$metadataFixture = (Resolve-Path -LiteralPath (Join-Path $repositoryRoot 'tests\fixtures\update-release\metadata-v1.json') -ErrorAction Stop).Path
dotnet build $project -c Release --disable-build-servers -p:UseSharedCompilation=false
if ($LASTEXITCODE -ne 0) { throw 'UPDATE_WORKER_NATIVE_TEST_BUILD_FAILED' }
dotnet run --project $project -c Release --no-build --no-restore -- $WorkerPath $metadataFixture
if ($LASTEXITCODE -ne 0) { throw 'UPDATE_WORKER_NATIVE_TESTS_FAILED' }
