<#Requires -Version 5.1
.SYNOPSIS
Starts the lnwjud Secure MCP Tunnel with long TTL, file logging, full-access
(unrestricted) mode, and automatic restart when the tunnel drops.

.DESCRIPTION
- Reads the encrypted Runtime API key from %APPDATA%\tunnel-client\lnwjud.runtime.secret (DPAPI)
- Runs `tunnel-client doctor` then `tunnel-client run`
- Passes --mcp.connection-max-ttl 168h so ChatGPT connections do not drop every 10 minutes
- Writes tunnel logs to %APPDATA%\tunnel-client\lnwjud-tunnel.log (tailed by the lnwjud dashboard)
- Aligns LNWJUD_DATA_PATH with the desktop app so MCP activity shows in the Work Log / Live Logs
- Sets LNWJUD_UNRESTRICTED=1 (full-access mode: all drives, cmd/powershell/npm.cmd allowed)
- Restarts the tunnel automatically when the process exits unexpectedly
- Opens the lnwjud log viewer window after start (use -NoViewer to skip)

.PARAMETER TunnelClientPath
Path to tunnel-client.exe. Defaults to %USERPROFILE%\Downloads\tunnel\tunnel-client.exe

.PARAMETER LnwjudPath
Path to lnwjud.exe (desktop app / viewer). Defaults to the per-user install location
%LOCALAPPDATA%\Programs\lnwjud\lnwjud.exe

.PARAMETER NoViewer
Do not open the lnwjud log viewer window.

.PARAMETER OpenDashboard
Open the full desktop dashboard instead of the small log viewer window.

.PARAMETER ForceRestart
Stop any already-running lnwjud tunnel process before starting a new one.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\ABCz\Downloads\tunnel\start-lnwjud-tunnel.ps1"
#>
param(
  [string]$TunnelClientPath = (Join-Path $env:USERPROFILE 'Downloads\tunnel\tunnel-client.exe'),
  [string]$LnwjudPath = (Join-Path $env:LOCALAPPDATA 'Programs\lnwjud\lnwjud.exe'),
  [switch]$NoViewer,
  [switch]$OpenDashboard,
  [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$profileName = 'lnwjud'
$profileDir = Join-Path $env:APPDATA 'tunnel-client'
$secretPath = Join-Path $profileDir 'lnwjud.runtime.secret'
$logPath = Join-Path $profileDir 'lnwjud-tunnel.log'

if (-not (Test-Path $TunnelClientPath)) { throw "Missing tunnel-client: $TunnelClientPath" }
if (-not (Test-Path $secretPath)) { throw "Missing encrypted runtime key: $secretPath. Save the key once with: Read-Host 'Tunnel runtime API key' -AsSecureString | ConvertFrom-SecureString | Set-Content '$secretPath'" }

function Test-LnwjudTunnelRunning {
  $probe = Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '(?i)(--profile\s+lnwjud|lnwjud\.yaml)' }
  return [bool]$probe
}

if (Test-LnwjudTunnelRunning) {
  if ($ForceRestart) {
    Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" |
      Where-Object { $_.CommandLine -match '(?i)(--profile\s+lnwjud|lnwjud\.yaml)' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  } else {
    Write-Host 'lnwjud tunnel is already running. Use -ForceRestart to restart it.'
    exit 0
  }
}

# Decrypt the DPAPI secret into this session only.
$encrypted = Get-Content $secretPath -Raw
$secureKey = ConvertTo-SecureString -String $encrypted
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

# Full-access mode: all fixed drives, cmd/powershell/npm.cmd allowed (delete commands stay blocked).
$env:LNWJUD_UNRESTRICTED = '1'
# Align with the desktop app data path so tool activity appears in the Work Log / Live Logs.
if (-not $env:LNWJUD_DATA_PATH) { $env:LNWJUD_DATA_PATH = Join-Path $env:APPDATA 'lnwjud' }
# Long connection ceiling so ChatGPT does not drop every 10 minutes (tunnel-client default).
$env:MCP_CONNECTION_MAX_TTL = '168h'

try {
  $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)

  Write-Host "lnwjud tunnel: running doctor ..."
  & $TunnelClientPath doctor --profile $profileName --profile-dir $profileDir --explain
  if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor failed with exit code $LASTEXITCODE" }

  Write-Host "lnwjud tunnel: starting (TTL 168h, log: $logPath)"
  Write-Host "lnwjud tunnel: unrestricted mode = ON, data path = $env:LNWJUD_DATA_PATH"

  if (-not $NoViewer -and (Test-Path $LnwjudPath)) {
    if ($OpenDashboard) {
      Start-Process -FilePath $LnwjudPath
    } else {
      Start-Process -FilePath $LnwjudPath -ArgumentList @('--log-viewer')
    }
  }

  # Keep the tunnel alive: restart automatically when it exits unexpectedly.
  while ($true) {
    & $TunnelClientPath run --profile $profileName --profile-dir $profileDir --log.file $logPath --mcp.connection-max-ttl 168h
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
      Write-Host "lnwjud tunnel: stopped cleanly."
      exit 0
    }
    Write-Host "lnwjud tunnel: exited with code $exitCode - restarting in 3 seconds ..."
    Start-Sleep -Seconds 3
  }
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
}
