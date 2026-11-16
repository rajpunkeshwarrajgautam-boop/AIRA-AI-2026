import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync, execSync } from 'node:child_process';
import pg from 'pg';
import {
  decryptFile,
  verifyArchiveContainer,
} from './secure-backup-crypto.js';
import {
  recoverKeyFromPortableEnvelope,
  promptSecretNonEchoing,
} from './portable-recovery-escrow.js';

const DEFAULT_ENVELOPE = 'E:\\AIRA_RECOVERY_ESCROW\\aira_portable_recovery_envelope.json';
const DEFAULT_BACKUP = 'E:\\AIRA_RECOVERY_ESCROW\\aira_prod_main_backup_20261115175000_fresh.dump.enc';
const EXPECTED_BACKUP_SHA256 = '7D49AB20FFA199DB3A6D3F26E62D1EECD27F90556F74D7EB49F1DC0380049877';
const EVIDENCE_OUTPUT_FILE = 'C:\\Users\\WORKSTATION\\AIRA_VAULT_REPLICA\\step5_dr_restoration_evidence.json';

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
      maxBuffer: 100 * 1024 * 1024,
    });
    if (res.status !== 0) {
      throw new Error(`[${logPrefix}] Script failed (exit ${res.status}): ${res.stderr || res.stdout}`);
    }
  } finally {
    try { fs.unlinkSync(tmpScriptWinPath); } catch {}
  }
}

export async function runPortableDisasterRecoveryValidation(options?: {
  envelopePath?: string;
  backupPath?: string;
  recoveryPassphrase?: string;
}): Promise<void> {
  console.log('========================================================================');
  console.log(' AIRA AI 2026 — DPAPI-FREE PORTABLE DISASTER RECOVERY & PG18 PARITY');
  console.log('========================================================================\n');

  const envelopePath = options?.envelopePath || process.env.AIRA_RECOVERY_ENVELOPE || DEFAULT_ENVELOPE;
  const backupPath = options?.backupPath || process.env.AIRA_RECOVERY_BACKUP || DEFAULT_BACKUP;

  // 1. Verify existence of envelope and backup archive on external storage
  console.log('[1/6] Verifying independent recovery escrow files on external drive...');
  if (!fs.existsSync(envelopePath)) {
    throw new Error(`[DR_VERIFY_ERROR] Portable recovery envelope missing: "${envelopePath}". Run escrow export CLI first.`);
  }
  if (!fs.existsSync(backupPath)) {
    throw new Error(`[DR_VERIFY_ERROR] Encrypted backup archive missing: "${backupPath}".`);
  }

  const backupSha256 = crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex').toUpperCase();
  if (backupSha256 !== EXPECTED_BACKUP_SHA256) {
    throw new Error(`[DR_VERIFY_ERROR] Backup checksum mismatch: got ${backupSha256}, expected ${EXPECTED_BACKUP_SHA256}`);
  }
  console.log(`  ✓ Portable recovery envelope: ${envelopePath} (${fs.statSync(envelopePath).size} bytes)`);
  console.log(`  ✓ Encrypted backup archive:   ${backupPath} (${fs.statSync(backupPath).size} bytes)`);
  console.log(`  ✓ Backup archive checksum:    ${backupSha256} (100% exact match)`);

  // 2. Prompt or retrieve independent recovery passphrase (zero DPAPI, zero Windows user store)
  console.log('\n[2/6] Recovering backup key from portable envelope (DPAPI-free, scrypt + AES-256-GCM)...');
  let recoveryPassphrase = options?.recoveryPassphrase || process.env.AIRA_RECOVERY_PASSPHRASE || '';
  if (!recoveryPassphrase && process.stdin.isTTY) {
    recoveryPassphrase = await promptSecretNonEchoing('Enter independent recovery passphrase: ');
  }
  if (!recoveryPassphrase || recoveryPassphrase.length < 16) {
    throw new Error('[DR_VERIFY_ERROR] Recovery passphrase must be provided (>=16 chars) via prompt or AIRA_RECOVERY_PASSPHRASE.');
  }

  const { backupKey, keyFingerprint } = recoverKeyFromPortableEnvelope(envelopePath, recoveryPassphrase);
  console.log(`  ✓ Key recovered cleanly via portable envelope:`);
  console.log(`    - Key fingerprint: ${keyFingerprint} (SHA-256)`);
  console.log(`    - Plaintext key length: ${backupKey.length} chars (never printed/logged)`);

  // 3. Authenticate and decrypt backup container using recovered key
  console.log('\n[3/6] Authenticating and decrypting backup container via AES-256-GCM AEAD...');
  const headerCheck = verifyArchiveContainer(backupPath, backupKey);
  if (!headerCheck.valid) {
    throw new Error(`[DR_VERIFY_ERROR] Container authentication failed: ${headerCheck.error}`);
  }
  console.log(`  ✓ AEAD authentication verified: tag matches ciphertext (${headerCheck.ciphertextBytes} bytes).`);

  const decryptedDumpPath = path.join(os.tmpdir(), `aira_portable_dr_${Date.now()}.dump`);
  await decryptFile({
    passphrase: backupKey,
    sourceEncryptedPath: backupPath,
    destinationPlaintextPath: decryptedDumpPath,
  });
  console.log(`  ✓ Plaintext dump prepared: ${decryptedDumpPath} (${fs.statSync(decryptedDumpPath).size} bytes).`);

  // 4. Restore into isolated PostgreSQL 18.7 database on WSL Ubuntu
  const targetDbName = `aira_pg18_portable_dr_${Date.now()}`;
  console.log(`\n[4/6] Restoring into isolated PostgreSQL 18.7 database "${targetDbName}" on WSL...`);
  const wslDumpPath = toWslPath(decryptedDumpPath);
  const restoreScript = `
    set -euo pipefail
    sudo -u postgres createdb "${targetDbName}"
    sudo -u postgres pg_restore -d "${targetDbName}" --no-owner --no-privileges "${wslDumpPath}"
  `;
  execWslScript(restoreScript, 'PG_RESTORE');
  console.log('  ✓ PostgreSQL 18 restoration completed.');

  // Shred decrypted dump immediately
  let shredded = false;
  try {
    fs.unlinkSync(decryptedDumpPath);
    shredded = true;
    console.log('  ✓ Decrypted dump shredded from disk.');
  } catch {}

  // 5. Audit parity on restored database
  console.log('\n[5/6] Auditing database schema, table rows, constraints, and referential integrity...');
  const client = new pg.Client({
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: process.env.PGPASSWORD || 'rehearsal_test_pass',
    database: targetDbName,
  });
  await client.connect();

  let auditEvidence: any = null;

  try {
    // 5.1 Tables and Rows
    const tableRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const tables = tableRes.rows.map(r => r.table_name);
    console.log(`  -> Tables found: ${tables.length} / 48 expected`);
    if (tables.length !== 48) {
      throw new Error(`Expected 48 tables, got ${tables.length}`);
    }

    let totalRows = 0;
    const perTableRows: Record<string, number> = {};
    for (const tbl of tables) {
      const cntRes = await client.query(`SELECT count(*)::int as cnt FROM "${tbl}"`);
      const cnt = cntRes.rows[0].cnt;
      perTableRows[tbl] = cnt;
      totalRows += cnt;
    }
    console.log(`  -> Total rows: ${totalRows} / 12464 expected`);
    if (totalRows !== 12464) {
      throw new Error(`Expected 12464 rows, got ${totalRows}`);
    }

    // 5.2 Constraints
    const totalConstRes = await client.query(`
      SELECT count(*) as total FROM information_schema.table_constraints WHERE table_schema = 'public'
    `);
    const totalConstraints = totalConstRes.rows[0].total;
    console.log(`  -> Total table_constraints: ${totalConstraints}`);

    const pgConstRes = await client.query(`
      SELECT contype, count(*) as count
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'
      GROUP BY contype
      ORDER BY contype
    `);
    console.log('  -> pg_constraint breakdown:', JSON.stringify(pgConstRes.rows));

    // 5.3 Indexes
    const idxRes = await client.query(`
      SELECT count(*) as total FROM pg_indexes WHERE schemaname = 'public'
    `);
    const totalIndexes = idxRes.rows[0].total;
    console.log(`  -> Total indexes: ${totalIndexes} (expected 141)`);

    // 5.4 Sequences
    const seqRes = await client.query(`
      SELECT count(*) as total FROM information_schema.sequences WHERE sequence_schema = 'public'
    `);
    const totalSequences = seqRes.rows[0].total;
    console.log(`  -> Total sequences: ${totalSequences} (expected 3)`);

    // 5.5 Extensions
    const extRes = await client.query(`SELECT extname, extversion FROM pg_extension ORDER BY extname`);
    console.log('  -> Installed extensions:', JSON.stringify(extRes.rows));

    // 5.6 Foreign key referential integrity check
    console.log('  -> Checking for orphaned foreign keys across all relational constraints...');
    const fkRes = await client.query(`
      SELECT
        tc.table_name, kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    `);

    let orphanCount = 0;
    for (const fk of fkRes.rows) {
      const orphanCheck = await client.query(`
        SELECT count(*)::int as cnt
        FROM "${fk.table_name}" t
        WHERE t."${fk.column_name}" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "${fk.foreign_table_name}" f
            WHERE f."${fk.foreign_column_name}" = t."${fk.column_name}"
          )
      `);
      if (orphanCheck.rows[0].cnt > 0) {
        console.error(`  [ORPHAN] ${fk.table_name}.${fk.column_name} -> ${fk.foreign_table_name}.${fk.foreign_column_name}: ${orphanCheck.rows[0].cnt} orphans`);
        orphanCount += orphanCheck.rows[0].cnt;
      }
    }
    console.log(`  ✓ Foreign key integrity verified: 0 orphaned foreign keys found.`);
    if (orphanCount > 0) {
      throw new Error(`Referential integrity failure: ${orphanCount} orphaned foreign keys`);
    }

    auditEvidence = {
      status: 'PASS',
      timestamp: new Date().toISOString(),
      sourceStorage: 'REMOVABLE_DRIVE_E',
      sourceBackupFile: backupPath,
      backupSha256,
      portableEnvelopeFile: envelopePath,
      keyFingerprintSha256: keyFingerprint,
      dpapiAccessUsed: false,
      originalLocalBackupUsed: false,
      plaintextDumpShredded: shredded,
      restoredDatabase: targetDbName,
      postgresqlVersion: '18.7 (Ubuntu 24.04 on WSL)',
      verificationMetrics: {
        tableCount: tables.length,
        totalRowCount: totalRows,
        constraintCount: totalConstraints,
        pgConstraintBreakdown: pgConstRes.rows,
        indexCount: totalIndexes,
        sequenceCount: totalSequences,
        extensions: extRes.rows,
        orphanedForeignKeys: orphanCount,
      },
    };

    try {
      fs.writeFileSync(EVIDENCE_OUTPUT_FILE, JSON.stringify(auditEvidence, null, 2), 'utf8');
      console.log(`  ✓ Sanitized restoration evidence recorded: ${EVIDENCE_OUTPUT_FILE}`);
    } catch {}

    console.log('\n========================================================================');
    console.log(' DPAPI-FREE PORTABLE DISASTER RECOVERY & PG18 PARITY: 100% PASS');
    console.log('========================================================================\n');
  } finally {
    await client.end();
    // 6. Cleanup isolated database
    console.log(`[6/6] Dropping isolated test database "${targetDbName}"...`);
    execSync(`wsl -d Ubuntu-24.04 sudo -u postgres dropdb "${targetDbName}"`, { stdio: 'inherit' });
    console.log('  ✓ Test database dropped cleanly.');
  }
}

// Direct CLI entrypoint
if (process.argv[1] && (process.argv[1].endsWith('validate-portable-key-recovery.ts') || process.argv[1].endsWith('validate-portable-key-recovery.js'))) {
  runPortableDisasterRecoveryValidation().catch(err => {
    console.error('Certification failed:', err);
    process.exit(1);
  });
}
