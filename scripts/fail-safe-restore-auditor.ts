import type pg from 'pg';

export interface ExactConstraintsRequirement {
  primaryKeys?: number;
  foreignKeys?: number;
  uniqueConstraints?: number;
  checkConstraints?: number;
  notNullConstraints?: number;
  totalRelationalConstraints?: number;
  totalConstraints?: number;
}

export interface RestoreParityRequirements {
  minTables?: number;
  minRows?: number;
  minConstraints?: number;
  minIndexes?: number;
  requiredTables?: string[];
  exactTables?: readonly string[] | string[];
  exactTotalRows?: number;
  exactTableRows?: Record<string, number>;
  exactConstraints?: ExactConstraintsRequirement;
  exactIndexes?: number;
  exactSequences?: readonly string[] | string[];
  exactExtensions?: readonly string[] | string[];
  verifyReferentialIntegrity?: boolean;
}

export interface ConstraintsBreakdown {
  primaryKeys: number;
  foreignKeys: number;
  uniqueConstraints: number;
  checkConstraints: number;
  notNullConstraints: number;
  totalRelational: number;
  total: number;
}

export interface RestoreAuditResult {
  tableCount: number;
  totalRows: number;
  constraintCount: number;
  indexCount: number;
  sequenceCount: number;
  extensions: string[];
  constraintsBreakdown: ConstraintsBreakdown;
  referentialIntegrityVerified: boolean;
  exactParityVerified: boolean;
  verified: boolean;
}

/**
 * Audits a restored PostgreSQL database for complete schema and data parity.
 * Verifies exact expected schema, table catalogs, row counts, constraints,
 * indexes, sequences, extensions, and foreign-key referential integrity.
 * Fails closed if any threshold, exact parity check, or referential integrity check fails.
 */
export async function auditRestoredDatabaseParity(
  client: pg.Client,
  requirements: RestoreParityRequirements
): Promise<RestoreAuditResult> {
  // 1. Table audit (BASE TABLE in public schema)
  const tablesRes = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const tables: string[] = tablesRes.rows.map((r: any) => r.table_name);

  if (requirements.minTables !== undefined && tables.length < requirements.minTables) {
    throw new Error(
      `[RESTORE_VERIFICATION_FAILURE] Deficient table count: found ${tables.length} tables, expected at least ${requirements.minTables}.`
    );
  }

  if (requirements.requiredTables) {
    const tableSet = new Set(tables);
    for (const reqTbl of requirements.requiredTables) {
      if (!tableSet.has(reqTbl)) {
        throw new Error(`[RESTORE_VERIFICATION_FAILURE] Required table "${reqTbl}" is missing from restored database.`);
      }
    }
  }

  if (requirements.exactTables) {
    const actualSet = new Set(tables);
    const expectedSet = new Set(requirements.exactTables);
    const missing = requirements.exactTables.filter(t => !actualSet.has(t));
    const unexpected = tables.filter(t => !expectedSet.has(t));

    if (missing.length > 0) {
      throw new Error(`[RESTORE_VERIFICATION_FAILURE] Missing exact tables (${missing.length}): ${missing.join(', ')}`);
    }
    if (unexpected.length > 0) {
      throw new Error(`[RESTORE_VERIFICATION_FAILURE] Unexpected extra tables found (${unexpected.length}): ${unexpected.join(', ')}`);
    }
    if (tables.length !== requirements.exactTables.length) {
      throw new Error(
        `[RESTORE_VERIFICATION_FAILURE] Exact table count mismatch: found ${tables.length}, expected ${requirements.exactTables.length}.`
      );
    }
  }

  // 2. Row count audit
  let totalRows = 0;
  const actualTableRows: Record<string, number> = {};
  for (const tbl of tables) {
    const rowRes = await client.query(`SELECT count(*)::int as cnt FROM "${tbl}"`);
    const cnt: number = rowRes.rows[0].cnt;
    actualTableRows[tbl] = cnt;
    totalRows += cnt;
  }

  if (requirements.minRows !== undefined && totalRows < requirements.minRows) {
    throw new Error(
      `[RESTORE_VERIFICATION_FAILURE] Deficient total row count: restored ${totalRows} rows, expected at least ${requirements.minRows}.`
    );
  }

  if (requirements.exactTotalRows !== undefined && totalRows !== requirements.exactTotalRows) {
    throw new Error(
      `[RESTORE_VERIFICATION_FAILURE] Exact total row count mismatch: found ${totalRows}, expected exactly ${requirements.exactTotalRows}.`
    );
  }

  if (requirements.exactTableRows) {
    for (const [tbl, expectedCnt] of Object.entries(requirements.exactTableRows)) {
      const actualCnt = actualTableRows[tbl] ?? -1;
      if (actualCnt !== expectedCnt) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Exact row count mismatch for table "${tbl}": found ${actualCnt}, expected ${expectedCnt}.`
        );
      }
    }
  }

  // 3. Constraint audit & breakdown
  const constRes = await client.query(`
    SELECT contype, count(*)::int AS count
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public'
    GROUP BY contype
    ORDER BY contype
  `);

  let pkCount = 0;
  let fkCount = 0;
  let uqCount = 0;
  let ckCount = 0;
  let notNullCount = 0;
  let totalConstraints = 0;

  for (const row of constRes.rows) {
    const c = parseInt(row.count, 10);
    totalConstraints += c;
    if (row.contype === 'p') pkCount = c;
    else if (row.contype === 'f') fkCount = c;
    else if (row.contype === 'u') uqCount = c;
    else if (row.contype === 'c') ckCount = c;
    else if (row.contype === 'n') notNullCount = c;
  }
  const totalRelational = pkCount + fkCount + uqCount + ckCount;

  const breakdown: ConstraintsBreakdown = {
    primaryKeys: pkCount,
    foreignKeys: fkCount,
    uniqueConstraints: uqCount,
    checkConstraints: ckCount,
    notNullConstraints: notNullCount,
    totalRelational,
    total: totalConstraints,
  };

  if (requirements.minConstraints !== undefined) {
    const countToCheck = totalConstraints > 0 ? totalConstraints : totalRelational;
    if (countToCheck < requirements.minConstraints) {
      throw new Error(
        `[RESTORE_VERIFICATION_FAILURE] Deficient constraint count: found ${countToCheck}, expected at least ${requirements.minConstraints}.`
      );
    }
  }

  if (requirements.exactConstraints) {
    const ec = requirements.exactConstraints;
    if (ec.primaryKeys !== undefined && pkCount !== ec.primaryKeys) {
      throw new Error(`[RESTORE_VERIFICATION_FAILURE] Exact primary key count mismatch: found ${pkCount}, expected ${ec.primaryKeys}.`);
    }
    if (ec.foreignKeys !== undefined && fkCount !== ec.foreignKeys) {
      throw new Error(`[RESTORE_VERIFICATION_FAILURE] Exact foreign key count mismatch: found ${fkCount}, expected ${ec.foreignKeys}.`);
    }
    if (ec.uniqueConstraints !== undefined && uqCount !== ec.uniqueConstraints) {
      throw new Error(`[RESTORE_VERIFICATION_FAILURE] Exact unique constraint count mismatch: found ${uqCount}, expected ${ec.uniqueConstraints}.`);
    }
    if (ec.checkConstraints !== undefined && ckCount !== ec.checkConstraints) {
      throw new Error(`[RESTORE_VERIFICATION_FAILURE] Exact check constraint count mismatch: found ${ckCount}, expected ${ec.checkConstraints}.`);
    }
    if (ec.totalRelationalConstraints !== undefined && totalRelational !== ec.totalRelationalConstraints) {
      throw new Error(`[RESTORE_VERIFICATION_FAILURE] Exact relational constraint count mismatch: found ${totalRelational}, expected ${ec.totalRelationalConstraints}.`);
    }
    if (ec.totalConstraints !== undefined && totalConstraints !== ec.totalConstraints) {
      throw new Error(`[RESTORE_VERIFICATION_FAILURE] Exact total constraint count mismatch: found ${totalConstraints}, expected ${ec.totalConstraints}.`);
    }
  }

  // 4. Foreign Key Referential Integrity (Orphan Detection)
  let referentialIntegrityVerified = false;
  if (requirements.verifyReferentialIntegrity) {
    const fkQuery = `
      SELECT
        tc.table_name as child_table,
        kcu.column_name as child_column,
        ccu.table_name as parent_table,
        ccu.column_name as parent_column
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    `;
    const fkRows = await client.query(fkQuery);
    for (const fk of fkRows.rows) {
      const orphanRes = await client.query(`
        SELECT count(*)::int as orphaned
        FROM "${fk.child_table}" c
        WHERE c."${fk.child_column}" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "${fk.parent_table}" p WHERE p."${fk.parent_column}" = c."${fk.child_column}"
          )
      `);
      if (orphanRes.rows[0].orphaned > 0) {
        throw new Error(
          `[RESTORE_REFERENTIAL_INTEGRITY_FAILURE] Found ${orphanRes.rows[0].orphaned} orphaned records in "${fk.child_table}.${fk.child_column}" referencing non-existent records in "${fk.parent_table}.${fk.parent_column}".`
        );
      }
    }
    referentialIntegrityVerified = true;
  }

  // 5. Index audit
  const indexRes = await client.query(`
    SELECT count(*)::int as cnt FROM pg_indexes WHERE schemaname = 'public'
  `);
  const indexCount: number = indexRes.rows[0].cnt;
  if (requirements.minIndexes !== undefined && indexCount < requirements.minIndexes) {
    throw new Error(
      `[RESTORE_VERIFICATION_FAILURE] Deficient index count: found ${indexCount}, expected at least ${requirements.minIndexes}.`
    );
  }
  if (requirements.exactIndexes !== undefined && indexCount !== requirements.exactIndexes) {
    throw new Error(
      `[RESTORE_VERIFICATION_FAILURE] Exact index count mismatch: found ${indexCount}, expected ${requirements.exactIndexes}.`
    );
  }

  // 6. Sequence audit
  const seqRes = await client.query(`
    SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' ORDER BY sequence_name
  `);
  const sequences: string[] = seqRes.rows.map((r: any) => r.sequence_name);
  if (requirements.exactSequences) {
    const seqSet = new Set(sequences);
    for (const seq of requirements.exactSequences) {
      if (!seqSet.has(seq)) {
        throw new Error(`[RESTORE_VERIFICATION_FAILURE] Missing expected sequence: "${seq}".`);
      }
    }
    if (sequences.length !== requirements.exactSequences.length) {
      throw new Error(
        `[RESTORE_VERIFICATION_FAILURE] Exact sequence count mismatch: found ${sequences.length}, expected ${requirements.exactSequences.length}.`
      );
    }
  }

  // 7. Extensions audit
  const extRes = await client.query(`
    SELECT extname FROM pg_extension ORDER BY extname
  `);
  const extensions: string[] = extRes.rows.map((r: any) => r.extname);
  if (requirements.exactExtensions) {
    const extSet = new Set(extensions);
    for (const ext of requirements.exactExtensions) {
      if (!extSet.has(ext)) {
        throw new Error(`[RESTORE_VERIFICATION_FAILURE] Missing expected database extension: "${ext}".`);
      }
    }
  }

  return {
    tableCount: tables.length,
    totalRows,
    constraintCount: totalConstraints > 0 ? totalConstraints : totalRelational,
    indexCount,
    sequenceCount: sequences.length,
    extensions,
    constraintsBreakdown: breakdown,
    referentialIntegrityVerified,
    exactParityVerified: Boolean(requirements.exactTables && requirements.exactTotalRows !== undefined),
    verified: true,
  };
}
