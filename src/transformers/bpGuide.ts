import { z } from 'zod';
import { CompanyRow } from '../db/companymaster';
import { odgGet } from '../upstream/odgClient';
import { OdgGuidelineRecord } from '../types/odg';
import { LegacyBpGuideRecord } from '../types/legacy';
import { tildeList, padFnol } from '../parsers/queryParams';
import { LegacyError, ERRORS } from '../errors/legacyErrors';

const bpGuideQuerySchema = z.object({
  icd:      z.string().default(''),
  bp:       z.string().optional(),
  noi:      z.string().optional(),
  clientid: z.string().optional(),
});

// ─── Request parsing ──────────────────────────────────────────────────────────

export interface BpGuideContext {
  icds: string[];          // ICD codes from icd param (may be mixed 9/10)
  bp?: string;             // FNOL body-part
  noi?: string;            // FNOL nature-of-injury
  clientid?: string;
}

/**
 * Naive ICD family detection: ICD-10 codes typically contain a letter in the
 * first character (e.g. M54.5); ICD-9 codes are mostly numeric (e.g. 724.2).
 */
function detectIcdFamily(code: string): 'icd9' | 'icd10' {
  return /^[a-zA-Z]/.test(code.trim()) ? 'icd10' : 'icd9';
}

export function parseBpGuideParams(
  query: Record<string, string | string[] | undefined>,
): BpGuideContext {
  const p = bpGuideQuerySchema.parse({
    icd:      typeof query.icd      === 'string' ? query.icd      : undefined,
    bp:       typeof query.bp       === 'string' ? query.bp       : undefined,
    noi:      typeof query.noi      === 'string' ? query.noi      : undefined,
    clientid: typeof query.clientid === 'string' ? query.clientid : undefined,
  });

  const bp       = p.bp  !== undefined ? padFnol(p.bp)  : undefined;
  const noi      = p.noi !== undefined ? padFnol(p.noi) : undefined;
  const clientid = p.clientid;
  const icds     = tildeList(p.icd);

  if (icds.length === 0 && !(bp && noi)) {
    throw new LegacyError(ERRORS.INVALID_FORMAT());
  }

  return { icds, bp, noi, clientid };
}

// ─── Upstream calls ───────────────────────────────────────────────────────────

/**
 * Resolves FNOL codes to ICD codes via /tao/fnol/{bp}/{noi}.
 * TODO/confirm: same FNOL resolution as UR Advisor — schema unconfirmed.
 */
async function resolveFnolToIcds(
  company: CompanyRow,
  bp: string,
  noi: string,
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await odgGet<any>(company, `/tao/fnol/${bp}/${noi}`);
  const candidates: string[] = Array.isArray(data?.icds) ? data.icds : [];
  if (candidates.length === 0) {
    throw new LegacyError(ERRORS.INVALID_FNOL());
  }
  return candidates;
}

async function fetchGuidelines(
  company: CompanyRow,
  icds: string[],
): Promise<OdgGuidelineRecord[]> {
  const params: Record<string, string[]> = { icd9: [], icd10: [] };

  for (const code of icds) {
    const family = detectIcdFamily(code);
    params[family].push(code);
  }

  // Remove empty arrays so they aren't sent as empty query params
  if (params.icd9.length === 0) delete params.icd9;
  if (params.icd10.length === 0) delete params.icd10;

  return odgGet<OdgGuidelineRecord[]>(company, '/guidelines', params);
}

// ─── Response transformation ──────────────────────────────────────────────────

function mapGuidelineRecord(rec: OdgGuidelineRecord): LegacyBpGuideRecord {
  const bp = (rec.bestPracticeGuidelines ?? []).map((g) => ({
    primaryRTWpath: g.pathway ?? null,
    days1: g.minDays ?? null,
    days: g.maxDays ?? null,
  }));

  // TODO/confirm: activityModifiers nested item schema not confirmed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activitymod = (rec.activityModifiers ?? []).map((a: any) => ({
    jobtype: a.jobType ?? a.jobtype ?? null,
    jobmodification: a.jobModification ?? a.jobmodification ?? null,
  }));

  // TODO/confirm: physicalTherapyVisits nested item schema not confirmed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pt = (rec.physicalTherapyVisits ?? []).map((v: any) => ({
    primarypath: v.pathway ?? null,
    visits: v.visits ?? null,
    weeks: v.weeks ?? null,
  }));

  // TODO/confirm: chiropractorVisits nested item schema not confirmed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chiro = (rec.chiropractorVisits ?? []).map((v: any) => ({
    primarypath: v.pathway ?? null,
    visits: v.visits ?? null,
    weeks: v.weeks ?? null,
  }));

  return {
    icdcode: rec.code ?? '',
    name: rec.description ?? '',
    bp,
    activitymod,
    pt,
    chiro,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export interface BpGuideResult {
  records: LegacyBpGuideRecord[];
  clientid?: string;
}

export async function handleBpGuide(
  company: CompanyRow,
  ctx: BpGuideContext,
): Promise<BpGuideResult> {
  let icds = ctx.icds;

  if (icds.length === 0 && ctx.bp && ctx.noi) {
    icds = await resolveFnolToIcds(company, ctx.bp, ctx.noi);
  }

  const raw = await fetchGuidelines(company, icds);
  // ODG /guidelines returns a single record object for one ICD or an array for many.
  // Normalize to array in both cases.
  const guidelineArray: OdgGuidelineRecord[] = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' ? [raw as OdgGuidelineRecord] : []);

  const records = guidelineArray.map(mapGuidelineRecord);

  if (records.length === 0) {
    throw new LegacyError(ERRORS.NO_RESULTS('ICD code'));
  }

  return { records, clientid: ctx.clientid };
}

/**
 * Wraps a single guideline record's nested arrays in `{ item: [...] }` so that
 * fast-xml-parser emits `<bp><item>...</item></bp>` instead of `<bp>...</bp><bp>...`.
 */
function wrapBpRecordItems(rec: LegacyBpGuideRecord): Record<string, unknown> {
  return {
    icdcode: rec.icdcode,
    name: rec.name,
    bp: rec.bp.length > 0 ? { item: rec.bp } : null,
    activitymod: rec.activitymod.length > 0 ? { item: rec.activitymod } : null,
    pt: rec.pt.length > 0 ? { item: rec.pt } : null,
    chiro: rec.chiro.length > 0 ? { item: rec.chiro } : null,
  };
}

export function buildBpGuideModel(result: BpGuideResult): Record<string, unknown> {
  const { records, clientid } = result;
  const count = records.length;

  // XML: item-wrapped for <root><item>...</item></root> legacy format
  const wrapped = records.map(wrapBpRecordItems);
  const base: Record<string, unknown> = count === 1 ? { item: wrapped[0] } : { item: wrapped };

  if (clientid) {
    base.clientid = clientid;
    base.rescount = count;
  }

  return base;
}
