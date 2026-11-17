import { getPool } from './postgres';

export interface UsageLogEntry {
  companyCode: string;
  webserviceCode: string;
  clientHost: string;
  requestBody?: string | null;
  queryParameters?: string | null;
  clientId?: string | null;
  resultCode: string;
  contentType?: string | null;
  acceptHeader?: string | null;
  serverResponseTime?: number | null;
}

const SQL = `
  INSERT INTO webserviceusage
    (companyCode, webserviceCode, clientHost,
     requestBody, queryParameters, clientId,
     resultCode, contentType, acceptHeader, serverResponseTime)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
`;

/**
 * Inserts one row into webserviceusage.
 * Called fire-and-forget from the usage logger middleware — errors are caught
 * by the caller and printed to stderr so they never surface to the customer.
 */
export async function insertUsageLog(entry: UsageLogEntry): Promise<void> {
  await getPool().query(SQL, [
    entry.companyCode,
    entry.webserviceCode,
    entry.clientHost,
    entry.requestBody        ?? null,
    entry.queryParameters    ?? null,
    entry.clientId           ?? null,
    entry.resultCode,
    entry.contentType        ?? null,
    entry.acceptHeader       ?? null,
    entry.serverResponseTime ?? null,
  ]);
}
