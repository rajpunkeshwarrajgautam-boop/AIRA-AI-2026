import type pg from 'pg';

export interface RestoreParityRequirements {
  minTables: number;
  minRows: number;
  minConstraints: number;
  minIndexes: number;
  requiredTables?: string[];
}

export interface RestoreAuditResult {
  tableCount: number;
  totalRows: number;
  constraintCount: number;
  indexCount: number;
  verified: boolean;
}

/**
 * Audits a restored PostgreSQL database for complete schema and data parity.
 * Fails closed if any table, row threshold, constraint count, or index count is deficient.
 */
export async function auditRestoredDatabaseParity(
  client: pg.Client,
  requirements: RestoreParityRequirements
): Promise<RestoreAuditResult> {
  // 1. Table audit
  const tablesRes = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const tables: string[] = tablesRes.rows.map((r: any) => r.table_name);
  if (tables.length < requirements.minTables) {
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

  // 2. Row count audit
  let totalRows = 0;
  for (const tbl of tables) {
    const rowRes = await client.query(`SELECT count(*)::int as cnt FROM "${tbl}"`);
    totalRows += rowRes.rows[0].cnt;
  }
  if (totalRows < requirements.minRows) {
    throw new Error(
      `[RESTORE_VERIFICATION_FAILURE] Deficient total row count: restored ${totalRows} rows, expected at least ${requirements.minRows}.`
    );
  }

  // 3. Constraint audit
  const constRes = await client.query(`
    SELECT count(*)::int as cnt FROM information_schema.table_constraints WHERE table_schema = 'public'
  `);
  const constraintCount: number = constRes.rows[0].cnt;
  if (constraintCount < requirements.minConstraints) {
    throw new Error(
      `[RESTORE_VERIFICATION_FAILURE] Deficient constraint count: found ${constraintCount}, expected at least ${requirements.minConstraints}.`
    );
  }

  // 4. Index audit
  const indexRes = await client.query(`
    SELECT count(*)::int as cnt FROM pg_indexes WHERE schemaname = 'public'
  `);
  const indexCount: number = indexRes.rows[0].cnt;
  if (indexCount < requirements.minIndexes) {
    throw new Error(
      `[RESTORE_VERIFICATION_FAILURE] Deficient index count: found ${indexCount}, expected at least ${requirements.minIndexes}.`
    );
  }

  return {
    tableCount: tables.length,
    totalRows,
    constraintCount,
    indexCount,
    verified: true,
  };
}
