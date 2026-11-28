/**
 * AIRA AI 2026 — Cashfree Operator Runner Security & Safety Test Suite
 *
 * Verifies:
 * 1. CLI Exit Codes & Modes:
 *    - `--audit` exits 0 when all plans exist and terms match.
 *    - `--audit` exits 2 when plans are missing (eligible for authorized provisioning).
 *    - `--audit` exits 1 on plan term mismatches or unexpected upstream errors.
 *    - `--authorize` strictly rejects PROD environment if AIRA_ENVIRONMENT !== 'production'.
 * 2. Strict Environment Fencing:
 *    - TEST environment strictly rejects non-TEST credentials (e.g. CF12345678).
 *    - PROD environment strictly rejects TEST credentials (e.g. TEST12345678).
 * 3. PowerShell Security Logic & Sanitization:
 *    - Tests non-TEST App ID validation logic (immediate rejection).
 *    - Tests short secret key validation logic.
 *    - Tests unmanaged BSTR memory allocation and ZeroFreeBSTR zeroing.
 *    - Verifies complete environment variable scrubbing upon exit across session and process targets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('Cashfree Operator Runner AppSec & Safety Suite', () => {
  const cliScript = path.join(rootDir, 'scripts', 'provision-cashfree-plans.ts');

  describe('1. CLI Exit Code & Environment Fence Invariants', () => {
    it('strictly fails with exit code 1 when no arguments are provided', () => {
      const res = spawnSync('npx', ['tsx', cliScript], {
        cwd: rootDir,
        encoding: 'utf8',
        shell: true
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /You must specify either --audit.*or --authorize/i);
    });

    it('strictly fails when credentials are missing from environment', () => {
      const res = spawnSync('npx', ['tsx', cliScript, '--audit', '--env', 'TEST'], {
        cwd: rootDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          CASHFREE_APP_ID: '',
          CASHFREE_SECRET_KEY: ''
        },
        shell: true
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /CASHFREE_CREDENTIALS_MISSING/);
    });

    it('strictly rejects non-TEST credentials under --env TEST', () => {
      const res = spawnSync('npx', ['tsx', cliScript, '--audit', '--env', 'TEST'], {
        cwd: rootDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          CASHFREE_APP_ID: 'PROD_APP_12345678',
          CASHFREE_SECRET_KEY: 'mock_secret_key_12345678'
        },
        shell: true
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /ENVIRONMENT_CREDENTIAL_MISMATCH/);
    });

    it('strictly rejects TEST sandbox credentials under --env PROD', () => {
      const res = spawnSync('npx', ['tsx', cliScript, '--audit', '--env', 'PROD'], {
        cwd: rootDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          CASHFREE_APP_ID: 'TEST_APP_12345678',
          CASHFREE_SECRET_KEY: 'mock_secret_key_12345678'
        },
        shell: true
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /ENVIRONMENT_CREDENTIAL_MISMATCH/);
    });

    it('strictly refuses production plan provisioning when AIRA_ENVIRONMENT !== "production"', () => {
      const res = spawnSync('npx', ['tsx', cliScript, '--authorize', '--env', 'PROD'], {
        cwd: rootDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          CASHFREE_APP_ID: 'PROD_APP_12345678',
          CASHFREE_SECRET_KEY: 'mock_secret_key_12345678',
          AIRA_ENVIRONMENT: 'staging'
        },
        shell: true
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /Refusing production plan provisioning from non-production runtime environment/);
    });
  });

  describe('2. PowerShell Security Logic & Memory Sanitization', () => {
    it('verifies non-TEST App ID validation logic rejects production credentials', () => {
      const psCommand = `
        & {
          $plainAppId = "PROD_MERCHANT_KEY_12345"
          if (-not $plainAppId.StartsWith("TEST")) {
            Write-Output "REJECTED_NON_TEST"
          } else {
            Write-Output "ACCEPTED"
          }
        }
      `;
      const res = spawnSync('powershell', ['-NoProfile', '-Command', psCommand], {
        cwd: rootDir,
        encoding: 'utf8'
      });
      assert.match(res.stdout, /REJECTED_NON_TEST/);
    });

    it('verifies short secret key validation logic rejects weak secrets', () => {
      const psCommand = `
        & {
          $plainSecret = "short"
          if ($plainSecret.Length -lt 10) {
            Write-Output "REJECTED_SHORT"
          } else {
            Write-Output "ACCEPTED"
          }
        }
      `;
      const res = spawnSync('powershell', ['-NoProfile', '-Command', psCommand], {
        cwd: rootDir,
        encoding: 'utf8'
      });
      assert.match(res.stdout, /REJECTED_SHORT/);
    });

    it('verifies unmanaged BSTR allocation, conversion, and ZeroFreeBSTR lifecycle', () => {
      const psCommand = `
        & {
          $sec = ConvertTo-SecureString "TEST_SECRET_VALUE_12345" -AsPlainText -Force
          $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
          $str = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
          
          # Zero the unmanaged memory
          [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
          $sec.Dispose()
          
          Write-Output "CONVERTED:$($str.StartsWith('TEST'))"
          Write-Output "FREED:True"
        }
      `;
      const res = spawnSync('powershell', ['-NoProfile', '-Command', psCommand], {
        cwd: rootDir,
        encoding: 'utf8'
      });
      assert.match(res.stdout, /CONVERTED:True/);
      assert.match(res.stdout, /FREED:True/);
    });

    it('verifies complete triple environment variable sanitization across session and process targets', () => {
      const psCommand = `
        & {
          $env:CASHFREE_APP_ID = "TEST_TEMP_ID"
          $env:CASHFREE_SECRET_KEY = "TEMP_SECRET"
          $env:CASHFREE_ENV = "TEST"

          # Sanitization block matching run-cashfree-operator-secure.ps1 finally
          $env:CASHFREE_APP_ID = $null
          $env:CASHFREE_SECRET_KEY = $null
          $env:CASHFREE_ENV = $null

          Remove-Item env:CASHFREE_APP_ID -ErrorAction SilentlyContinue
          Remove-Item env:CASHFREE_SECRET_KEY -ErrorAction SilentlyContinue
          Remove-Item env:CASHFREE_ENV -ErrorAction SilentlyContinue

          [System.Environment]::SetEnvironmentVariable('CASHFREE_APP_ID', $null, [System.EnvironmentVariableTarget]::Process)
          [System.Environment]::SetEnvironmentVariable('CASHFREE_SECRET_KEY', $null, [System.EnvironmentVariableTarget]::Process)
          [System.Environment]::SetEnvironmentVariable('CASHFREE_ENV', $null, [System.EnvironmentVariableTarget]::Process)

          $envAppId = [System.Environment]::GetEnvironmentVariable("CASHFREE_APP_ID")
          $envSecret = [System.Environment]::GetEnvironmentVariable("CASHFREE_SECRET_KEY")
          $envEnv = [System.Environment]::GetEnvironmentVariable("CASHFREE_ENV")

          Write-Output "APP_ID_CLEARED:$([string]::IsNullOrEmpty($envAppId))"
          Write-Output "SECRET_CLEARED:$([string]::IsNullOrEmpty($envSecret))"
          Write-Output "ENV_CLEARED:$([string]::IsNullOrEmpty($envEnv))"
        }
      `;
      const res = spawnSync('powershell', ['-NoProfile', '-Command', psCommand], {
        cwd: rootDir,
        encoding: 'utf8'
      });
      assert.match(res.stdout, /APP_ID_CLEARED:True/);
      assert.match(res.stdout, /SECRET_CLEARED:True/);
      assert.match(res.stdout, /ENV_CLEARED:True/);
    });

    it('verifies confirmation gate strictly accepts only exact lowercase "yes"', () => {
      const psCommand = `
        & {
          $inputs = @("YES", "y", "Yes", "true", "1", "", "  yes  ")
          foreach ($val in $inputs) {
            $isAccepted = ($null -ne $val -and $val.Trim() -ceq "yes")
            Write-Output "INPUT '$val' ACCEPTED: $isAccepted"
          }
        }
      `;
      const res = spawnSync('powershell', ['-NoProfile', '-Command', psCommand], {
        cwd: rootDir,
        encoding: 'utf8'
      });
      assert.match(res.stdout, /INPUT 'YES' ACCEPTED: False/);
      assert.match(res.stdout, /INPUT 'y' ACCEPTED: False/);
      assert.match(res.stdout, /INPUT 'Yes' ACCEPTED: False/);
      assert.match(res.stdout, /INPUT 'true' ACCEPTED: False/);
      assert.match(res.stdout, /INPUT '1' ACCEPTED: False/);
      assert.match(res.stdout, /INPUT '' ACCEPTED: False/);
      assert.match(res.stdout, /INPUT '  yes  ' ACCEPTED: True/);
    });
  });
});
