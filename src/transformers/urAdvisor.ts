import { CompanyRow } from '../db/companymaster';
import { SubscriptionRow } from '../db/companywebservice';
import { odgGet } from '../upstream/odgClient';
import { OdgTaoResponse, OdgTaoProcedure, OdgTaoItemGroup, OdgTaoProceduresResponse } from '../types/odg';
import { LegacyCptRecord, LegacyIcdRecord, LegacyUraRecord } from '../types/legacy';
import { tildeList, padFnol } from '../parsers/queryParams';
import { LegacyError, ERRORS } from '../errors/legacyErrors';

// ─── Request parsing ──────────────────────────────────────────────────────────

export interface UraContext {
  icds: string[];          // ICD codes (may be literal '9' or '10' for lookup-by-cpt)
  cpts: string[];          // US CPT codes
  procs: string[];         // AU procedure codes
  country: string;         // 'AU' or 'US'
  flags: string;           // 'R', 'G', 'Y', 'B' combinations
  bp?: string;             // FNOL body-part, zero-padded
  noi?: string;            // FNOL nature-of-injury, zero-padded
  fullOutput: boolean;     // outputMode=F from subscription or query
  clientid?: string;
  icdLookupMode?: '9' | '10'; // when icd param is literal '9' or '10'
}

export function parseUraParams(
  query: Record<string, string | string[] | undefined>,
  subscription: SubscriptionRow,
): UraContext {
  const icdRaw = typeof query.icd === 'string' ? query.icd : '';
  const cptRaw = typeof query.cpt === 'string' ? query.cpt : '';
  const procRaw = typeof query.proc === 'string' ? query.proc : '';
  const country = (typeof query.country === 'string' ? query.country : '').toUpperCase();
  const flags = typeof query.flags === 'string' ? query.flags : '';
  const bp = typeof query.bp === 'string' ? padFnol(query.bp) : undefined;
  const noi = typeof query.noi === 'string' ? padFnol(query.noi) : undefined;
  const clientid = typeof query.clientid === 'string' ? query.clientid : undefined;

  // Subscription outputMode overrides individual query param
  const fullOutput = subscription.outputMode === 'F';

  // icd=9 or icd=10 means: look up ICDs for a given CPT/procedure
  let icdLookupMode: '9' | '10' | undefined;
  let icds: string[] = [];

  if (icdRaw === '9' || icdRaw === '10') {
    icdLookupMode = icdRaw as '9' | '10';
  } else {
    icds = tildeList(icdRaw);
  }

  const cpts = tildeList(cptRaw);
  const procs = tildeList(procRaw);

  // Validation: must have icds, or FNOL (bp+noi), or icdLookupMode with cpt/proc
  const hasFnol = !!(bp && noi);
  const hasIcdLookup = !!icdLookupMode;
  const hasIcds = icds.length > 0;
  const hasCpts = country === 'AU' ? procs.length > 0 : cpts.length > 0;

  if (!hasIcds && !hasFnol && !hasIcdLookup) {
    throw new LegacyError(ERRORS.INVALID_FORMAT());
  }

  if (hasIcdLookup && !hasCpts) {
    throw new LegacyError(ERRORS.INVALID_FORMAT());
  }

  return { icds, cpts, procs, country, flags, bp, noi, fullOutput, clientid, icdLookupMode };
}

// ─── Upstream calls ───────────────────────────────────────────────────────────

export interface FnolIcdResult {
  icds: string[];
}

/**
 * Resolves FNOL bp/noi codes to ICD codes via /tao/fnol/{bp}/{noi}.
 * TODO/confirm: confirm whether the direct FNOL response replaces the
 * ICD-derived flow or just returns candidate ICD codes.
 */
async function resolveFnol(
  company: CompanyRow,
  bp: string,
  noi: string,
): Promise<string[]> {
  // TODO/confirm: FNOL endpoint response schema not confirmed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await odgGet<any>(company, `/tao/fnol/${bp}/${noi}`);
  // Attempt to extract ICD codes from response; shape unconfirmed
  const candidates: string[] =
    Array.isArray(data?.icds) ? data.icds : [];
  if (candidates.length === 0) {
    throw new LegacyError(ERRORS.INVALID_FNOL());
  }
  return candidates;
}

async function fetchTaoIcds(
  company: CompanyRow,
  ctx: UraContext,
  icds: string[],
): Promise<OdgTaoResponse> {
  const params: Record<string, string | string[] | undefined> = {
    icd: icds,
    Country: ctx.country || 'US',
    ...(ctx.fullOutput && { FullOutput: '1' }),
  };
  if (ctx.country !== 'AU' && ctx.cpts.length > 0) {
    params.proc = ctx.cpts;
  } else if (ctx.country === 'AU' && ctx.procs.length > 0) {
    params.proc = ctx.procs;
  }
  if (ctx.flags) params.Flags = ctx.flags.split('');
  if (ctx.clientid) params.ClientId = ctx.clientid;

  return odgGet<OdgTaoResponse>(company, '/tao/icds', params);
}

async function fetchTaoProcedures(
  company: CompanyRow,
  ctx: UraContext,
): Promise<OdgTaoProceduresResponse> {
  const params: Record<string, string | string[] | undefined> = {
    proc: ctx.country === 'AU' ? ctx.procs : ctx.cpts,
    Country: ctx.country || 'US',
    resulttype: ctx.icdLookupMode === '9' ? '1' : '2',
    ...(ctx.fullOutput && { FullOutput: '1' }),
  };
  if (ctx.flags) params.Flags = ctx.flags.split('');
  if (ctx.clientid) params.ClientId = ctx.clientid;

  return odgGet<OdgTaoProceduresResponse>(company, '/tao/procedures', params);
}

// ─── Response transformation ──────────────────────────────────────────────────

function n(val: number | undefined): string | null {
  return val != null ? String(val) : null;
}

function n2(val: number | undefined): string | null {
  return val != null ? val.toFixed(2) : null;
}

function mapTaoProcedure(proc: OdgTaoProcedure, fullOutput: boolean, country: string): LegacyCptRecord {
  const rec: LegacyCptRecord = {
    code: proc.code ?? '',
    name: proc.name ?? '',
    incidencerate: n(proc.incidenceRate),
    cptfrequency: n(proc.procedureFrequency),
    visit25: n(proc.visit25),
    visit50: n(proc.visit50),
    visit75: n(proc.visit75),
    visitmean: n(proc.visitMean),
    costmean: n(proc.costMean),
    odgcaa: n(proc.odgCAA),
    paymentflag: proc.paymentFlag ?? null,
    costpervisit: n(proc.costPerVisit),
  };

  if (fullOutput) {
    rec.proctype = proc.procedureType ?? null;
    rec.taoindex = n(proc.taoIndex);
    if (country !== 'AU') {
      rec.avglostdays = n(proc.averageLostDays);
      rec.medianlostdays = n2(proc.medianLostDays);
      rec.pctneverreturn = n(proc.percentNeverReturn);
      rec.pctzerodays = n(proc.percentZeroDays);
    }
  }

  return rec;
}

/**
 * Transforms an ODG TAO JSON response into the legacy grouped structure.
 * The API returns items[] where each entry contains icd and procedures[].
 */
function buildUraRecords(
  data: OdgTaoResponse,
  ctx: UraContext,
): LegacyUraRecord[] {
  const groups: OdgTaoItemGroup[] = data.items ?? [];
  const fullOutput = ctx.fullOutput;

  return groups.map((group) => ({
    icd: group.icd
      ? { code: group.icd.code ?? '', name: group.icd.name ?? '' }
      : undefined,
    cpt: (group.procedures ?? []).map((p) => mapTaoProcedure(p, fullOutput, ctx.country)),
  }));
}

/**
 * Maps an ICD child record from /tao/procedures response.
 * Frequency field is named icdfrequency in legacy output (not cptfrequency).
 */
function mapTaoIcdChild(icd: OdgTaoProcedure, fullOutput: boolean, country: string): LegacyIcdRecord {
  const rec: LegacyIcdRecord = {
    code: icd.code ?? '',
    name: icd.name ?? '',
    incidencerate: n(icd.incidenceRate),
    icdfrequency: n(icd.procedureFrequency),
    visit25: n(icd.visit25),
    visit50: n(icd.visit50),
    visit75: n(icd.visit75),
    visitmean: n(icd.visitMean),
    costmean: n(icd.costMean),
    odgcaa: n(icd.odgCAA),
    paymentflag: icd.paymentFlag ?? null,
    costpervisit: n(icd.costPerVisit),
  };

  if (fullOutput) {
    rec.proctype = icd.procedureType ?? null;
    rec.taoindex = n(icd.taoIndex);
    if (country !== 'AU') {
      rec.avglostdays = n(icd.averageLostDays);
      rec.medianlostdays = n(icd.medianLostDays);
      rec.pctneverreturn = n(icd.percentNeverReturn);
      rec.pctzerodays = n(icd.percentZeroDays);
    }
  }

  return rec;
}

/**
 * Transforms a /tao/procedures response into legacy records.
 * Each item has a procedure parent and ICD children with stats.
 */
function buildUraProcedureRecords(
  data: OdgTaoProceduresResponse,
  ctx: UraContext,
): LegacyUraRecord[] {
  const items = data.items ?? [];
  const fullOutput = ctx.fullOutput;

  return items.map((item) => ({
    cptInfo: item.procedure
      ? { code: item.procedure.code ?? '', name: item.procedure.name ?? '' }
      : undefined,
    icdStats: (item.icds ?? []).map((icd) => mapTaoIcdChild(icd, fullOutput, ctx.country)),
  }));
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export interface UraResult {
  records: LegacyUraRecord[];
  clientid?: string;
}

export async function handleUrAdvisor(
  company: CompanyRow,
  ctx: UraContext,
): Promise<UraResult> {
  let icds = ctx.icds;

  // Resolve FNOL to ICDs if needed
  if (icds.length === 0 && ctx.bp && ctx.noi) {
    icds = await resolveFnol(company, ctx.bp, ctx.noi);
  }

  let records: LegacyUraRecord[];

  if (ctx.icdLookupMode) {
    // icd=9|10: reverse lookup — procedure → ICDs
    const data = await fetchTaoProcedures(company, ctx);
    records = buildUraProcedureRecords(data, ctx);
  } else {
    const data = await fetchTaoIcds(company, ctx, icds);
    records = buildUraRecords(data, ctx);
  }

  const hasResults = records.some(
    (r) =>
      (r.cpt && r.cpt.length > 0) ||
      (r.proc && r.proc.length > 0) ||
      (r.icdStats && r.icdStats.length > 0),
  );

  if (!hasResults) {
    const noResultsMsg = ctx.icdLookupMode
      ? 'ICD/Treatment code'
      : 'ICD code';
    throw new LegacyError(ERRORS.NO_RESULTS(noResultsMsg));
  }

  return { records, clientid: ctx.clientid };
}

export function buildUraModel(result: UraResult): Record<string, unknown> {
  const { records, clientid } = result;

  // Each ICD group becomes an <item>; each procedure inside <cpt> also
  // becomes an <item>. fast-xml-parser serializes arrays as repeated sibling
  // elements with the same tag name.
  const items = records.map((rec) => {
    if (rec.cptInfo) {
      // Reverse lookup: cpt is single parent object, icd is array of children
      return {
        cpt: rec.cptInfo,
        icd: rec.icdStats && rec.icdStats.length > 0 ? { item: rec.icdStats } : undefined,
      };
    }
    return {
      icd: rec.icd,
      cpt: rec.cpt && rec.cpt.length > 0 ? { item: rec.cpt } : undefined,
    };
  });

  const base: Record<string, unknown> = {
    item: items.length === 1 ? items[0] : items,
  };

  if (clientid) {
    base.clientid = clientid;
    base.rescount = records.length;
  }

  return base;
}
