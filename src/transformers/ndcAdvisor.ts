import { CompanyRow } from '../db/companymaster';
import { odgGet } from '../upstream/odgClient';
import { OdgNdcResponse, OdgNdcInfo, OdgPbsResponse, OdgPbsInfo } from '../types/odg';
import { LegacyNdcRecord, LegacyPbsRecord } from '../types/legacy';
import { tildeList, normalizeNdc, isNumeric, isoToLegacyDate } from '../parsers/queryParams';
import { LegacyError, ERRORS } from '../errors/legacyErrors';

// ─── Request parsing ──────────────────────────────────────────────────────────

export interface NdcAdvisorParams {
  ndc: string;
  country?: string;
  output?: string;
  clientid?: string;
}

export interface NdcAdvisorContext {
  codes: string[];       // tilde-split ndc values
  country: string;       // 'AU' or 'US'
  fullOutput: boolean;   // output=F
  clientid?: string;
  isKeyword: boolean;    // at least one code is alphabetic → keyword search
}

export function parseNdcAdvisorParams(query: Record<string, string | string[] | undefined>): NdcAdvisorContext {
  const ndc = typeof query.ndc === 'string' ? query.ndc : '';
  if (!ndc || ndc.trim() === '') {
    throw new LegacyError(ERRORS.INVALID_FORMAT());
  }
  if (ndc.trim().toLowerCase() === 'all') {
    throw new LegacyError(ERRORS.INVALID_FORMAT());
  }

  const codes = tildeList(ndc);
  if (codes.length === 0) {
    throw new LegacyError(ERRORS.INVALID_FORMAT());
  }

  const country = (typeof query.country === 'string' ? query.country : '').toUpperCase();
  const fullOutput = (typeof query.output === 'string' ? query.output : '').toUpperCase() === 'F';
  const clientid = typeof query.clientid === 'string' ? query.clientid : undefined;

  const isKeyword = codes.some((c) => !isNumeric(c));

  return { codes, country, fullOutput, clientid, isKeyword };
}

// ─── Upstream calls ───────────────────────────────────────────────────────────

async function fetchUsNdc(
  company: CompanyRow,
  ctx: NdcAdvisorContext,
): Promise<OdgNdcInfo[]> {
  if (ctx.isKeyword) {
    // Alphabetic → keyword search
    const keyword = ctx.codes.join(' ');
    const data = await odgGet<OdgNdcResponse>(company, '/formulary/ndc', { keyword });
    return data.ndcInformation ?? [];
  }

  if (ctx.codes.length === 1) {
    // Single numeric code → /formulary/ndc/{ndcCode}
    const code = normalizeNdc(ctx.codes[0]);
    const data = await odgGet<OdgNdcResponse>(company, `/formulary/ndc/${code}`);
    return data.ndcInformation ?? [];
  }

  // Multiple numeric codes → /formulary/ndc?ndc=<each>
  const normalized = ctx.codes.map(normalizeNdc).filter((c) => c.length > 0);
  const data = await odgGet<OdgNdcResponse>(company, '/formulary/ndc', { ndc: normalized });
  return data.ndcInformation ?? [];
}

async function fetchAuPbs(
  company: CompanyRow,
  ctx: NdcAdvisorContext,
): Promise<OdgPbsInfo[]> {
  if (ctx.isKeyword) {
    const keyword = ctx.codes.join(' ');
    const data = await odgGet<OdgPbsResponse>(company, '/formulary/pbs', { keyword });
    return data.pbsInformation ?? [];
  }

  if (ctx.codes.length === 1) {
    const data = await odgGet<OdgPbsResponse>(company, `/formulary/pbs/${ctx.codes[0]}`);
    return data.pbsInformation ?? [];
  }

  const data = await odgGet<OdgPbsResponse>(company, '/formulary/pbs', { pbs: ctx.codes });
  return data.pbsInformation ?? [];
}

// ─── Response transformation ──────────────────────────────────────────────────

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

function mapPbsInfo(info: OdgPbsInfo): LegacyPbsRecord {
  return {
    pbsCode: info.pbsCode ?? '',
    brandName: info.brandName ?? '',
    atcCode: info.atcCode ?? '',
    manufacCode: info.manufacCode ?? '',
    drugMPName: info.drugMpName ?? '',
    amtMppReferredTerm: info.amtMppPreferredTerm ?? '',
    // TODO/confirm: drugClass, odgGenericName, odgGenericEquiv, odgStatus not top-level in Swagger PbsInfo
    drugClass: null,
    odgGenericName: null,
    odgGenericEquiv: null,
    odgStatus: null,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export interface NdcAdvisorResult {
  /** Single record or array of records */
  records: LegacyNdcRecord[] | LegacyPbsRecord[];
  clientid?: string;
}

export async function handleNdcAdvisor(
  company: CompanyRow,
  ctx: NdcAdvisorContext,
): Promise<NdcAdvisorResult> {
  // NOTE: output=F (fullOutput) requests procsummary, but Procedure Summary is EOL.
  // TODO/confirm: approve whether to omit procsummary, reject, or source it elsewhere.
  // For now: fullOutput is accepted but procsummary is not added to the response.

  if (ctx.country === 'AU') {
    const items = await fetchAuPbs(company, ctx);
    if (items.length === 0) {
      throw new LegacyError(ERRORS.NO_RESULTS('PBS codes'));
    }
    return { records: items.map(mapPbsInfo), clientid: ctx.clientid };
  }

  const items = await fetchUsNdc(company, ctx);
  if (items.length === 0) {
    const noResultMsg = ctx.codes.length === 1 ? 'Drug Codes' : 'NDC codes';
    throw new LegacyError(ERRORS.NO_RESULTS(noResultMsg));
  }
  return { records: items.map(mapNdcInfo), clientid: ctx.clientid };
}

/**
 * Builds the final legacy response model from the result.
 * Applies single-vs-array rule: 1 record → unwrap; >1 → keep array.
 * Appends clientid (if present) and rescount.
 */
export function buildNdcAdvisorModel(result: NdcAdvisorResult): Record<string, unknown> {
  const { records, clientid } = result;
  const count = records.length;

  let base: Record<string, unknown>;
  if (count === 1) {
    base = { ...(records[0] as unknown as Record<string, unknown>) };
  } else {
    base = { ndc: records as unknown[] };
  }

  if (clientid) base.clientid = clientid;
  base.rescount = count;

  return base;
}
