import { DbRunner, defaultRunner } from './queryRunner';

export interface SubscriptionRow {
  id: number;
  companyCode: string;
  webserviceCode: string;
  subscriptionStartDate: string; // YYYY-MM-DD stored as text
  subscriptionEndDate: string;   // YYYY-MM-DD stored as text
  outputMode: string;            // 'F' = full, 'S' = streamlined
}

/**
 * Named-param SQL — compatible with both better-sqlite3 and mssql (Azure SQL).
 * Switching to MSSQL requires only replacing the DbRunner implementation.
 */
const SQL = `
  SELECT id, companyCode, webserviceCode,
         subscriptionStartDate, subscriptionEndDate, outputMode
  FROM   companywebservice
  WHERE  companyCode    = @companyCode
  AND    webserviceCode = @webserviceCode
  LIMIT  1
`;

/**
 * Look up the subscription for a company + service code pair.
 * Returns undefined when no record exists.
 *
 * @param runner  Injected for tests; defaults to the production SQLite runner.
 */
export function findSubscription(
  companyCode: string,
  webserviceCode: string,
  runner: DbRunner = defaultRunner,
): SubscriptionRow | undefined {
  return runner.queryOne<SubscriptionRow>(SQL, { companyCode, webserviceCode });
}
