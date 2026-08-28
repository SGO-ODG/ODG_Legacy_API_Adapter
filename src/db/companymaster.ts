import { DbRunner, defaultRunner } from './queryRunner';

export interface CompanyRow {
  companyCode: string;
  companyName: string;
  webserviceKey: string;
  disabled: string;
  odgapiClientId: string;
  odgapiClientSecret: string;
}

/**
 * Named-param SQL — compatible with both better-sqlite3 and mssql (Azure SQL).
 * Switching to MSSQL requires only replacing the DbRunner implementation.
 */
const SQL = `
  SELECT companyCode, companyName, webserviceKey, disabled,
         odgapiClientId, odgapiClientSecret
  FROM   companymaster
  WHERE  webserviceKey = @webserviceKey
  LIMIT  1
`;

/**
 * Look up a company by its legacy API key.
 * Returns undefined when no match is found.
 * Never logs the key or secret.
 *
 * @param runner  Injected for tests; defaults to the production SQLite runner.
 */
export function findByKey(
  key: string,
  runner: DbRunner = defaultRunner,
): CompanyRow | undefined {
  return runner.queryOne<CompanyRow>(SQL, { webserviceKey: key });
}
