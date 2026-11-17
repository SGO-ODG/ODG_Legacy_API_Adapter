import { DbRunner, defaultRunner } from './queryRunner';

export interface SubscriptionRow {
  id: number;
  companyCode: string;
  webserviceCode: string;
  subscriptionStartDate: string; // YYYY-MM-DD returned as string by pg for DATE columns
  subscriptionEndDate: string;   // YYYY-MM-DD returned as string by pg for DATE columns
  outputMode: string;            // 'F' = full, 'S' = streamlined
}

const SQL = `
  SELECT id, companyCode, webserviceCode,
         subscriptionStartDate, subscriptionEndDate, outputMode
  FROM   companywebservice
  WHERE  companyCode    = $1
  AND    webserviceCode = $2
  LIMIT  1
`;

/**
 * Look up the subscription for a company + service code pair.
 * Returns undefined when no record exists.
 *
 * @param runner  Injected for tests; defaults to the production PostgreSQL runner.
 */
export async function findSubscription(
  companyCode: string,
  webserviceCode: string,
  runner: DbRunner = defaultRunner,
): Promise<SubscriptionRow | undefined> {
  return runner.queryOne<SubscriptionRow>(SQL, [companyCode, webserviceCode]);
}
