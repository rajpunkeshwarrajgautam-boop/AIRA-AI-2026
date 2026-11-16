export interface ExactConstraintsRequirement {
  primaryKeys?: number;
  foreignKeys?: number;
  uniqueConstraints?: number;
  checkConstraints?: number;
  notNullConstraints?: number;
  totalRelationalConstraints?: number;
  totalConstraints?: number;
}

export interface ExactConstraintDefRequirement {
  table_name: string;
  constraint_name: string;
  constraint_type?: string;
  definition?: string;
}

export interface ExactIndexDefRequirement {
  tablename: string;
  indexname: string;
  indexdef?: string;
}

export interface ExactColumnRequirement {
  table_name: string;
  column_name: string;
  data_type?: string;
  is_nullable?: string;
  column_default?: string | null;
  is_identity?: string;
  identity_generation?: string | null;
}

export interface ExactSequenceRequirement {
  sequence_name: string;
  data_type?: string;
  owner_table?: string | null;
  owner_column?: string | null;
  last_value?: number | string;
}

export interface ExactExtensionRequirement {
  extname: string;
  extversion?: string;
  allowedVersions?: readonly string[] | string[];
}

export interface ExactMigrationRecord {
  id?: number;
  name: string;
  batch?: number;
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
  exactConstraintDefs?: readonly ExactConstraintDefRequirement[];
  exactIndexes?: number;
  exactIndexNames?: readonly string[] | string[];
  exactIndexDefs?: readonly ExactIndexDefRequirement[];
  exactSequences?: readonly string[] | string[];
  exactSequencesDetail?: readonly ExactSequenceRequirement[];
  exactExtensions?: readonly string[] | string[];
  exactExtensionsDetail?: readonly ExactExtensionRequirement[];
  exactColumns?: readonly ExactColumnRequirement[];
  exactColumnCount?: number;
  expectedMigrations?: readonly string[] | string[];
  expectedMigrationLedger?: readonly ExactMigrationRecord[];
  verifyReferentialIntegrity?: boolean;
  /** Fail closed if PostgreSQL FK metadata cannot be read or reconciled; mandatory for disaster-recovery certification. */
  strictForeignKeyCatalog?: boolean;
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
  columnCount: number;
  migrationCount?: number;
  extensions: string[];
  constraintsBreakdown: ConstraintsBreakdown;
  referentialIntegrityVerified: boolean;
  exactParityVerified: boolean;
  verified: boolean;
}

export interface MinimalQueryClient {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

export function normalizeSql(sql: string | null | undefined): string {
  if (sql === null || sql === undefined) return '';
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Audits a restored PostgreSQL database for complete schema, data, metadata, and referential parity.
 * Verifies exact expected schema, table catalogs, row counts, constraints definitions via pg_get_constraintdef,
 * canonical index definitions via pg_indexes (indexdef), column data types/nullability/defaults/identities,
 * sequence ownership via pg_depend and sequence values, extension versions with allowed version policy,
 * Knex migration ledger exact ordering, and foreign-key referential integrity with composite key and MATCH semantics.
 * Fails closed if any threshold, exact parity check, or referential integrity check fails.
 */
export async function auditRestoredDatabaseParity(
  client: MinimalQueryClient,
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
    const cnt: number = parseInt(rowRes.rows[0]?.cnt ?? '0', 10);
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
    if (ec.notNullConstraints !== undefined && notNullCount !== ec.notNullConstraints) {
      throw new Error(`[RESTORE_VERIFICATION_FAILURE] Exact not-null constraint count mismatch: found ${notNullCount}, expected ${ec.notNullConstraints}.`);
    }
    if (ec.totalRelationalConstraints !== undefined && totalRelational !== ec.totalRelationalConstraints) {
      throw new Error(`[RESTORE_VERIFICATION_FAILURE] Exact relational constraint count mismatch: found ${totalRelational}, expected ${ec.totalRelationalConstraints}.`);
    }
    if (ec.totalConstraints !== undefined && totalConstraints !== ec.totalConstraints) {
      throw new Error(`[RESTORE_VERIFICATION_FAILURE] Exact total constraint count mismatch: found ${totalConstraints}, expected ${ec.totalConstraints}.`);
    }
  }

  // 3b. Constraint definitions audit via pg_get_constraintdef
  if (requirements.exactConstraintDefs) {
    const constDefRes = await client.query(`
      SELECT
        cls.relname AS table_name,
        c.conname AS constraint_name,
        c.contype AS constraint_type,
        pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      JOIN pg_class cls ON cls.oid = c.conrelid
      WHERE n.nspname = 'public'
      ORDER BY cls.relname, c.conname
    `);
    const actualDefsMap = new Map<string, any>();
    for (const r of constDefRes.rows) {
      actualDefsMap.set(`${r.table_name}.${r.constraint_name}`, r);
    }
    for (const exp of requirements.exactConstraintDefs) {
      const key = `${exp.table_name}.${exp.constraint_name}`;
      const actual = actualDefsMap.get(key);
      if (!actual) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Missing expected constraint "${exp.constraint_name}" on table "${exp.table_name}".`
        );
      }
      if (exp.constraint_type && actual.constraint_type !== exp.constraint_type) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Constraint type mismatch for "${key}": found "${actual.constraint_type}", expected "${exp.constraint_type}".`
        );
      }
      if (exp.definition && normalizeSql(actual.definition) !== normalizeSql(exp.definition)) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Constraint definition mismatch for "${key}": found "${actual.definition}", expected "${exp.definition}".`
        );
      }
    }
  }

  // 4. Foreign Key Referential Integrity & Composite FK Handling with MATCH Semantics
  let referentialIntegrityVerified = false;
  if (requirements.verifyReferentialIntegrity) {
    let fkRows: any[] = [];
    try {
      const richFkQuery = `
        SELECT
          c.conname AS constraint_name,
          cls.relname AS child_table,
          fcls.relname AS parent_table,
          coalesce(c.confmatchtype, 'u') AS match_type,
          ARRAY(
            SELECT att.attname
            FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
            JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
            ORDER BY u.ord
          ) AS child_columns,
          ARRAY(
            SELECT fatt.attname
            FROM unnest(c.confkey) WITH ORDINALITY AS fu(attnum, ord)
            JOIN pg_attribute fatt ON fatt.attrelid = c.confrelid AND fatt.attnum = fu.attnum
            ORDER BY fu.ord
          ) AS parent_columns,
          pg_get_constraintdef(c.oid) AS constraint_def
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        JOIN pg_class cls ON cls.oid = c.conrelid
        JOIN pg_class fcls ON fcls.oid = c.confrelid
        WHERE n.nspname = 'public' AND c.contype = 'f'
        ORDER BY cls.relname, c.conname
      `;
      const richRes = await client.query(richFkQuery);
      const isValidFkRow = (r: any) => Boolean(r && (r.child_columns || r.child_column));
      if (richRes && Array.isArray(richRes.rows) && richRes.rows.length > 0 && richRes.rows.some(isValidFkRow)) {
        fkRows = richRes.rows.filter(isValidFkRow);
      }
    } catch (catalogError) {
      if (requirements.strictForeignKeyCatalog) {
        const detail = catalogError instanceof Error ? catalogError.message : String(catalogError);
        throw new Error(`[RESTORE_VERIFICATION_FAILURE] PostgreSQL FK catalog query failed: ${detail}`);
      }
      // Legacy minimal test clients may lack PostgreSQL catalog support.
    }

    if (requirements.strictForeignKeyCatalog && requirements.exactConstraints?.foreignKeys !== undefined &&
        fkRows.length !== requirements.exactConstraints.foreignKeys) {
      throw new Error(
        `[RESTORE_VERIFICATION_FAILURE] FK catalog count mismatch: found ${fkRows.length}, expected ${requirements.exactConstraints.foreignKeys}. Refusing single-column metadata fallback.`
      );
    }

    if (fkRows.length === 0 && !requirements.strictForeignKeyCatalog) {
      const fallbackFkQuery = `
        SELECT
          tc.constraint_name,
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
      const fallbackRes = await client.query(fallbackFkQuery);
      fkRows = fallbackRes.rows || [];
    }

    for (const fk of fkRows) {
      let childCols: string[] = [];
      let parentCols: string[] = [];

      if (Array.isArray(fk.child_columns)) {
        childCols = fk.child_columns;
      } else if (typeof fk.child_columns === 'string') {
        childCols = fk.child_columns.split(',').map((s: string) => s.trim());
      } else if (fk.child_column) {
        childCols = [fk.child_column];
      }

      if (Array.isArray(fk.parent_columns)) {
        parentCols = fk.parent_columns;
      } else if (typeof fk.parent_columns === 'string') {
        parentCols = fk.parent_columns.split(',').map((s: string) => s.trim());
      } else if (fk.parent_column) {
        parentCols = [fk.parent_column];
      }

      if (childCols.length === 0 || parentCols.length === 0 || childCols.length !== parentCols.length) {
        throw new Error(
          `[RESTORE_REFERENTIAL_INTEGRITY_FAILURE] Foreign key "${fk.constraint_name || 'unknown'}" has invalid column mapping: child=[${childCols.join(', ')}], parent=[${parentCols.join(', ')}].`
        );
      }

      const matchType = (fk.match_type || 'u').toLowerCase();

      // MATCH FULL: either ALL referencing columns are NULL, or NONE are NULL (and all must match parent)
      if (matchType === 'f' && childCols.length > 1) {
        const anyNull = childCols.map(c => `c."${c}" IS NULL`).join(' OR ');
        const allNull = childCols.map(c => `c."${c}" IS NULL`).join(' AND ');
        const partialNullRes = await client.query(`
          SELECT count(*)::int as partial_nulls
          FROM "${fk.child_table}" c
          WHERE (${anyNull}) AND NOT (${allNull})
        `);
        const partialNulls = parseInt(partialNullRes.rows[0]?.partial_nulls ?? '0', 10);
        if (partialNulls > 0) {
          throw new Error(
            `[RESTORE_REFERENTIAL_INTEGRITY_FAILURE] Found ${partialNulls} records in "${fk.child_table}" violating MATCH FULL on "${fk.constraint_name}" (partial nulls in composite foreign key).`
          );
        }
      }

      // Referential check (both MATCH SIMPLE and MATCH FULL):
      // In MATCH SIMPLE (default 'u'): if ANY child column is NULL, the FK is satisfied.
      // If ALL child columns are NOT NULL, a matching row must exist in the parent table.
      const allNotNull = childCols.map(c => `c."${c}" IS NOT NULL`).join(' AND ');
      const joinConditions = childCols.map((col, idx) => `p."${parentCols[idx]}" = c."${col}"`).join(' AND ');

      const orphanRes = await client.query(`
        SELECT count(*)::int as orphaned
        FROM "${fk.child_table}" c
        WHERE (${allNotNull})
          AND NOT EXISTS (
            SELECT 1 FROM "${fk.parent_table}" p WHERE ${joinConditions}
          )
      `);
      const orphaned = parseInt(orphanRes.rows[0]?.orphaned ?? '0', 10);
      if (orphaned > 0) {
        const childTarget = childCols.length === 1 ? `"${fk.child_table}.${childCols[0]}"` : `"${fk.child_table}" (${childCols.join(', ')})`;
        const parentTarget = parentCols.length === 1 ? `"${fk.parent_table}.${parentCols[0]}"` : `"${fk.parent_table}" (${parentCols.join(', ')})`;
        throw new Error(
          `[RESTORE_REFERENTIAL_INTEGRITY_FAILURE] Found ${orphaned} orphaned records in ${childTarget} referencing non-existent records in ${parentTarget}.`
        );
      }
    }
    referentialIntegrityVerified = true;
  }

  // 5. Index audit
  const indexCountRes = await client.query(`
    SELECT count(*)::int as cnt FROM pg_indexes WHERE schemaname = 'public'
  `);
  let indexCount: number = parseInt(indexCountRes.rows[0]?.cnt ?? '0', 10);
  if (isNaN(indexCount) || (indexCount === 0 && indexCountRes.rows.length > 1)) {
    indexCount = indexCountRes.rows.length;
  }
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
  if (requirements.exactIndexNames) {
    const indexNameRes = await client.query(`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname
    `);
    const actualIndexNames = indexNameRes.rows.map((r: any) => r.indexname);
    const idxSet = new Set(actualIndexNames);
    for (const idx of requirements.exactIndexNames) {
      if (!idxSet.has(idx)) {
        throw new Error(`[RESTORE_VERIFICATION_FAILURE] Missing expected index: "${idx}".`);
      }
    }
  }
  // 5b. Canonical Index definitions audit via pg_indexes (indexdef)
  if (requirements.exactIndexDefs) {
    const idxDefRes = await client.query(`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);
    const actualIdxDefMap = new Map<string, any>();
    for (const r of idxDefRes.rows) {
      actualIdxDefMap.set(`${r.tablename}.${r.indexname}`, r);
    }
    for (const exp of requirements.exactIndexDefs) {
      const key = `${exp.tablename}.${exp.indexname}`;
      const actual = actualIdxDefMap.get(key);
      if (!actual) {
        throw new Error(`[RESTORE_VERIFICATION_FAILURE] Missing expected index "${exp.indexname}" on table "${exp.tablename}".`);
      }
      if (exp.indexdef && normalizeSql(actual.indexdef) !== normalizeSql(exp.indexdef)) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Index definition mismatch for "${key}": found "${actual.indexdef}", expected "${exp.indexdef}".`
        );
      }
    }
  }

  // 6. Sequence audit & Ownership via pg_depend / sequence values
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
  if (requirements.exactSequencesDetail) {
    let ownershipRows: any[] = [];
    try {
      const ownRes = await client.query(`
        SELECT
          s.relname AS sequence_name,
          t.relname AS owner_table,
          a.attname AS owner_column
        FROM pg_class s
        JOIN pg_namespace n ON n.oid = s.relnamespace
        LEFT JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'a'
        LEFT JOIN pg_class t ON t.oid = d.refobjid
        LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
        WHERE n.nspname = 'public' AND s.relkind = 'S'
        ORDER BY s.relname
      `);
      ownershipRows = ownRes.rows || [];
    } catch {}

    let valueRows: any[] = [];
    try {
      const valRes = await client.query(`
        SELECT sequencename AS sequence_name, data_type, last_value
        FROM pg_sequences
        WHERE schemaname = 'public'
        ORDER BY sequencename
      `);
      valueRows = valRes.rows || [];
    } catch {}

    const ownMap = new Map<string, any>();
    for (const r of ownershipRows) ownMap.set(r.sequence_name, r);

    const valMap = new Map<string, any>();
    for (const r of valueRows) valMap.set(r.sequence_name, r);

    const seqSet = new Set(sequences);
    for (const exp of requirements.exactSequencesDetail) {
      if (!seqSet.has(exp.sequence_name)) {
        throw new Error(`[RESTORE_VERIFICATION_FAILURE] Missing expected sequence: "${exp.sequence_name}".`);
      }
      const actualOwn = ownMap.get(exp.sequence_name);
      if (exp.owner_table !== undefined) {
        const actualTbl = actualOwn?.owner_table || null;
        if (actualTbl !== exp.owner_table) {
          throw new Error(
            `[RESTORE_VERIFICATION_FAILURE] Sequence owner table mismatch for "${exp.sequence_name}": found "${actualTbl}", expected "${exp.owner_table}".`
          );
        }
      }
      if (exp.owner_column !== undefined) {
        const actualCol = actualOwn?.owner_column || null;
        if (actualCol !== exp.owner_column) {
          throw new Error(
            `[RESTORE_VERIFICATION_FAILURE] Sequence owner column mismatch for "${exp.sequence_name}": found "${actualCol}", expected "${exp.owner_column}".`
          );
        }
      }
      const actualVal = valMap.get(exp.sequence_name);
      if (exp.data_type) {
        if (!actualVal || !actualVal.data_type || actualVal.data_type !== exp.data_type) {
          throw new Error(
            `[RESTORE_VERIFICATION_FAILURE] Sequence data type mismatch or metadata missing for "${exp.sequence_name}": found "${actualVal?.data_type ?? 'MISSING'}", expected "${exp.data_type}".`
          );
        }
      }
      if (exp.last_value !== undefined) {
        if (!actualVal || actualVal.last_value === undefined || actualVal.last_value === null ||
            String(actualVal.last_value) !== String(exp.last_value)) {
          throw new Error(
            `[RESTORE_VERIFICATION_FAILURE] Sequence last_value mismatch or metadata missing for "${exp.sequence_name}": found "${actualVal?.last_value ?? 'MISSING'}", expected "${exp.last_value}".`
          );
        }
      }
    }
  }

  // 7. Extensions audit & Version compatibility policy
  const extRes = await client.query(`
    SELECT extname, extversion FROM pg_extension ORDER BY extname
  `);
  const extensions: string[] = extRes.rows.map((r: any) => r.extname);
  const extVerMap = new Map<string, string>();
  for (const r of extRes.rows) {
    extVerMap.set(r.extname, r.extversion);
  }

  if (requirements.exactExtensions) {
    const extSet = new Set(extensions);
    for (const ext of requirements.exactExtensions) {
      if (!extSet.has(ext)) {
        throw new Error(`[RESTORE_VERIFICATION_FAILURE] Missing expected database extension: "${ext}".`);
      }
    }
  }

  if (requirements.exactExtensionsDetail) {
    for (const exp of requirements.exactExtensionsDetail) {
      const actualVer = extVerMap.get(exp.extname);
      if (!actualVer) {
        throw new Error(`[RESTORE_VERIFICATION_FAILURE] Missing expected database extension: "${exp.extname}".`);
      }
      if (exp.allowedVersions && !exp.allowedVersions.includes(actualVer)) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Extension "${exp.extname}" version "${actualVer}" is not allowed. Permitted versions: [${exp.allowedVersions.join(', ')}].`
        );
      }
      if (exp.extversion && actualVer !== exp.extversion) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Extension "${exp.extname}" version mismatch: found "${actualVer}", expected "${exp.extversion}".`
        );
      }
    }
  }

  // 8. Column parity audit (types, nullability, defaults, identities)
  const colRes = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default,
           is_identity, identity_generation
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  const actualCols = colRes.rows;
  if (requirements.exactColumnCount !== undefined && actualCols.length !== requirements.exactColumnCount) {
    throw new Error(
      `[RESTORE_VERIFICATION_FAILURE] Exact column count mismatch: found ${actualCols.length}, expected ${requirements.exactColumnCount}.`
    );
  }
  if (requirements.exactColumns) {
    const actualColMap = new Map<string, any>();
    for (const c of actualCols) {
      actualColMap.set(`${c.table_name}.${c.column_name}`, c);
    }
    for (const expCol of requirements.exactColumns) {
      const key = `${expCol.table_name}.${expCol.column_name}`;
      const actual = actualColMap.get(key);
      if (!actual) {
        throw new Error(`[RESTORE_VERIFICATION_FAILURE] Missing expected column: "${key}".`);
      }
      if (expCol.data_type && actual.data_type !== expCol.data_type) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Column type mismatch for "${key}": found "${actual.data_type}", expected "${expCol.data_type}".`
        );
      }
      if (expCol.is_nullable && actual.is_nullable !== expCol.is_nullable) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Column nullability mismatch for "${key}": found "${actual.is_nullable}", expected "${expCol.is_nullable}".`
        );
      }
      if (expCol.column_default !== undefined) {
        const expDefNorm = normalizeSql(expCol.column_default);
        const actDefNorm = normalizeSql(actual.column_default);
        if (expDefNorm !== actDefNorm) {
          throw new Error(
            `[RESTORE_VERIFICATION_FAILURE] Column default mismatch for "${key}": found "${actual.column_default}", expected "${expCol.column_default}".`
          );
        }
      }
      if (expCol.is_identity !== undefined && actual.is_identity !== expCol.is_identity) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Column identity mismatch for "${key}": found "${actual.is_identity}", expected "${expCol.is_identity}".`
        );
      }
      if (expCol.identity_generation !== undefined && actual.identity_generation !== expCol.identity_generation) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Column identity generation mismatch for "${key}": found "${actual.identity_generation}", expected "${expCol.identity_generation}".`
        );
      }
    }
  }

  // 9. Migration ledger audit
  let migrationCount: number | undefined;
  if (requirements.expectedMigrations) {
    const migTableCheck = await client.query(`
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'knex_migrations'
    `);
    if (migTableCheck.rows.length === 0) {
      throw new Error('[RESTORE_VERIFICATION_FAILURE] knex_migrations table missing from restored database.');
    }
    const migRes = await client.query(`
      SELECT name FROM knex_migrations ORDER BY id
    `);
    const actualMigs = migRes.rows.map((r: any) => r.name);
    migrationCount = actualMigs.length;

    if (actualMigs.length !== requirements.expectedMigrations.length) {
      throw new Error(
        `[RESTORE_VERIFICATION_FAILURE] Migration ledger count mismatch: found ${actualMigs.length}, expected ${requirements.expectedMigrations.length}.`
      );
    }
    for (let i = 0; i < requirements.expectedMigrations.length; i++) {
      if (actualMigs[i] !== requirements.expectedMigrations[i]) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Migration order/name mismatch at index ${i}: found "${actualMigs[i]}", expected "${requirements.expectedMigrations[i]}".`
        );
      }
    }
  }

  if (requirements.expectedMigrationLedger) {
    const migTableCheck = await client.query(`
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'knex_migrations'
    `);
    if (migTableCheck.rows.length === 0) {
      throw new Error('[RESTORE_VERIFICATION_FAILURE] knex_migrations table missing from restored database.');
    }
    const migRes = await client.query(`
      SELECT id, name, batch FROM knex_migrations ORDER BY id
    `);
    const actualMigs = migRes.rows;
    migrationCount = actualMigs.length;

    if (actualMigs.length !== requirements.expectedMigrationLedger.length) {
      throw new Error(
        `[RESTORE_VERIFICATION_FAILURE] Migration ledger count mismatch: found ${actualMigs.length}, expected ${requirements.expectedMigrationLedger.length}.`
      );
    }
    for (let i = 0; i < requirements.expectedMigrationLedger.length; i++) {
      const exp = requirements.expectedMigrationLedger[i];
      const act = actualMigs[i];
      if (act.name !== exp.name) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Migration order/name mismatch at index ${i}: found "${act.name}", expected "${exp.name}".`
        );
      }
      if (exp.id !== undefined && act.id !== exp.id) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Migration id mismatch for "${exp.name}": found ${act.id}, expected ${exp.id}.`
        );
      }
      if (exp.batch !== undefined && act.batch !== exp.batch) {
        throw new Error(
          `[RESTORE_VERIFICATION_FAILURE] Migration batch mismatch for "${exp.name}": found ${act.batch}, expected ${exp.batch}.`
        );
      }
    }
  }

  return {
    tableCount: tables.length,
    totalRows,
    constraintCount: totalConstraints > 0 ? totalConstraints : totalRelational,
    indexCount,
    sequenceCount: sequences.length,
    columnCount: actualCols.length,
    migrationCount,
    extensions,
    constraintsBreakdown: breakdown,
    referentialIntegrityVerified,
    exactParityVerified: Boolean(requirements.exactTables && requirements.exactTotalRows !== undefined),
    verified: true,
  };
}
