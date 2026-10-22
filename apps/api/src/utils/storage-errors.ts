/**
 * Classify transient database-connectivity failures without leaking driver details
 * to clients. Do not mistake input validation or ownership errors for outages.
 */
export function isTemporaryDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', '08001', '08006', '53300', '57P03'].includes(code)) {
    return true;
  }

  const message = typeof candidate.message === 'string' ? candidate.message : '';
  if (/Knex:\s*Timeout acquiring a connection|timeout exceeded when trying to connect|connection terminated unexpectedly|the database system is starting up/i.test(message)) {
    return true;
  }

  return candidate.cause && candidate.cause !== error
    ? isTemporaryDatabaseError(candidate.cause)
    : false;
}
