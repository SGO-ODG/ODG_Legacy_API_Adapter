import { getDb } from './sqlite';

export interface SubscriptionRow {
  id: number;
  companyCode: string;
  webserviceCode: string;
  subscriptionStartDate: string; // YYYY-MM-DD stored as text
  subscriptionEndDate: string;   // YYYY-MM-DD stored as text
  outputMode: string;            // 'F' = full, 'S' = streamlined
}

const SQL = `
  SELECT id, companyCode, webserviceCode,
         subscriptionStartDate, subscriptionEndDate, outputMode
  FROM   companywebservice
  WHERE  companyCode    = ?
  AND    webserviceCode = ?
  LIMIT  1
`;

/**
 * Look up the subscription for a company + service code pair.
 * Returns undefined when no record exists.
 */
export function findSubscription(
  companyCode: string,
  webserviceCode: string,
): SubscriptionRow | undefined {
  return getDb()
    .prepare<[string, string], SubscriptionRow>(SQL)
    .get(companyCode, webserviceCode);
}
