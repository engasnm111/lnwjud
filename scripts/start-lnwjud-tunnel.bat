@echo off
chcp 65001 >nul
title lnwjud Secure Tunnel
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\Downloads\tunnel\start-lnwjud-tunnel.ps1" -OpenDashboard
if errorlevel 1 pause
