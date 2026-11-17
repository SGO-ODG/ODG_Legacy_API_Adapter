import { odgGet } from '../upstream/odgClient';
import { OdgNdcResponse, OdgNdcInfo } from '../types/odg';
import { LegacyNdcRecord } from '../types/legacy';
import { isoToLegacyDate } from '../parsers/queryParams';

// TODO/confirm: confirm upstream maximum pageSize and ordering guarantee.
// Using 100 as a conservative default until confirmed.
const PAGE_SIZE = 100;

function mapNdcInfo(info: OdgNdcInfo): LegacyNdcRecord {
  return {
    ndcCode: info.odgNdcCode ?? info.productNdc ?? '',
    brandName: info.proprietaryName ?? '',
    genericName: info.nonProprietaryName ?? '',
    tradeName: info.tradeName ?? '',
    drugClass: info.pharmClasses ?? '',
    // TODO/confirm: GE and status mapping from formularyInformation not confirmed
    GE: null,
    status: null,
    strength: info.strength ?? '',
    effectiveDate: info.effectiveDate ? isoToLegacyDate(info.effectiveDate) : '',
  };
}

/**
 * Fetches all NDC records by paging through /formulary/ndc until
 * totalRecords are collected.
 */
export async function fetchAllNdcRecords(): Promise<LegacyNdcRecord[]> {
  const records: LegacyNdcRecord[] = [];
  let page = 1;

  // Fetch first page to discover totalRecords
  const first = await odgGet<OdgNdcResponse>('/formulary/ndc', {
    page: 1,
    pageSize: PAGE_SIZE,
  });

  const total = first.totalRecords ?? 0;
  const infos = first.ndcInformation ?? [];
  records.push(...infos.map(mapNdcInfo));

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Fetch remaining pages
  for (page = 2; page <= totalPages; page++) {
    const resp = await odgGet<OdgNdcResponse>('/formulary/ndc', {
      page,
      pageSize: PAGE_SIZE,
    });
    const pageInfos = resp.ndcInformation ?? [];
    records.push(...pageInfos.map(mapNdcInfo));
  }

  return records;
}

/**
 * Serializes the record array as CSV using the legacy NDC Download field order.
 * Header row matches legacy field names.
 */
export function serializeNdcDownloadCsv(records: LegacyNdcRecord[]): string {
  const HEADERS = [
    'ndcCode', 'brandName', 'genericName', 'tradeName',
    'drugClass', 'GE', 'status', 'strength', 'effectiveDate',
  ] as const;

  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const rows = [
    HEADERS.join(','),
    ...records.map((r) =>
      HEADERS.map((h) => escape(r[h])).join(','),
    ),
  ];

  return rows.join('\r\n');
}
