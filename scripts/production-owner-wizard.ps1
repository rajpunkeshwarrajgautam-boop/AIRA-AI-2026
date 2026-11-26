#Requires -Version 5.1
<#
.SYNOPSIS
    AIRA AI 2026 — Interactive Production Owner Configuration Wizard (Windows 11 PowerShell)

.DESCRIPTION
    Guided, resumable, fail-closed PowerShell wizard for completing owner-only merchant,
    GST/finance, Vercel Production, GitHub worker secret, and database backup/migration
    preparation for AIRA AI 2026 commercial billing.

    Security & Safety Guarantees:
      - Zero secrets written to disk, echoed to console, or saved in PowerShell history.
      - Uses Read-Host -AsSecureString with unmanaged BSTR zeroing in finally blocks.
      - Pipes secrets directly over stdin to `vercel env add` and `gh secret set`.
      - Persists ONLY non-secret stage completion state in %LOCALAPPDATA%\AIRA-2026\prod-wizard-state.json.
      - Keeps AIRA_COMMERCIAL_BILLING_ENABLED="false" and worker schedule disabled during prep.
      - Rejects TEST Cashfree App IDs / rzp_test_ Razorpay keys in Production stages.
      - Preserves Vercel Preview (staging) configuration untouched.
#>

[CmdletBinding()]
param(
    [switch]$ResetState,
    [int]$StartAtStage = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$TOTAL_STAGES = 15
$REPO = "rajpunkeshwarrajgautam-boop/AIRA-AI-2026"
$VERCEL_PROJECT = "aira-ai-2026"
$VERCEL_PROJECT_ID = "prj_FZLU4vBIYSsBn28AI6drkpD5WfbH"
$VERCEL_TEAM_ID = "team_0IZkX9o2Ab319UsAPW9oq1SL"
$PROD_NEON_PROJECT = "old-sky-50952395"
$STAGING_NEON_PROJECT = "mute-frost-50372225"
$PROD_URL = "https://aira-ai-2026.vercel.app"
$STATE_DIR = Join-Path $env:LOCALAPPDATA "AIRA-2026"
$STATE_FILE = Join-Path $STATE_DIR "prod-wizard-state.json"

if ($ResetState -and (Test-Path $STATE_FILE)) {
    Remove-Item -Path $STATE_FILE -Force
}

function Get-WizardState {
    if (Test-Path $STATE_FILE) {
        try {
            return (Get-Content $STATE_FILE -Raw | ConvertFrom-Json)
        } catch {
            Write-Warning "Could not parse wizard state file '$STATE_FILE'; initializing fresh state: $($_.Exception.Message)"
        }
    }
    return [PSCustomObject]@{
        completedStages = @()
        publicConfig    = [PSCustomObject]@{}
        updatedAt       = $null
    }
}

function Save-StageComplete {
    param(
        [string]$StageId,
        [hashtable]$PublicMeta = @{}
    )
    if (-not (Test-Path $STATE_DIR)) {
        New-Item -ItemType Directory -Path $STATE_DIR -Force | Out-Null
    }
    $state = Get-WizardState
    $completed = @($state.completedStages)
    if ($completed -notcontains $StageId) {
        $completed += $StageId
    }
    $metaHash = @{}
    $hasPubCfg = ($null -ne $state) -and ($state.PSObject.Properties.Match('publicConfig').Count -gt 0) -and ($null -ne $state.publicConfig)
    if ($hasPubCfg) {
        if ($state.publicConfig -is [System.Collections.IDictionary]) {
            foreach ($k in $state.publicConfig.Keys) {
                $metaHash[[string]$k] = $state.publicConfig[$k]
            }
        } else {
            $state.publicConfig.PSObject.Properties | ForEach-Object { $metaHash[$_.Name] = $_.Value }
        }
    }
    foreach ($k in $PublicMeta.Keys) {
        $metaHash[$k] = $PublicMeta[$k]
    }
    $newState = [PSCustomObject]@{
        completedStages = $completed
        publicConfig    = $metaHash
        updatedAt       = (Get-Date).ToString("o")
    }
    $json = $newState | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($STATE_FILE, $json, [System.Text.UTF8Encoding]::new($false))
}

function Test-StageDone {
    param([string]$StageId)
    $state = Get-WizardState
    return (@($state.completedStages) -contains $StageId)
}

function Show-StageHeader {
    param([int]$Num, [string]$Title, [string]$Purpose)
    Write-Host "`n======================================================================" -ForegroundColor Cyan
    Write-Host "  Stage $Num/$TOTAL_STAGES : $Title" -ForegroundColor Cyan
    Write-Host "======================================================================" -ForegroundColor Cyan
    Write-Host "  Purpose: $Purpose`n" -ForegroundColor Gray
}

function Confirm-Action {
    param([string]$Question)
    $reply = Read-Host "  ? $Question [yes/N]"
    return ($null -ne $reply -and $reply.Trim().ToLower() -eq "yes")
}

function Read-PlainSecret {
    param([string]$PromptText)
    $sec = Read-Host -Prompt "  $PromptText (hidden)" -AsSecureString
    if ($null -eq $sec -or $sec.Length -eq 0) { return $null }
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        $sec.Dispose()
    }
}

function Invoke-CliStdinSecret {
    param(
        [string]$CliName,
        [string[]]$CliArgs,
        [string]$SecretValue
    )
    $resolved = Get-Command $CliName -ErrorAction Stop
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $ext = [System.IO.Path]::GetExtension($resolved.Source).ToLowerInvariant()
    $quotedArgs = ($CliArgs | ForEach-Object {
        if ($_ -match '[\s"&|<>^]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join " "

    if ($ext -eq ".ps1") {
        $cmdSibling = [System.IO.Path]::ChangeExtension($resolved.Source, ".cmd")
        if (Test-Path $cmdSibling) {
            $psi.FileName = "cmd.exe"
            $psi.Arguments = "/d /c `"`"$cmdSibling`" $quotedArgs`""
        } else {
            $psi.FileName = "powershell.exe"
            $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$($resolved.Source)`" $quotedArgs"
        }
    } elseif ($ext -eq ".cmd" -or $ext -eq ".bat") {
        $psi.FileName = "cmd.exe"
        $psi.Arguments = "/d /c `"`"$($resolved.Source)`" $quotedArgs`""
    } else {
        $psi.FileName = $resolved.Source
        $psi.Arguments = $quotedArgs
    }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $errBuilder = New-Object System.Text.StringBuilder
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $errSub = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
        if ($null -ne $EventArgs.Data) {
            [void]$Event.MessageData.AppendLine($EventArgs.Data)
        }
    } -MessageData $errBuilder

    try {
        [void]$proc.Start()
        $proc.BeginErrorReadLine()
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($SecretValue)
        $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
        $proc.StandardInput.BaseStream.Flush()
        $proc.StandardInput.Close()
        [System.Array]::Clear($bytes, 0, $bytes.Length)
        $stdout = $proc.StandardOutput.ReadToEnd()
        $proc.WaitForExit()
        return @{
            ExitCode = $proc.ExitCode
            StdOut   = $stdout
            StdErr   = $errBuilder.ToString()
        }
    } finally {
        Unregister-Event -SourceIdentifier $errSub.Name -ErrorAction SilentlyContinue
        $errSub.Dispose()
        $proc.Dispose()
    }
}

function Set-VercelProdVar {
    param(
        [string]$Name,
        [string]$Value,
        [switch]$Sensitive
    )
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Refusing to set empty Vercel Production variable: $Name"
    }
    # Check existing production env names (never prints secret values)
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $existingList = (& vercel env ls --environment production --project $VERCEL_PROJECT --scope $VERCEL_TEAM_ID 2>&1 | Out-String)
        $lsExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevPref
    }
    if ($lsExit -ne 0) {
        throw "Failed to inspect Vercel Production environment variables: $existingList"
    }
    $exists = ($existingList -match "(?m)^\s*$([Regex]::Escape($Name))\s+")
    if ($exists) {
        if (-not (Confirm-Action "Variable '$Name' already exists in Vercel Production. Overwrite it?")) {
            Write-Host "  - Kept existing Vercel Production variable '$Name'." -ForegroundColor Yellow
            return
        }
    }
    $addArgs = @("env", "add", $Name, "--environment", "production", "--project", $VERCEL_PROJECT, "--scope", $VERCEL_TEAM_ID, "--yes")
    if ($exists) { $addArgs += "--force" }
    if ($Sensitive) { $addArgs += "--sensitive" } else { $addArgs += "--no-sensitive" }

    $res = Invoke-CliStdinSecret -CliName "vercel" -CliArgs $addArgs -SecretValue $Value
    if ($res.ExitCode -ne 0) {
        throw "Failed to set Vercel Production variable '$Name' (exit $($res.ExitCode))."
    }
    Write-Host "  [OK] Configured Vercel Production variable: $Name" -ForegroundColor Green
}

function Set-GitHubSecretSafe {
    param([string]$Name, [string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Refusing to set empty GitHub secret: $Name"
    }
    $res = Invoke-CliStdinSecret -CliName "gh" -CliArgs @("secret", "set", $Name, "--repo", $REPO) -SecretValue $Value
    if ($res.ExitCode -ne 0) {
        throw "Failed to set GitHub secret '$Name' (exit $($res.ExitCode))."
    }
    Write-Host "  [OK] Configured GitHub secret: $Name" -ForegroundColor Green
}

function Should-RunStage {
    param([int]$Num, [string]$StageId)
    if ($Num -lt $StartAtStage) { return $false }
    if (Test-StageDone $StageId) {
        $redo = Read-Host "  [DONE] Stage $Num ($StageId) already completed. Re-run? [y/N]"
        return ($redo -match "^[Yy]")
    }
    return $true
}

Write-Host "`n======================================================================" -ForegroundColor Cyan
Write-Host "  AIRA AI 2026 — Production Billing Owner Configuration Wizard" -ForegroundColor Cyan
Write-Host "  Repo: $REPO | Prod DB: $PROD_NEON_PROJECT | Staging Preserved" -ForegroundColor DarkGray
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  State file (non-secret only): $STATE_FILE" -ForegroundColor DarkGray
Write-Host "  Note: Stop anytime with Ctrl+C and re-run to resume completed stages.`n" -ForegroundColor DarkGray

# ----------------------------------------------------------------------------
# Stage 1: Project, Auth & Environment Identity Preflight
# ----------------------------------------------------------------------------
if (Should-RunStage 1 "S01_IDENTITY_PREFLIGHT") {
    Show-StageHeader 1 "Verify CLI Auth, Production Target & Kill-Switch Posture" "Confirm Vercel/GitHub/Neon identity and ensure commercial billing stays disabled during setup."
    Write-Host "  1. Checking GitHub, Vercel, and Neon authentication..."
    & gh auth status
    if ($LASTEXITCODE -ne 0) { throw "GitHub CLI (gh) is not authenticated. Run 'gh auth login'." }
    & vercel whoami
    if ($LASTEXITCODE -ne 0) { throw "Vercel CLI is not authenticated. Run 'vercel login'." }
    & neon projects list
    if ($LASTEXITCODE -ne 0) { throw "Neon CLI is not authenticated. Run 'neon auth'." }

    Write-Host "`n  2. Inspecting existing Vercel Production variables (names only):" -ForegroundColor Yellow
    & vercel env ls --environment production --project $VERCEL_PROJECT --scope $VERCEL_TEAM_ID
    if ($LASTEXITCODE -ne 0) { throw "Failed to list Vercel Production variables." }

    Write-Host "`n  3. Inspecting existing GitHub Actions secrets & vars:" -ForegroundColor Yellow
    & gh secret list --repo $REPO
    & gh variable list --repo $REPO

    if (Confirm-Action "Confirm you are ready to configure Production project '$VERCEL_PROJECT' while leaving Staging ('$STAGING_NEON_PROJECT') untouched?") {
        Save-StageComplete "S01_IDENTITY_PREFLIGHT"
    } else { return }
}

# ----------------------------------------------------------------------------
# Stage 2: Razorpay LIVE Merchant Activation & KYC
# ----------------------------------------------------------------------------
if (Should-RunStage 2 "S02_RAZORPAY_KYC") {
    Show-StageHeader 2 "Razorpay LIVE Merchant Activation & KYC" "Verify Razorpay business KYC is approved for Virexa AI Ventures Private Limited."
    Write-Host "  • Open Razorpay Dashboard: https://dashboard.razorpay.com/app/settings"
    Start-Process "https://dashboard.razorpay.com/app/settings"
    Write-Host "  • Confirm LIVE mode toggle is available (Account Status: Activated)."
    if (Confirm-Action "Have you verified in the Razorpay Dashboard that LIVE mode and KYC are approved?") {
        Save-StageComplete "S02_RAZORPAY_KYC"
    } else { Write-Host "  Paused: complete Razorpay KYC first." -ForegroundColor Yellow; return }
}

# ----------------------------------------------------------------------------
# Stage 3: Razorpay Recurring Subscription Approval & INR Plans
# ----------------------------------------------------------------------------
if (Should-RunStage 3 "S03_RAZORPAY_PLANS") {
    Show-StageHeader 3 "Razorpay LIVE Recurring Approval & ₹399 / ₹999 Plans" "Verify recurring Subscriptions / e-mandates are enabled and collect LIVE plan IDs."
    Start-Process "https://dashboard.razorpay.com/app/subscriptions/plans"
    Write-Host "  • Ensure Subscriptions (UPI AutoPay + Cards e-mandate) is active in LIVE mode."
    Write-Host "  • Locate or create exact INR monthly plans (avoid duplicates if already created):"
    Write-Host "    - AIRA Plus Monthly: ₹399.00 INR (39900 paise), interval=1 month"
    Write-Host "    - AIRA Pro Monthly : ₹999.00 INR (99900 paise), interval=1 month"
    $rzpPlusRaw = Read-Host "  Paste LIVE RAZORPAY_PLAN_ID_PLUS_INR (starts 'plan_')"
    $rzpProRaw  = Read-Host "  Paste LIVE RAZORPAY_PLAN_ID_PRO_INR  (starts 'plan_')"
    $rzpPlus = if ($null -ne $rzpPlusRaw) { $rzpPlusRaw.Trim() } else { "" }
    $rzpPro  = if ($null -ne $rzpProRaw) { $rzpProRaw.Trim() } else { "" }
    if (-not $rzpPlus.StartsWith("plan_") -or -not $rzpPro.StartsWith("plan_")) {
        throw "Invalid Razorpay plan ID format (expected 'plan_*')."
    }
    if (Confirm-Action "Save RAZORPAY_PLAN_ID_PLUS_INR and RAZORPAY_PLAN_ID_PRO_INR to Vercel Production?") {
        Set-VercelProdVar -Name "RAZORPAY_PLAN_ID_PLUS_INR" -Value $rzpPlus
        Set-VercelProdVar -Name "RAZORPAY_PLAN_ID_PRO_INR"  -Value $rzpPro
        Save-StageComplete "S03_RAZORPAY_PLANS" @{ rzpPlusPlan = $rzpPlus; rzpProPlan = $rzpPro }
    } else { return }
}

# ----------------------------------------------------------------------------
# Stage 4: Razorpay LIVE Credentials & Webhook Configuration
# ----------------------------------------------------------------------------
if (Should-RunStage 4 "S04_RAZORPAY_CREDS_WEBHOOK") {
    Show-StageHeader 4 "Razorpay LIVE Credentials & Webhook Configuration" "Set rzp_live_* keys and configure the production Razorpay webhook secret."
    Start-Process "https://dashboard.razorpay.com/app/website-app-settings/api-keys"
    Start-Process "https://dashboard.razorpay.com/app/website-app-settings/webhooks"
    Write-Host "  • Webhook URL: $PROD_URL/api/billing/webhook/razorpay"
    Write-Host "  • Required Events: subscription.authenticated, subscription.activated, subscription.charged, subscription.pending, subscription.halted, subscription.cancelled, refund.processed"
    $rzpKeyId = $null; $rzpSecret = $null; $rzpWhSec = $null
    try {
        $rzpKeyId = Read-PlainSecret "Paste LIVE RAZORPAY_KEY_ID (must start with 'rzp_live_')"
        if (-not $rzpKeyId -or -not $rzpKeyId.StartsWith("rzp_live_")) {
            throw "SECURITY_VIOLATION: Production requires 'rzp_live_*'. Refusing test/invalid key."
        }
        $rzpSecret = Read-PlainSecret "Paste LIVE RAZORPAY_KEY_SECRET"
        $rzpWhSec  = Read-PlainSecret "Paste LIVE RAZORPAY_WEBHOOK_SECRET"
        if (Confirm-Action "Upload Razorpay LIVE credentials and webhook secret to Vercel Production?") {
            Set-VercelProdVar -Name "RAZORPAY_KEY_ID"         -Value $rzpKeyId  -Sensitive
            Set-VercelProdVar -Name "RAZORPAY_KEY_SECRET"     -Value $rzpSecret -Sensitive
            Set-VercelProdVar -Name "RAZORPAY_WEBHOOK_SECRET" -Value $rzpWhSec  -Sensitive
            Save-StageComplete "S04_RAZORPAY_CREDS_WEBHOOK"
        } else { return }
    } finally {
        $rzpKeyId = $null; $rzpSecret = $null; $rzpWhSec = $null
    }
}

# ----------------------------------------------------------------------------
# Stage 5: Cashfree Production Merchant Activation & KYC
# ----------------------------------------------------------------------------
if (Should-RunStage 5 "S05_CASHFREE_KYC") {
    Show-StageHeader 5 "Cashfree Production Merchant Activation & KYC" "Confirm Cashfree Production dashboard KYC and Subscriptions product enablement."
    Start-Process "https://merchant.cashfree.com/merchants/pg/subscriptions"
    Write-Host "  • Confirm Production account is active (NOT Sandbox/TEST mode) and Subscriptions v2025-01-01 is enabled."
    if (Confirm-Action "Have you verified Cashfree Production KYC and Subscriptions product activation?") {
        Save-StageComplete "S05_CASHFREE_KYC"
    } else { Write-Host "  Paused: complete Cashfree Production KYC first." -ForegroundColor Yellow; return }
}

# ----------------------------------------------------------------------------
# Stage 6: Cashfree Production Recurring Approval & ₹399 / ₹999 Plans
# ----------------------------------------------------------------------------
if (Should-RunStage 6 "S06_CASHFREE_PLANS") {
    Show-StageHeader 6 "Cashfree Production Recurring Plans (₹399 & ₹999)" "Audit existing Cashfree PROD plans via scripts/provision-cashfree-plans.ts to prevent duplicates."
    Write-Host "  • Authoritative plan IDs: plan_cf_plus_inr_monthly (₹399/mo), plan_cf_pro_inr_monthly (₹999/mo)."
    $cfAppId = $null; $cfSecret = $null
    try {
        $cfAppId  = Read-PlainSecret "Paste Cashfree PROD App ID (must NOT start with 'TEST')"
        if (-not $cfAppId -or $cfAppId.StartsWith("TEST")) {
            throw "SECURITY_VIOLATION: Refusing Cashfree TEST App ID in Production stage."
        }
        $cfSecret = Read-PlainSecret "Paste Cashfree PROD Secret Key"
        $env:CASHFREE_APP_ID     = $cfAppId
        $env:CASHFREE_SECRET_KEY = $cfSecret
        $env:CASHFREE_ENV        = "PROD"
        $env:AIRA_ENVIRONMENT    = "production"

        Write-Host "`n  Running read-only Cashfree PROD plan audit..." -ForegroundColor Cyan
        & npx tsx scripts/provision-cashfree-plans.ts --audit --env PROD
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "One or more PROD plans are missing or mismatched."
            if (Confirm-Action "Authorize provisioning missing Cashfree PROD plans now?") {
                & npx tsx scripts/provision-cashfree-plans.ts --authorize --env PROD
                if ($LASTEXITCODE -ne 0) { throw "Cashfree PROD plan provisioning failed." }
            } else { return }
        }
        if (Confirm-Action "Save Cashfree PROD plan IDs & credentials in Vercel Production (Stage 6 & 7 combined)?") {
            Set-VercelProdVar -Name "CASHFREE_ENV"               -Value "PROD"
            Set-VercelProdVar -Name "CASHFREE_APP_ID"            -Value $cfAppId  -Sensitive
            Set-VercelProdVar -Name "CASHFREE_SECRET_KEY"        -Value $cfSecret -Sensitive
            Set-VercelProdVar -Name "CASHFREE_PLAN_ID_PLUS_INR"  -Value "plan_cf_plus_inr_monthly"
            Set-VercelProdVar -Name "CASHFREE_PLAN_ID_PRO_INR"   -Value "plan_cf_pro_inr_monthly"
            Save-StageComplete "S06_CASHFREE_PLANS"
        } else { return }
    } finally {
        $cfAppId = $null; $cfSecret = $null
        Remove-Item Env:\CASHFREE_APP_ID -ErrorAction SilentlyContinue
        Remove-Item Env:\CASHFREE_SECRET_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:\CASHFREE_ENV -ErrorAction SilentlyContinue
        Remove-Item Env:\AIRA_ENVIRONMENT -ErrorAction SilentlyContinue
    }
}

# ----------------------------------------------------------------------------
# Stage 7: Cashfree Production Webhook Configuration
# ----------------------------------------------------------------------------
if (Should-RunStage 7 "S07_CASHFREE_WEBHOOK") {
    Show-StageHeader 7 "Cashfree Production Webhook Configuration" "Register production webhook endpoint and store CASHFREE_WEBHOOK_SECRET."
    Start-Process "https://merchant.cashfree.com/merchants/pg/developers/webhooks"
    Write-Host "  • Webhook URL: $PROD_URL/api/billing/webhook/cashfree"
    Write-Host "  • API Version: 2025-01-01"
    Write-Host "  • Events: SUBSCRIPTION_PAYMENT_SUCCESS, SUBSCRIPTION_PAYMENT_FAILED, SUBSCRIPTION_STATUS_CHANGED, SUBSCRIPTION_AUTH_STATUS, REFUND_STATUS"
    $cfWhSec = $null
    try {
        $cfWhSec = Read-PlainSecret "Paste Cashfree PROD Webhook Secret (or press Enter if using CASHFREE_SECRET_KEY)"
        if ($cfWhSec) {
            Set-VercelProdVar -Name "CASHFREE_WEBHOOK_SECRET" -Value $cfWhSec -Sensitive
        }
        Save-StageComplete "S07_CASHFREE_WEBHOOK"
    } finally { $cfWhSec = $null }
}

# ----------------------------------------------------------------------------
# Stage 8: Registered Supplier Identity, GSTIN & State Verification
# ----------------------------------------------------------------------------
if (Should-RunStage 8 "S08_SUPPLIER_GSTIN") {
    Show-StageHeader 8 "Supplier Identity, GSTIN & Supplier State Verification" "Configure verified Virexa AI Ventures Private Limited GST details (SAC 998431)."
    Write-Host "  • Expected Supplier Legal Name: Virexa AI Ventures Private Limited"
    $gstin = (Read-Host "  Enter verified 15-character Supplier GSTIN").Trim().ToUpper()
    if ($gstin -notmatch "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$") {
        throw "Invalid 15-character Indian GSTIN format."
    }
    $stateCode = $gstin.Substring(0, 2)
    Write-Host "  • Derived State Code: $stateCode (override if supplier state differs)"
    $supplierState = (Read-Host "  Enter AIRA_SUPPLIER_STATE [$stateCode]").Trim()
    if (-not $supplierState) { $supplierState = $stateCode }
    if (Confirm-Action "Confirm GST registration certificate has been verified offline before marking AIRA_SUPPLIER_GSTIN_VERIFIED=true?") {
        Set-VercelProdVar -Name "AIRA_SUPPLIER_NAME"           -Value "Virexa AI Ventures Private Limited"
        Set-VercelProdVar -Name "AIRA_SUPPLIER_GSTIN"          -Value $gstin
        Set-VercelProdVar -Name "AIRA_SUPPLIER_STATE"          -Value $supplierState
        Set-VercelProdVar -Name "AIRA_SUPPLIER_GSTIN_VERIFIED" -Value "true"
        Save-StageComplete "S08_SUPPLIER_GSTIN" @{ supplierState = $supplierState }
    } else { return }
}

# ----------------------------------------------------------------------------
# Stage 9: Finance & Tax Sign-Off Approval
# ----------------------------------------------------------------------------
if (Should-RunStage 9 "S09_FINANCE_TAX_SIGNOFF") {
    Show-StageHeader 9 "Applicable Tax & Finance Sign-Off" "Confirm formal Finance sign-off for SAC 998431 (18% GST) and INR-only launch posture."
    Write-Host "  • Pricing: Plus ₹399 (₹338.14 base + ₹60.86 GST), Pro ₹999 (₹846.61 base + ₹152.39 GST)."
    Write-Host "  • Scope  : INR-only launch (AIRA_INTERNATIONAL_USD_BILLING_ENABLED=false)."
    if (Confirm-Action "Has Finance/Tax owner formally signed off on GST compliance and sequential invoicing?") {
        Set-VercelProdVar -Name "AIRA_FINANCE_TAX_SIGNOFF"               -Value "true"
        Set-VercelProdVar -Name "AIRA_INTERNATIONAL_USD_BILLING_ENABLED" -Value "false"
        Save-StageComplete "S09_FINANCE_TAX_SIGNOFF"
    } else { return }
}

# ----------------------------------------------------------------------------
# Stage 10: Vercel Production Safety & Kill-Switch Posture
# ----------------------------------------------------------------------------
if (Should-RunStage 10 "S10_VERCEL_PROD_SAFETY") {
    Show-StageHeader 10 "Vercel Production Kill-Switch & Domain Isolation" "Keep commercial billing DISABLED during deployment prep."
    Set-VercelProdVar -Name "AIRA_COMMERCIAL_BILLING_ENABLED"            -Value "false"
    Set-VercelProdVar -Name "AIRA_ENABLE_PRODUCTION_FINANCIAL_WORKER"    -Value "false"
    Set-VercelProdVar -Name "AIRA_ALLOWED_PAYMENT_GATEWAYS"              -Value "razorpay,cashfree"
    Set-VercelProdVar -Name "AIRA_PAYMENT_GATEWAY_DEFAULT"               -Value "cashfree"
    Set-VercelProdVar -Name "AIRA_CANONICAL_DOMAIN"                      -Value "aira-ai-2026.vercel.app"
    Save-StageComplete "S10_VERCEL_PROD_SAFETY"
}

# ----------------------------------------------------------------------------
# Stage 11: Secure Financial Worker Secret Configuration
# ----------------------------------------------------------------------------
if (Should-RunStage 11 "S11_WORKER_SECRETS") {
    Show-StageHeader 11 "Financial Worker Authentication Secret" "Generate or supply high-entropy worker key for /api/billing/worker/process-outbox."
    $gen = Confirm-Action "Generate a fresh 32-byte cryptographic worker key automatically?"
    $wkrKey = $null
    try {
        if ($gen) {
            $bytes = New-Object byte[] 32
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try {
                $rng.GetBytes($bytes)
            } finally {
                $rng.Dispose()
            }
            $hex = (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
            [System.Array]::Clear($bytes, 0, $bytes.Length)
            $wkrKey = "wkr_" + $hex
        } else {
            $wkrKey = Read-PlainSecret "Paste worker secret key (>=32 chars)"
            if ([string]::IsNullOrWhiteSpace($wkrKey) -or $wkrKey.Trim().Length -lt 32) {
                throw "VALIDATION_ERROR: Worker key must be at least 32 characters."
            }
        }
        Set-VercelProdVar   -Name "AIRA_INTERNAL_WORKER_KEY"               -Value $wkrKey -Sensitive
        Set-GitHubSecretSafe -Name "AIRA_PRODUCTION_INTERNAL_WORKER_KEY"   -Value $wkrKey
        Save-StageComplete "S11_WORKER_SECRETS"
    } finally { $wkrKey = $null }
}

# ----------------------------------------------------------------------------
# Stage 12: GitHub Production Worker Scheduling Guard
# ----------------------------------------------------------------------------
if (Should-RunStage 12 "S12_GITHUB_WORKER_SCHEDULE") {
    Show-StageHeader 12 "GitHub Production Worker Scheduling Guard" "Ensure scheduler stays DISABLED until migrations + deploy are complete."
    & gh variable set AIRA_PRODUCTION_WORKER_SCHEDULE_ENABLED --body "false" --repo $REPO
    if ($LASTEXITCODE -ne 0) { throw "Failed to set GitHub variable AIRA_PRODUCTION_WORKER_SCHEDULE_ENABLED." }
    Write-Host "  [OK] Confirmed AIRA_PRODUCTION_WORKER_SCHEDULE_ENABLED=false during prep." -ForegroundColor Green
    Write-Host "  • Note: During activation Step 7, enable via:" -ForegroundColor DarkGray
    Write-Host "    gh variable set AIRA_PRODUCTION_WORKER_SCHEDULE_ENABLED --body true --repo $REPO" -ForegroundColor DarkGray
    Save-StageComplete "S12_GITHUB_WORKER_SCHEDULE"
}

# ----------------------------------------------------------------------------
# Stage 13: Production Database Backup & Migration 033-035 Authorization Check
# ----------------------------------------------------------------------------
if (Should-RunStage 13 "S13_PROD_BACKUP_MIGRATION_PREP") {
    Show-StageHeader 13 "Production Neon Checkpoint & Migration 033-035 Preparation" "Verify current Neon production branches without modifying production data."
    & neon branches list --project-id $PROD_NEON_PROJECT
    if ($LASTEXITCODE -ne 0) { throw "Failed to inspect Neon production branches for project '$PROD_NEON_PROJECT'." }
    Write-Host "  • Pending migrations: 033_billing_invoice_sequences, 034_unique_active_subscription_per_customer, 035_subscription_cancellation_and_invoice_outbox"
    Write-Host "  • DO NOT run migrations until explicit GO LIVE authorization is given."
    if (Confirm-Action "Confirm you have verified Neon project '$PROD_NEON_PROJECT' access and recovery checkpoint procedure?") {
        Save-StageComplete "S13_PROD_BACKUP_MIGRATION_PREP"
    } else { return }
}

# ----------------------------------------------------------------------------
# Stage 14: Production Readiness Verification (Read-Only)
# ----------------------------------------------------------------------------
if (Should-RunStage 14 "S14_READINESS_VERIFY") {
    Show-StageHeader 14 "Verify Vercel Production Env & GitHub State" "Confirm all required variables exist in Vercel Production (values remain hidden)."
    & vercel env ls --environment production --project $VERCEL_PROJECT --scope $VERCEL_TEAM_ID
    if ($LASTEXITCODE -ne 0) { throw "Failed to verify Vercel Production variables." }
    & gh secret list --repo $REPO
    if ($LASTEXITCODE -ne 0) { throw "Failed to list GitHub secrets." }
    & gh variable list --repo $REPO
    if ($LASTEXITCODE -ne 0) { throw "Failed to list GitHub variables." }
    Save-StageComplete "S14_READINESS_VERIFY"
}

# ----------------------------------------------------------------------------
# Stage 15: Final GO LIVE Gate (Strict Hold Reminder)
# ----------------------------------------------------------------------------
if (Should-RunStage 15 "S15_GO_LIVE_HOLD") {
    Show-StageHeader 15 "Final GO LIVE Authorization Gate" "Preparation complete. Production remains on STRICT HOLD."
    Write-Host "  Next Authorized GO LIVE Execution Order:" -ForegroundColor Yellow
    Write-Host "    1. Create Neon recovery checkpoint on $PROD_NEON_PROJECT."
    Write-Host "    2. Apply migrations 033-035 and run npm run db:verify:deploy."
    Write-Host "    3. Merge certified PR #215 after explicit GO LIVE approval."
    Write-Host "    4. Verify initial deploy health with billing disabled."
    Write-Host "    5. Enable AIRA_ENABLE_PRODUCTION_FINANCIAL_WORKER=true & GitHub worker schedule."
    Write-Host "    6. Enable AIRA_COMMERCIAL_BILLING_ENABLED=true and run controlled INR smoke test."
    Save-StageComplete "S15_GO_LIVE_HOLD"
}

Write-Host "`n======================================================================" -ForegroundColor Green
Write-Host "  Wizard run complete. Zero secrets stored on disk." -ForegroundColor Green
Write-Host "======================================================================`n" -ForegroundColor Green
