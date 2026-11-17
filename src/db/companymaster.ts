import { DbRunner, defaultRunner } from './queryRunner';

export interface CompanyRow {
  companyCode: string;
  companyName: string;
  webserviceKey: string;
  disabled: string;
}

const SQL = `
  SELECT companyCode, companyName, webserviceKey, disabled
  FROM   companymaster
  WHERE  webserviceKey = $1
  LIMIT  1
`;

/**
 * Look up a company by its legacy API key.
 * Returns undefined when no match is found.
 * Never logs the key.
 *
 * @param runner  Injected for tests; defaults to the production PostgreSQL runner.
 */
export async function findByKey(
  key: string,
  runner: DbRunner = defaultRunner,
): Promise<CompanyRow | undefined> {
  return runner.queryOne<CompanyRow>(SQL, [key]);
}
