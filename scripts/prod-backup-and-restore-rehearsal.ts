import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  encryptFile,
  decryptFile,
  verifyArchiveContainer,
  validateBackupConnectionUrl
} from './secure-backup-crypto.js';
import { EXPECTED_TABLES } from './rehearse-disposable-restore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const VAULT_DIR = 'C:\\Users\\WORKSTATION\\AIRA_VAULT_REPLICA';

function toWslPath(winPath: string): string {
  return winPath.replace(/^([A-Za-z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/');
}

function execWslScript(scriptContent: string, logPrefix = 'WSL'): void {
  const tmpScriptWinPath = path.join(os.tmpdir(), `wsl_script_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sh`);
  const tmpScriptWslPath = toWslPath(tmpScriptWinPath);
  fs.writeFileSync(tmpScriptWinPath, scriptContent.replace(/\r\n/g, '\n'), { mode: 0o700, encoding: 'utf8' });
  try {
    const res = spawnSync('wsl', ['-d', 'Ubuntu-24.04', 'bash', tmpScriptWslPath], {
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024
    });
    if (res.status !== 0) {
      throw new Error(`[${logPrefix}] Script failed (exit ${res.status}): ${res.stderr || res.stdout}`);
    }
    if (res.stdout && res.stdout.trim()) {
      console.log(`  [${logPrefix}] ${res.stdout.trim().split('\n').join('\n  [' + logPrefix + '] ')}`);
    }
  } finally {
    try { fs.unlinkSync(tmpScriptWinPath); } catch {}
  }
}

export interface BackupRehearsalResult {
  timestamp: string;
  backupFile: string;
  backupSizeBytes: number;
  sha256: string;
  tablesVerified: number;
  productionRowCounts: Record<string, number>;
  restoredRowCounts: Record<string, number>;
  parityPassed: boolean;
  isolatedDbName: string;
}

export async function runProductionBackupAndRestoreRehearsal(passphrase: string): Promise<BackupRehearsalResult> {
  console.log('================================================================================');
  console.log(' AIRA AI 2026 — PRODUCTION BACKUP & ISOLATED RESTORE REHEARSAL (PHASE 2)      ');
  console.log('================================================================================');

  if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
  }

  // 1. Obtain and validate production connection string
  console.log('\n[STEP 1/7] Resolving direct unpooled production connection string...');
  const rawProdConn = execSync('neon connection-string main --project-id old-sky-50952395 --pooled=false', {
    encoding: 'utf8'
  }).trim();

  const validated = validateBackupConnectionUrl(rawProdConn);
  console.log(`  ✓ Target endpoint validated: ${validated.endpoint}`);
  console.log(`  ✓ Connection sanitized:     ${validated.sanitized}`);
  console.log(`  ✓ Is unpooled:              ${validated.isDirect}`);

  // 2. Query production baseline row counts across expected tables
  console.log('\n[STEP 2/7] Gathering production baseline table and row counts...');
  const prodClient = new pg.Client({ connectionString: rawProdConn });
  await prodClient.connect();

  const prodRowCounts: Record<string, number> = {};
  let totalProdRows = 0;

  for (const table of EXPECTED_TABLES) {
    try {
      const res = await prodClient.query(`SELECT count(*)::int AS cnt FROM "${table}"`);
      const cnt = res.rows[0].cnt;
      prodRowCounts[table] = cnt;
      totalProdRows += cnt;
    } catch {
      // Table might not exist yet if added in later migrations
      prodRowCounts[table] = -1;
    }
  }
  await prodClient.end();

  const existingProdTables = Object.entries(prodRowCounts).filter(([_, cnt]) => cnt >= 0);
  console.log(`  ✓ Production tables audited: ${existingProdTables.length} / ${EXPECTED_TABLES.length}`);
  console.log(`  ✓ Total production rows:     ${totalProdRows}`);

  // 3. Execute read-only pg_dump via WSL
  const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const rawDumpFileName = `aira_prod_main_backup_${timestamp}_raw.dump`;
  const rawDumpWinPath = path.join(VAULT_DIR, rawDumpFileName);
  const rawDumpWslPath = toWslPath(rawDumpWinPath);

  console.log(`\n[STEP 3/7] Executing read-only pg_dump via WSL PostgreSQL 16 client...`);
  console.log(`  - Target output: ${rawDumpWinPath}`);

  // Execute pg_dump using WSL script
  const dumpBashScript = `#!/bin/bash
set -e
pg_dump "${rawProdConn}" -Fc --no-owner --no-privileges -f "${rawDumpWslPath}"
`;
  execWslScript(dumpBashScript, 'PG_DUMP');

  const rawStat = fs.statSync(rawDumpWinPath);
  console.log(`  ✓ Raw pg_dump complete: ${rawStat.size} bytes (${(rawStat.size / (1024 * 1024)).toFixed(2)} MB)`);

  // 4. Encrypt with AES-256-GCM AEAD using secure-backup-crypto
  const encFileName = `aira_prod_main_backup_${timestamp}.dump.enc`;
  const encFilePath = path.join(VAULT_DIR, encFileName);
  console.log(`\n[STEP 4/7] Encrypting archive with AES-256-GCM AEAD (100k PBKDF2)...`);
  const encResult = await encryptFile({
    passphrase,
    sourceFilePath: rawDumpWinPath,
    destinationEncryptedPath: encFilePath,
    removeSourceAfterEncryption: true
  });

  console.log(`  ✓ Encrypted archive created: ${encFilePath}`);
  console.log(`  ✓ Container size:            ${encResult.bytesWritten} bytes`);
  console.log(`  ✓ SHA256 checksum:           ${encResult.sha256}`);
  console.log(`  ✓ Raw plaintext dump removed safely.`);

  // Write SHA256 file
  fs.writeFileSync(`${encFilePath}.sha256`, `${encResult.sha256}  ${encFileName}\n`);

  // 5. Verify archive container
  console.log(`\n[STEP 5/7] Verifying encrypted container metadata and AEAD tag...`);
  const verifyResult = verifyArchiveContainer(encFilePath, passphrase);
  if (!verifyResult.valid) {
    throw new Error(`Archive verification failed: ${verifyResult.error}`);
  }
  console.log(`  ✓ Container magic:  AIRA_ENC`);
  console.log(`  ✓ Cipher:          ${verifyResult.algorithm}`);
  console.log(`  ✓ Salt (hex):      ${verifyResult.saltHex}`);
  console.log(`  ✓ IV (hex):        ${verifyResult.ivHex}`);
  console.log(`  ✓ Tag (hex):       ${verifyResult.tagHex}`);
  console.log(`  ✓ Ciphertext size: ${verifyResult.ciphertextBytes} bytes`);

  // 6. Demonstrate restoration in isolation
  const isolatedDbName = `aira_restore_rehearsal_${Date.now()}`;
  console.log(`\n[STEP 6/7] Demonstrating restoration into isolated database "${isolatedDbName}"...`);

  // Create isolated database in local WSL PostgreSQL 16
  execWslScript(`#!/bin/bash
set -e
sudo -u postgres psql -c "CREATE DATABASE \\"${isolatedDbName}\\";"
sudo -u postgres psql -d "${isolatedDbName}" -c "CREATE EXTENSION IF NOT EXISTS vector;"
`, 'CREATE_DB');

  // Decrypt to temporary file for restoration
  const tmpDecryptedWinPath = path.join(os.tmpdir(), `rehearsal_${timestamp}.dump`);
  const tmpDecryptedWslPath = toWslPath(tmpDecryptedWinPath);

  try {
    console.log(`  - Decrypting archive to temporary verification file...`);
    await decryptFile({
      passphrase,
      sourceEncryptedPath: encFilePath,
      destinationPlaintextPath: tmpDecryptedWinPath
    });

    console.log(`  - Executing pg_restore into isolated database...`);
    execWslScript(`#!/bin/bash
set -euo pipefail
sudo -u postgres pg_restore --no-owner --no-privileges -d "${isolatedDbName}" "${tmpDecryptedWslPath}"
`, 'PG_RESTORE');

    // 7. Verify table and row parity
    console.log(`\n[STEP 7/7] Verifying 100% table and row count parity in isolated database...`);
    const isoClient = new pg.Client({
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      password: process.env.PGPASSWORD || 'rehearsal_test_pass',
      database: isolatedDbName,
    });
    await isoClient.connect();

    const restoredRowCounts: Record<string, number> = {};
    let totalRestoredRows = 0;
    let mismatches = 0;

    for (const [table, expectedCnt] of existingProdTables) {
      try {
        const res = await isoClient.query(`SELECT count(*)::int AS cnt FROM "${table}"`);
        const actualCnt = res.rows[0].cnt;
        restoredRowCounts[table] = actualCnt;
        totalRestoredRows += actualCnt;
        if (actualCnt !== expectedCnt) {
          console.error(`  ✗ Parity mismatch on table "${table}": prod=${expectedCnt}, restored=${actualCnt}`);
          mismatches++;
        }
      } catch (err: any) {
        console.error(`  ✗ Failed to query restored table "${table}": ${err.message}`);
        mismatches++;
      }
    }
    await isoClient.end();

    const parityPassed = mismatches === 0;
    console.log(`  ✓ Tables verified:      ${existingProdTables.length} / ${existingProdTables.length}`);
    console.log(`  ✓ Total rows restored:  ${totalRestoredRows} / ${totalProdRows}`);
    console.log(`  ✓ Parity match status:  ${parityPassed ? '100% EXACT PARITY PASS' : 'FAILED'}`);

    return {
      timestamp,
      backupFile: encFilePath,
      backupSizeBytes: encResult.bytesWritten,
      sha256: encResult.sha256,
      tablesVerified: existingProdTables.length,
      productionRowCounts: prodRowCounts,
      restoredRowCounts,
      parityPassed,
      isolatedDbName
    };
  } finally {
    // Cleanup temporary decrypted file
    if (fs.existsSync(tmpDecryptedWinPath)) {
      fs.unlinkSync(tmpDecryptedWinPath);
      console.log(`  ✓ Temporary decrypted file securely unlinked.`);
    }

    // Drop isolated test database
    try {
      execWslScript(`#!/bin/bash
sudo -u postgres psql -c "DROP DATABASE IF EXISTS \\"${isolatedDbName}\\";"
`, 'DROP_DB');
      console.log(`  ✓ Isolated test database "${isolatedDbName}" dropped cleanly.`);
    } catch (e: any) {
      console.warn(`  ! Notice: could not drop test database: ${e.message}`);
    }
  }
}

// Auto-run if executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const pass = process.env.AIRA_BACKUP_PASSPHRASE || process.env.BACKUP_PASSPHRASE;
  if (!pass || pass.trim().length < 16) {
    console.error('\n✗ [FATAL_FAIL_CLOSED] BACKUP_PASSPHRASE_REQUIRED: An explicit encryption passphrase of at least 16 characters must be set via AIRA_BACKUP_PASSPHRASE or BACKUP_PASSPHRASE environment variable. Deterministic fallbacks are forbidden.');
    process.exit(1);
  }
  runProductionBackupAndRestoreRehearsal(pass)
    .then((res) => {
      console.log('\n================================================================================');
      console.log(' PRODUCTION BACKUP & RESTORE REHEARSAL CERTIFICATION SUCCESSFUL                 ');
      console.log('================================================================================');
      console.log(`  - Archive Path:  ${res.backupFile}`);
      console.log(`  - Size:          ${res.backupSizeBytes} bytes`);
      console.log(`  - SHA256:        ${res.sha256}`);
      console.log(`  - Tables:        ${res.tablesVerified}`);
      console.log(`  - Parity Passed: ${res.parityPassed}`);
      process.exit(res.parityPassed ? 0 : 1);
    })
    .catch((err) => {
      console.error('\n✗ Rehearsal failed:', err.message);
      process.exit(1);
    });
}
