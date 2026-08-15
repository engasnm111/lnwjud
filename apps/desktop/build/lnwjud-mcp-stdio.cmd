@echo off
setlocal
set "NODE_EXE="
where node >nul 2>nul && for /f "delims=" %%I in ('where node') do (
  if not defined NODE_EXE set "NODE_EXE=%%I"
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE (
  echo lnwjud-mcp-stdio: Node.js 24+ is required. 1>&2
  exit /b 1
)
set "SCRIPT=%~dp0lnwjud-mcp-stdio.cjs"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0resources\lnwjud-mcp-stdio.cjs"
if not exist "%SCRIPT%" (
  echo lnwjud-mcp-stdio: launcher script missing: %SCRIPT% 1>&2
  exit /b 1
)
rem Trusted E:\ machine root + registered project workspaces. Pass --reset-workspaces after wipe.
"%NODE_EXE%" "%SCRIPT%" %*
