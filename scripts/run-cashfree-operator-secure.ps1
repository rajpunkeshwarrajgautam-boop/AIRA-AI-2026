#Requires -Version 5.1
<#
.SYNOPSIS
    Secure, in-memory interactive operator runner for Cashfree TEST Plan Provisioning.

.DESCRIPTION
    Safely captures Cashfree TEST Sandbox credentials via masked input (Read-Host -AsSecureString),
    validates that the App ID begins with TEST, injects credentials ephemerally into the child
    process environment, runs the read-only audit first, and automatically zeroes and removes
    all credential references from the session upon completion or error.

    Zero credentials are written to disk, echoed to the terminal, or recorded in PowerShell history.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " AIRA AI 2026 — Secure Cashfree TEST Plan Operator Provisioning Runner" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Safety Guarantees:" -ForegroundColor Yellow
Write-Host "  * Masked input (Read-Host -AsSecureString) — no terminal echoing"
Write-Host "  * Zero disk writes — credentials never saved to any file"
Write-Host "  * Zero shell history pollution"
Write-Host "  * Strict TEST sandbox fence (rejects non-TEST App IDs before network call)"
Write-Host "  * Immediate unmanaged BSTR zeroing and SecureString disposal"
Write-Host "  * Read-only audit runs first; explicit confirmation required for provisioning"
Write-Host "  * Audit fails closed on provider error, auth error, or terms mismatch (no prompt)"
Write-Host "  * Ephemeral in-memory injection — sanitized in finally block"
Write-Host "----------------------------------------------------------------------`n"

# Verify repository context and git commit
$gitToplevel = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not (Test-Path "scripts/provision-cashfree-plans.ts")) {
    Write-Error "Must be run from the root of the AIRA repository or worktree."
    return
}
$currentBranch = (& git rev-parse --abbrev-ref HEAD 2>$null)
$currentHead = (& git rev-parse HEAD 2>$null)
Write-Host "Git Context:" -ForegroundColor DarkGray
Write-Host "  Branch : $currentBranch" -ForegroundColor DarkGray
Write-Host "  Commit : $currentHead`n" -ForegroundColor DarkGray

# Check for uncommitted modifications to billing core logic
$billingDiff = (& git status --porcelain scripts/provision-cashfree-plans.ts apps/api/src/billing/cashfree-plan-provisioning-service.ts 2>$null)
if ($billingDiff) {
    Write-Warning "Uncommitted modifications detected in core billing files:`n$billingDiff"
}

# Credential variables scoped for try-finally cleanup
$AppIdSecure = $null
$SecretSecure = $null
$BstrAppId = [System.IntPtr]::Zero
$BstrSecret = [System.IntPtr]::Zero
$PlainAppId = $null
$PlainSecret = $null

try {
    # 1. Masked credential input inside try block (ensures finally executes if interrupted)
    $AppIdSecure = Read-Host -Prompt "Enter Cashfree TEST App ID (must begin with 'TEST')" -AsSecureString
    if ($null -eq $AppIdSecure -or $AppIdSecure.Length -eq 0) {
        Write-Error "Cashfree App ID cannot be empty."
        return
    }

    $SecretSecure = Read-Host -Prompt "Enter Cashfree TEST Secret Key" -AsSecureString
    if ($null -eq $SecretSecure -or $SecretSecure.Length -eq 0) {
        Write-Error "Cashfree Secret Key cannot be empty."
        return
    }

    # Convert SecureString to ephemeral in-memory strings
    $BstrAppId = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($AppIdSecure)
    $PlainAppId = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($BstrAppId)

    $BstrSecret = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecretSecure)
    $PlainSecret = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($BstrSecret)

    # Immediately zero unmanaged memory BSTR allocations
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BstrAppId)
    $BstrAppId = [System.IntPtr]::Zero
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BstrSecret)
    $BstrSecret = [System.IntPtr]::Zero

    # Dispose SecureString objects immediately to free DPAPI protected buffers
    $AppIdSecure.Dispose()
    $AppIdSecure = $null
    $SecretSecure.Dispose()
    $SecretSecure = $null

    # Validate TEST boundary
    if (-not $PlainAppId.StartsWith("TEST")) {
        Write-Error "SECURITY_VIOLATION: Cashfree App ID does not start with 'TEST'. Production credentials are strictly prohibited in this runner."
        return
    }

    if ($PlainSecret.Length -lt 10) {
        Write-Error "VALIDATION_ERROR: Cashfree Secret Key appears invalid (too short)."
        return
    }

    # Ephemeral environment injection for child node processes
    $env:CASHFREE_APP_ID = $PlainAppId
    $env:CASHFREE_SECRET_KEY = $PlainSecret
    $env:CASHFREE_ENV = "TEST"

    # Immediately clear managed string copies from local scope
    $PlainAppId = $null
    $PlainSecret = $null

    Write-Host "`n[1/3] Running Read-Only Plan Audit against Cashfree TEST Sandbox..." -ForegroundColor Cyan
    & npx tsx scripts/provision-cashfree-plans.ts --audit --env TEST
    $auditExitCode = $LASTEXITCODE

    if ($auditExitCode -eq 0) {
        Write-Host "`n[AUDIT RESULT] Both Cashfree Plus & Pro recurring plans already exist and terms match specification 100%!" -ForegroundColor Green
        Write-Host "No operator plan provisioning is required." -ForegroundColor Green
        return
    }

    if ($auditExitCode -eq 2) {
        # Audit completed successfully and determined plans are missing (zero errors or mismatches)
        Write-Host "`n[2/3] One or more plans are missing in Cashfree TEST Sandbox." -ForegroundColor Yellow
        Write-Host "Approved Plans to Provision:"
        Write-Host "  * AIRA Plus — ₹399/month (plan_cf_plus_inr_monthly)"
        Write-Host "  * AIRA Pro  — ₹999/month (plan_cf_pro_inr_monthly)"
        
        $confirm = Read-Host "`nDo you authorize operator provisioning of these TWO plans now? (type 'yes' to proceed)"
        if ($null -eq $confirm -or $confirm.Trim() -cne "yes") {
            Write-Host "Operator aborted provisioning (confirmation did not equal exact 'yes'). Zero provider mutations occurred." -ForegroundColor Yellow
            return
        }

        Write-Host "`n[3/3] Executing Operator-Authorized Plan Provisioning..." -ForegroundColor Cyan
        & npx tsx scripts/provision-cashfree-plans.ts --authorize --env TEST
        $provisionExitCode = $LASTEXITCODE

        if ($provisionExitCode -eq 0) {
            Write-Host "`n[SUCCESS] Cashfree TEST recurring plans successfully provisioned and verified!" -ForegroundColor Green
        } else {
            Write-Host "`n[FAILURE] Plan provisioning failed or returned an ambiguous response (exit code $provisionExitCode)." -ForegroundColor Red
        }
        return
    }

    # If auditExitCode is not 0 and not 2 (e.g. 1 = provider error, auth failure, network down, terms mismatch)
    Write-Host "`n[AUDIT ABORTED] Read-only audit encountered an error, terms mismatch, or authentication failure (exit code $auditExitCode)." -ForegroundColor Red
    Write-Host "Refusing to proceed to plan provisioning. Resolve the underlying audit blocker first." -ForegroundColor Red
}
finally {
    # 1. Zero out unmanaged memory BSTR allocations if still held
    if ($BstrAppId -ne [System.IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BstrAppId)
        $BstrAppId = [System.IntPtr]::Zero
    }
    if ($BstrSecret -ne [System.IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BstrSecret)
        $BstrSecret = [System.IntPtr]::Zero
    }

    # 2. Dispose SecureString instances if still active
    if ($null -ne $AppIdSecure) {
        $AppIdSecure.Dispose()
        $AppIdSecure = $null
    }
    if ($null -ne $SecretSecure) {
        $SecretSecure.Dispose()
        $SecretSecure = $null
    }

    # 3. Triple sanitization of environment variables across session and process targets
    $env:CASHFREE_APP_ID = $null
    $env:CASHFREE_SECRET_KEY = $null
    $env:CASHFREE_ENV = $null

    Remove-Item env:CASHFREE_APP_ID -ErrorAction SilentlyContinue
    Remove-Item env:CASHFREE_SECRET_KEY -ErrorAction SilentlyContinue
    Remove-Item env:CASHFREE_ENV -ErrorAction SilentlyContinue

    [System.Environment]::SetEnvironmentVariable('CASHFREE_APP_ID', $null, [System.EnvironmentVariableTarget]::Process)
    [System.Environment]::SetEnvironmentVariable('CASHFREE_SECRET_KEY', $null, [System.EnvironmentVariableTarget]::Process)
    [System.Environment]::SetEnvironmentVariable('CASHFREE_ENV', $null, [System.EnvironmentVariableTarget]::Process)

    # 4. Clear managed variables and trigger garbage collection
    $PlainAppId = $null
    $PlainSecret = $null
    [System.GC]::Collect()

    Write-Host "`n[SECURITY] Session environment variables and in-memory credential buffers have been completely sanitized." -ForegroundColor Green
}
