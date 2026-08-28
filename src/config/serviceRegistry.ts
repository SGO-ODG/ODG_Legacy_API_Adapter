/**
 * Static registry mapping legacy URL path segments to webserviceCodes.
 * Only the 7 migrated routes are listed here. EOL routes (procsum, sumguide)
 * are intentionally absent — they will never match and will produce a
 * SERVICE_NOT_EXIST error.
 */
export const SERVICE_REGISTRY: Record<string, string> = {
  ndcadvisor: 'NDCADVISOR',
  ndcdownload: 'NDCDOWNLOAD',
  uradvisor: 'URADVISOR',
  bpguide: 'BPGUIDE',
  onesearch: 'ONESEARCH',
  comorbidity: 'COMORBIDITY',
  reserve: 'RESERVE',
};

/** Returns the webserviceCode for a given path segment, or undefined. */
export function lookupServiceCode(segment: string): string | undefined {
  return SERVICE_REGISTRY[segment.toLowerCase()];
}
