import { z } from 'zod';
import { SubscriptionRow } from '../db/companywebservice';
import { odgGet, UpstreamError } from '../upstream/odgClient';
import { OdgTaoResponse, OdgTaoProcedure, OdgTaoItemGroup, OdgTaoProceduresResponse, OdgTaoFnolResponse } from '../types/odg';
import { LegacyCptRecord, LegacyIcdRecord, LegacyUraRecord } from '../types/legacy';
import { tildeList, padFnol, normalizeIcdCode } from '../parsers/queryParams';
import { LegacyError, ERRORS } from '../errors/legacyErrors';

const uraQuerySchema = z.object({
  icd:      z.string().default(''),
  cpt:      z.string().default(''),
  proc:     z.string().default(''),
  country:  z.string().default(''),
  flags:    z.string().default(''),
  bp:       z.string().optional(),
  noi:      z.string().optional(),
  clientid: z.string().optional(),
});

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
  const p = uraQuerySchema.parse({
    icd:      typeof query.icd      === 'string' ? query.icd      : undefined,
    cpt:      typeof query.cpt      === 'string' ? query.cpt      : undefined,
    proc:     typeof query.proc     === 'string' ? query.proc     : undefined,
    country:  typeof query.country  === 'string' ? query.country  : undefined,
    flags:    typeof query.flags    === 'string' ? query.flags    : undefined,
    bp:       typeof query.bp       === 'string' ? query.bp       : undefined,
    noi:      typeof query.noi      === 'string' ? query.noi      : undefined,
    clientid: typeof query.clientid === 'string' ? query.clientid : undefined,
  });

  const icdRaw  = p.icd;
  const cptRaw  = p.cpt;
  const procRaw = p.proc;
  const country = p.country.toUpperCase();
  const flags   = p.flags;
  const bp      = p.bp  !== undefined ? padFnol(p.bp)  : undefined;
  const noi     = p.noi !== undefined ? padFnol(p.noi) : undefined;
  const clientid = p.clientid;

  // Subscription outputMode overrides individual query param
  const fullOutput = subscription.outputMode === 'F';

  // icd=9 or icd=10 means: look up ICDs for a given CPT/procedure
  let icdLookupMode: '9' | '10' | undefined;
  let icds: string[] = [];

  if (icdRaw === '9' || icdRaw === '10') {
    icdLookupMode = icdRaw as '9' | '10';
  } else {
    // Legacy clients may omit the decimal in ICD codes (e.g. "A4545" → "A45.45").
    // Normalize each code before forwarding to the ODG API.
    icds = tildeList(icdRaw).map(normalizeIcdCode);
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

/**
 * Fetches FNOL TAO data via /tao/fnol/{bp}/{noi} and maps the response
 * into OdgTaoResponse shape so it can be fed directly into buildUraRecords.
 * The FNOL endpoint returns the full ICD + procedure data — no secondary
 * /tao/icds call is needed.
 */
async function fetchFnolTaoData(
  ctx: UraContext,
): Promise<OdgTaoResponse> {
  const params: Record<string, string | string[]> = {
    Country: ctx.country || 'US',
    ...(ctx.fullOutput ? { FullOutput: '1' } : {}),
  };
  if (ctx.flags) params.Flags = ctx.flags.split('');
  if (ctx.clientid) params.ClientId = ctx.clientid;
  let data: OdgTaoFnolResponse;
  try {
    data = await odgGet<OdgTaoFnolResponse>(`/tao/fnol/${ctx.bp}/${ctx.noi}`, params);
  } catch (err) {
    if (err instanceof UpstreamError) {
      throw new LegacyError(ERRORS.INVALID_CODES());
    }
    throw err;
  }
  // Flatten items[].taoDataItems[] → items[] to match OdgTaoResponse shape
  const items = (data?.items ?? []).flatMap((item) => item.taoDataItems ?? []);
  if (items.length === 0) {
    throw new LegacyError(ERRORS.INVALID_CODES());
  }
  return { items };
}

async function fetchTaoIcds(
  ctx: UraContext,
  icds: string[],
): Promise<OdgTaoResponse> {
  const params: Record<string, string | string[] | undefined> = {
    icd: icds,
    Country: ctx.country || 'US',
    ...(ctx.fullOutput ? { FullOutput: '1' } : {}),
  };
  if (ctx.country !== 'AU' && ctx.cpts.length > 0) {
    params.proc = ctx.cpts;
  } else if (ctx.country === 'AU' && ctx.procs.length > 0) {
    params.proc = ctx.procs;
  }
  if (ctx.flags) params.Flags = ctx.flags.split('');
  if (ctx.clientid) params.ClientId = ctx.clientid;

  return odgGet<OdgTaoResponse>('/tao/icds', params);
}

async function fetchTaoProcedures(
  ctx: UraContext,
): Promise<OdgTaoProceduresResponse> {
  const params: Record<string, string | string[] | undefined> = {
    proc: ctx.country === 'AU' ? ctx.procs : ctx.cpts,
    Country: ctx.country || 'US',
    resulttype: ctx.icdLookupMode === '9' ? '1' : '2',
    ...(ctx.fullOutput ? { FullOutput: '1' } : {}),
  };
  if (ctx.flags) params.Flags = ctx.flags.split('');
  if (ctx.clientid) params.ClientId = ctx.clientid;

  return odgGet<OdgTaoProceduresResponse>('/tao/procedures', params);
}

// ─── Response transformation ──────────────────────────────────────────────────

function n(val: number | undefined): string | null {
  return val != null ? String(val) : null;
}

function n2(val: number | undefined): string | null {
  return val != null ? val.toFixed(2) : null;
}

function capIncidence(val: number | undefined): string | null {
  if (val == null) return null;
  return (val > 99.9999 ? 99.9999 : val).toFixed(4);
}

function mapTaoProcedure(proc: OdgTaoProcedure, fullOutput: boolean, country: string): LegacyCptRecord {
  const rec: LegacyCptRecord = {
    code: proc.code ?? '',
    name: proc.name ?? '',
    incidencerate: capIncidence(proc.incidenceRate),
    ...(country === 'AU'
      ? { procfrequency: n2(proc.procedureFrequency) }
      : { cptfrequency: n2(proc.procedureFrequency) }),
    visit25: n(proc.visit25),
    visit50: n(proc.visit50),
    visit75: n(proc.visit75),
    visitmean: n2(proc.visitMean),
    costmean: n2(proc.costMean),
    odgcaa: n(proc.odgCAA),
    paymentflag: proc.paymentFlag ?? null,
    costpervisit: n2(proc.costPerVisit),
  };

  if (fullOutput) {
    const pt = proc.procedureType;
    rec.proctype = (pt == null || pt.toUpperCase() === 'N/A') ? '' : pt;
    rec.taoindex = n2(proc.taoIndex) ?? '0.00';
    if (country !== 'AU') {
      rec.avglostdays    = n2(proc.averageLostDays)   ?? '0.00';
      rec.medianlostdays = n2(proc.medianLostDays)   ?? '0.00';
      rec.pctneverreturn = n2(proc.percentNeverReturn) ?? '0.00';
      rec.pctzerodays    = n2(proc.percentZeroDays)   ?? '0.00';
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

  const isAu = ctx.country === 'AU';
  return groups.map((group) => {
    const procedures = (group.procedures ?? []).map((p) => mapTaoProcedure(p, fullOutput, ctx.country));
    return {
      icd: group.icd
        ? { code: group.icd.code ?? '', name: group.icd.name ?? '' }
        : undefined,
      ...(isAu ? { proc: procedures } : { cpt: procedures }),
    };
  });
}

/**
 * Maps an ICD child record from /tao/procedures response.
 * Frequency field is named icdfrequency in legacy output (not cptfrequency).
 */
function mapTaoIcdChild(icd: OdgTaoProcedure, fullOutput: boolean, country: string): LegacyIcdRecord {
  const rec: LegacyIcdRecord = {
    code: icd.code ?? '',
    name: icd.name ?? '',
    incidencerate: capIncidence(icd.incidenceRate),
    icdfrequency: n(icd.procedureFrequency),
    visit25: n(icd.visit25),
    visit50: n(icd.visit50),
    visit75: n(icd.visit75),
    visitmean: n2(icd.visitMean),
    costmean: n2(icd.costMean),
    odgcaa: n(icd.odgCAA),
    paymentflag: icd.paymentFlag ?? null,
    costpervisit: n2(icd.costPerVisit),
  };

  if (fullOutput) {
    const pt = icd.procedureType;
    rec.proctype = (pt == null || pt.toUpperCase() === 'N/A') ? '' : pt;
    rec.taoindex = n2(icd.taoIndex);
    if (country !== 'AU') {
      rec.avglostdays    = n2(icd.averageLostDays)    ?? '0.00';
      rec.medianlostdays = n2(icd.medianLostDays)    ?? '0.00';
      rec.pctneverreturn = n2(icd.percentNeverReturn) ?? '0.00';
      rec.pctzerodays    = n2(icd.percentZeroDays)    ?? '0.00';
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
  ctx: UraContext,
): Promise<UraResult> {
  let icds = ctx.icds;

  let records: LegacyUraRecord[];

  if (ctx.icdLookupMode) {
    // icd=9|10: reverse lookup — procedure → ICDs
    const data = await fetchTaoProcedures(ctx);
    records = buildUraProcedureRecords(data, ctx);
  } else if (icds.length === 0 && ctx.bp && ctx.noi) {
    // Only BP/NOI given — FNOL response already contains full TAO data
    const data = await fetchFnolTaoData(ctx);
    records = buildUraRecords(data, ctx);
  } else {
    try {
      const data = await fetchTaoIcds(ctx, icds);
      records = buildUraRecords(data, ctx);
    } catch (err) {
      // A 404 from ODG means the ICD(s) returned no data.
      // If BP/NOI are available, fall through to FNOL; otherwise rethrow.
      if (err instanceof UpstreamError && err.statusCode === 404 && ctx.bp && ctx.noi) {
        records = [];
      } else {
        throw err;
      }
    }

    // FNOL fallback: ICD codes returned no results (or 404) and BP/NOI are available
    const hasTaoResults = records.some(
      (r) =>
        (r.cpt && r.cpt.length > 0) ||
        (r.proc && r.proc.length > 0) ||
        (r.icdStats && r.icdStats.length > 0),
    );
    if (!hasTaoResults && ctx.bp && ctx.noi) {
      const fnolData = await fetchFnolTaoData(ctx);
      records = buildUraRecords(fnolData, ctx);
    }
  }

  const hasResults = records.some(
    (r) =>
      (r.cpt && r.cpt.length > 0) ||
      (r.proc && r.proc.length > 0) ||
      (r.icdStats && r.icdStats.length > 0),
  );

  if (!hasResults) {
    throw new LegacyError(ERRORS.NO_RESULTS('ICD/Treatment code'));
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
    const procedures = rec.proc ?? rec.cpt;
    const procKey = rec.proc ? 'proc' : 'cpt';
    return {
      icd: rec.icd,
      [procKey]: procedures && procedures.length > 0 ? { item: procedures } : undefined,
    };
  });

  const base: Record<string, unknown> = {
    item: items,
  };

  if (clientid) {
    base.clientid = clientid;
    base.rescount = records.length;
  }

  return base;
}
