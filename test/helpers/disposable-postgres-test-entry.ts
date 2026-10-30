export interface DisposablePostgresTestEnvironment {
  NODE_ENV?: string;
  CI_DISPOSABLE_DATABASE?: string;
  DATABASE_URL?: string;
  ISOLATED_TEST_DATABASE_URL?: string;
  CI_EXPECTED_DATABASE_USER?: string;
  CI_EXPECTED_DATABASE_NAME?: string;
  CI_EXPECTED_POSTGRES_ADDRESSES?: string;
  [name: string]: string | undefined;
}

export interface DisposablePostgresTestEntryOptions<T> {
  env?: DisposablePostgresTestEnvironment;
  preflight: () => void | Promise<void>;
  run: () => T | Promise<T>;
}

const contractError =
  'PostgreSQL workflow tests require the matching identity-verified, run-scoped disposable database contract.';

/**
 * A pure guard: do not import the DB package or execute any preflight/connection
 * code until all explicit disposable-test identity variables are present.
 * The full endpoint, DNS, and connected-server identity checks remain in
 * scripts/ci/assert-disposable-postgres.mjs.
 */
export function assertDisposablePostgresTestContract(
  env: DisposablePostgresTestEnvironment = process.env
): void {
  if (
    env.NODE_ENV !== 'test' ||
    env.CI_DISPOSABLE_DATABASE !== 'true' ||
    !env.DATABASE_URL ||
    env.DATABASE_URL !== env.ISOLATED_TEST_DATABASE_URL ||
    !env.CI_EXPECTED_DATABASE_USER ||
    !/^aira_ci_[0-9]+-[0-9]+$/.test(env.CI_EXPECTED_DATABASE_USER) ||
    !env.CI_EXPECTED_DATABASE_NAME ||
    !/^aira_ci_[0-9]+-[0-9]+$/.test(env.CI_EXPECTED_DATABASE_NAME) ||
    !env.CI_EXPECTED_POSTGRES_ADDRESSES
  ) {
    throw new Error(contractError);
  }

  let expectedAddresses: unknown;
  try {
    expectedAddresses = JSON.parse(env.CI_EXPECTED_POSTGRES_ADDRESSES);
  } catch {
    throw new Error(contractError);
  }
  if (!Array.isArray(expectedAddresses) || expectedAddresses.length === 0) {
    throw new Error(contractError);
  }
}

/** Validate first, then verify the actual server, then and only then run DB code. */
export async function runWithDisposablePostgresTestContract<T>({
  env = process.env,
  preflight,
  run
}: DisposablePostgresTestEntryOptions<T>): Promise<T> {
  assertDisposablePostgresTestContract(env);
  await preflight();
  return await run();
}