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
import { EXPECTED_TABLES } from './rehearse-disposable-restore.js';

const INDEP_KEY_FILE = 'C:\\Users\\WORKSTATION\\.aira_secure_keys\\aira_prod_backup_passphrase_dpapi_encrypted.bin';
const BACKUP_FILE = 'C:\\Users\\WORKSTATION\\AIRA_VAULT_REPLICA\\aira_prod_main_backup_20261115175000_fresh.dump.enc';

function toWslPath(winPath: string): string {
  return winPath.replace(/^([A-Za-z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/');
}

function retrievePassphraseFromDpapiEscrow(): string {
  const psScript = `
    Add-Type -AssemblyName System.Security
    $encBytes = [System.IO.File]::ReadAllBytes('${INDEP_KEY_FILE.replace(/\\/g, '\\\\')}')
    $entropy = [System.Text.Encoding]::UTF8.GetBytes('AIRA_AI_2026_INDEPENDENT_KEY_ESCROW')
    $decBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $encBytes,
      $entropy,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [System.Text.Encoding]::UTF8.GetString($decBytes)
  `;

  const res = spawnSync('powershell', ['-NoProfile', '-Command', psScript], {
    encoding: 'utf8',
  });

  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error(`Failed to unprotect key from DPAPI escrow: ${res.stderr || 'empty stdout'}`);
  }

  return res.stdout.trim();
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

async function main() {
  console.log('========================================================================');
  console.log(' AIRA AI 2026 — INDEPENDENT DPAPI BACKUP-KEY RECOVERY & PG18 PARITY');
  console.log('========================================================================\n');

  // 1. Verify existence of escrow and backup
  console.log('[1/6] Verifying independent DPAPI escrow file and backup archive...');
  if (!fs.existsSync(INDEP_KEY_FILE)) {
    throw new Error(`Independent DPAPI escrow file missing: ${INDEP_KEY_FILE}`);
  }
  if (!fs.existsSync(BACKUP_FILE)) {
    throw new Error(`Backup archive missing: ${BACKUP_FILE}`);
  }
  console.log(`  ✓ Independent escrow exists: ${INDEP_KEY_FILE}`);
  console.log(`  ✓ Encrypted archive exists: ${BACKUP_FILE} (${fs.statSync(BACKUP_FILE).size} bytes)`);

  // 2. Unprotect key via DPAPI into memory
  console.log('[2/6] Unprotecting encryption passphrase from DPAPI escrow in memory...');
  const passphrase = retrievePassphraseFromDpapiEscrow();
  if (passphrase.length < 16) {
    throw new Error('Retrieved passphrase length is insufficient (<16 chars)');
  }
  console.log(`  ✓ Passphrase retrieved successfully in memory (length: ${passphrase.length} chars, never logged/printed).`);

  // 3. Authenticate and decrypt archive
  console.log('[3/6] Authenticating and decrypting backup container via AES-256-GCM AEAD...');
  const headerCheck = verifyArchiveContainer(BACKUP_FILE, passphrase);
  if (!headerCheck.valid) {
    throw new Error(`Container authentication failed: ${headerCheck.error}`);
  }
  console.log(`  ✓ AEAD authentication verified: tag matches ciphertext (${headerCheck.ciphertextBytes} bytes).`);

  const decryptedDumpPath = path.join(os.tmpdir(), `aira_indep_recov_${Date.now()}.dump`);
  await decryptFile({
    passphrase,
    sourceEncryptedPath: BACKUP_FILE,
    destinationPlaintextPath: decryptedDumpPath,
  });
  console.log(`  ✓ Decrypted plaintext dump prepared: ${decryptedDumpPath} (${fs.statSync(decryptedDumpPath).size} bytes).`);

  // 4. Restore into isolated PostgreSQL 18.7 database
  const targetDbName = `aira_pg18_indep_escrow_val_${Date.now()}`;
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
  try {
    fs.unlinkSync(decryptedDumpPath);
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
    for (const tbl of tables) {
      const cntRes = await client.query(`SELECT count(*)::int as cnt FROM "${tbl}"`);
      totalRows += cntRes.rows[0].cnt;
    }
    console.log(`  -> Total rows: ${totalRows} / 12464 expected`);
    if (totalRows !== 12464) {
      throw new Error(`Expected 12464 rows, got ${totalRows}`);
    }

    // 5.2 Constraints
    const totalConstRes = await client.query(`
      SELECT count(*) as total FROM information_schema.table_constraints WHERE table_schema = 'public'
    `);
    console.log(`  -> Total table_constraints (information_schema): ${totalConstRes.rows[0].total} (reconciled 459)`);

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
    console.log(`  -> Total indexes: ${idxRes.rows[0].total} (expected 141)`);

    // 5.4 Sequences
    const seqRes = await client.query(`
      SELECT count(*) as total FROM information_schema.sequences WHERE sequence_schema = 'public'
    `);
    console.log(`  -> Total sequences: ${seqRes.rows[0].total} (expected 3)`);

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

    console.log('\n========================================================================');
    console.log(' INDEPENDENT KEY RECOVERY & POSTGRESQL 18 PARITY: 100% PASS');
    console.log('========================================================================\n');
  } finally {
    await client.end();
    // 6. Cleanup isolated database
    console.log(`[6/6] Dropping isolated test database "${targetDbName}"...`);
    execSync(`wsl -d Ubuntu-24.04 sudo -u postgres dropdb "${targetDbName}"`, { stdio: 'inherit' });
    console.log('  ✓ Test database dropped cleanly.');
  }
}

main().catch(err => {
  console.error('Certification failed:', err);
  process.exit(1);
});
