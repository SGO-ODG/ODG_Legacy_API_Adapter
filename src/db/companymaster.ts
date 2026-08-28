import { getDb } from './sqlite';

export interface CompanyRow {
  companyCode: string;
  companyName: string;
  webserviceKey: string;
  disabled: string;
  odgapiClientId: string;
  odgapiClientSecret: string;
}

const SQL = `
  SELECT companyCode, companyName, webserviceKey, disabled,
         odgapiClientId, odgapiClientSecret
  FROM   companymaster
  WHERE  webserviceKey = ?
  LIMIT  1
`;

/**
 * Look up a company by its legacy API key.
 * Returns undefined when no match is found.
 * Never logs the key or secret.
 */
export function findByKey(key: string): CompanyRow | undefined {
  return getDb().prepare<[string], CompanyRow>(SQL).get(key);
}
