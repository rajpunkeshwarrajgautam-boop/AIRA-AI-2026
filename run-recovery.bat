@echo off
cd /d "C:\Users\WORKSTATION\AIRA-PR183-MIGRATION-HARDENING"
title AIRA AI 2026 - DPAPI-Free Disaster Recovery Console
echo ========================================================================
echo  Launching AIRA AI 2026 Disaster Recovery & Parity Validator
echo ========================================================================
echo.
npx tsx scripts/validate-portable-key-recovery.ts
echo.
echo Validation process ended. Press any key to close this window.
pause >nul
