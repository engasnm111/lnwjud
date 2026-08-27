@echo off
chcp 65001 >nul
title lnwjud Secure Tunnel
if not exist "%~dp0start-lnwjud-tunnel.ps1" (
  echo Missing companion script: %~dp0start-lnwjud-tunnel.ps1
  exit /b 1
)
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0start-lnwjud-tunnel.ps1" -OpenDashboard
if errorlevel 1 pause
