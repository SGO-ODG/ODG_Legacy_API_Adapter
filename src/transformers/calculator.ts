import { CompanyRow } from '../db/companymaster';
import { odgPost } from '../upstream/odgClient';
import { OdgCalculatorResponse } from '../types/odg';
import { LegacyCalculatorResponse, LegacyCalcIcdCodeItem, LegacyFormat } from '../types/legacy';
import { parseXmlBody, xmlStr, xmlStrArray, xmlRootKey } from '../parsers/xmlBody';
import { padFnol, formatCurrency } from '../parsers/queryParams';
import { LegacyError, ERRORS } from '../errors/legacyErrors';

// ─── Shared XML parsing ───────────────────────────────────────────────────────

export interface CalcXmlInput {
  clientid?: string;
  country: string;
  state: string;
  age?: number;
  jds?: number;
  dataType?: string;
  jobClass?: number;
  medicalonly?: string;
  aww?: number;
  edl?: number;
  comprate?: number;
  mdd?: number;
  lostWages?: number;
  injuryDate?: string;
  surgeryDate?: string;
  fulloutput: number;
  icdCodes: string[];
  fnolCodes?: { bpcode: string; noicode: string }[];
  procSummary?: {
    cpt: string[];
    hcpcs: string[];
    icd: string[];
    ndc: string[];
  };
  cfactors?: Record<string, number | undefined>;
}

function deduplicate(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()).filter((s) => s.length > 0))];
}

function safeInt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

function safeFloat(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

export function parseCalcXml(raw: Buffer | string): CalcXmlInput {
  const parsed = parseXmlBody(raw);
  // Accept any root element name (<request>, <cbcalc>, <reservecalc>, etc.)
  const root = xmlRootKey(parsed);

  const r = (key: string) => xmlStr(parsed, root, key);

  const icdCodes = deduplicate(xmlStrArray(parsed, root, 'icdcodes', 'code'));
  const cptCodes = deduplicate(xmlStrArray(parsed, root, 'procsummary', 'cpt', 'code'));
  const hcpcsCodes = deduplicate(xmlStrArray(parsed, root, 'procsummary', 'hcpcs', 'code'));
  const procIcdCodes = deduplicate(xmlStrArray(parsed, root, 'procsummary', 'icd', 'code'));
  const ndcCodes = deduplicate(xmlStrArray(parsed, root, 'procsummary', 'ndc', 'code'));

  const bpRaw = r('bpcode');
  const noiRaw = r('noicode');
  const fnolCodes =
    bpRaw && noiRaw
      ? [{ bpcode: padFnol(bpRaw), noicode: padFnol(noiRaw) }]
      : undefined;

  // Must have at least one valid diagnosis or procedure
  const hasDiagnosis = icdCodes.length > 0 || (fnolCodes && fnolCodes.length > 0);
  const hasProcedure = cptCodes.length > 0 || hcpcsCodes.length > 0 || procIcdCodes.length > 0;
  if (!hasDiagnosis && !hasProcedure) {
    throw new LegacyError(ERRORS.MISSING_DIAGNOSIS());
  }

  // cfactors — Swagger uses preExisting (capital E) for preexisting
  const cfactorsEl = (parsed as Record<string, unknown>)[root] as Record<string, unknown> | undefined;
  const cfRaw = cfactorsEl?.cfactors as Record<string, unknown> | undefined;
  const cfactors: Record<string, number | undefined> = {};
  if (cfRaw) {
    const fields = [
      'depression', 'diabetes', 'hypertension', 'legalrep', 'obesity',
      'opioids', 'smoker', 'subabuse', 'surgery', 'pregnancy',
    ];
    for (const f of fields) {
      const v = cfRaw[f];
      if (v != null) cfactors[f] = parseInt(String(v), 10);
    }
    // preexisting → preExisting
    const pre = cfRaw.preexisting;
    if (pre != null) cfactors.preExisting = parseInt(String(pre), 10);
  }

  return {
    clientid: r('clientid') ?? undefined,
    country: r('country') ?? 'US',
    state: r('state') ?? 'US',
    age: safeInt(r('age')),
    jds: safeFloat(r('jds')),
    dataType: r('datatype') ?? undefined,
    jobClass: safeInt(r('jobclass')),
    medicalonly: r('medicalonly') ?? undefined,
    aww: safeFloat(r('aww')),
    edl: safeFloat(r('edl')),
    comprate: safeFloat(r('comprate')),
    mdd: safeFloat(r('mdd')),
    lostWages: safeFloat(r('lostwages')),
    injuryDate: r('injurydate') ?? undefined,
    surgeryDate: r('surgerydate') ?? undefined,
    fulloutput: r('fulloutput')?.toUpperCase() === 'Y' ? 1 : 0,
    icdCodes,
    fnolCodes,
    procSummary:
      cptCodes.length || hcpcsCodes.length || procIcdCodes.length || ndcCodes.length
        ? { cpt: cptCodes, hcpcs: hcpcsCodes, icd: procIcdCodes, ndc: ndcCodes }
        : undefined,
    cfactors: Object.keys(cfactors).length > 0 ? cfactors : undefined,
  };
}

// ─── Upstream request building ────────────────────────────────────────────────

export function buildCalcRequest(
  input: CalcXmlInput,
  requestedOutput: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    // TODO/confirm: requestedoutput enum value — 'RasAndRtw' for comorbidity
    requestedoutput: requestedOutput,
    clientId: input.clientid,
    country: input.country,
    state: input.state,
    fulloutput: input.fulloutput,
    icdCodes: { codes: input.icdCodes },
  };

  if (input.age != null) body.age = input.age;
  if (input.jds != null) body.jds = input.jds;
  if (input.dataType) body.dataType = input.dataType;
  if (input.jobClass != null) {
    if (input.jobClass > 5) body.ncci = input.jobClass;
    else body.jobClass = input.jobClass;
  }
  if (input.medicalonly != null) body.medicalonly = input.medicalonly;
  if (input.aww != null) body.aww = input.aww;
  if (input.edl != null) body.edl = input.edl;
  if (input.comprate != null) body.comprate = input.comprate;
  if (input.mdd != null) body.mdd = input.mdd;
  if (input.lostWages != null) body.lostWages = input.lostWages;
  if (input.injuryDate) body.injuryDate = `${input.injuryDate}T00:00:00Z`;
  if (input.surgeryDate) body.surgeryDate = `${input.surgeryDate}T00:00:00Z`;
  if (input.fnolCodes) body.fnolCodes = input.fnolCodes;
  if (input.procSummary) {
    const ps: Record<string, unknown> = {};
    if (input.procSummary.cpt.length)   ps.cpt   = { codes: input.procSummary.cpt };
    if (input.procSummary.hcpcs.length) ps.hcpcs = { codes: input.procSummary.hcpcs };
    if (input.procSummary.icd.length)   ps.icd   = { codes: input.procSummary.icd };
    if (input.procSummary.ndc.length)   ps.ndc   = { codes: input.procSummary.ndc };
    body.procsummary = ps;
  }
  if (input.cfactors) body.cfactors = input.cfactors;

  return body;
}

// ─── Response transformation ──────────────────────────────────────────────────

function deepRenameKey(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((v) => deepRenameKey(v, from, to));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k === from ? to : k] = deepRenameKey(v, from, to);
    }
    return out;
  }
  return value;
}

function formatCurrencyValues(value: unknown): unknown {
  if (typeof value === 'number') return formatCurrency(value);
  if (Array.isArray(value)) return value.map(formatCurrencyValues);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = formatCurrencyValues(v);
    }
    return out;
  }
  return value;
}

function omitKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k)) result[k] = v;
  }
  return result;
}

function renameKeys(obj: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[map[k] ?? k] = v;
  }
  return result;
}

function stringifyFields(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = { ...obj };
  for (const k of keys) {
    if (result[k] != null) result[k] = String(result[k]);
  }
  return result;
}

function formatFixedFields(obj: Record<string, unknown>, keys: string[], decimals: number): Record<string, unknown> {
  const result: Record<string, unknown> = { ...obj };
  for (const k of keys) {
    if (result[k] != null) result[k] = parseFloat(String(result[k])).toFixed(decimals);
  }
  return result;
}

/**
 * Maps an ODG v1.2 calculator response to the legacy response shape.
 *
 * TODO/confirm:
 * - projectedcosts: confirm whether same bp/cp95/cp100 renaming applies.
 * - notes schema (Reserve only).
 */
export function mapCalcResponse(
  data: OdgCalculatorResponse,
  input: CalcXmlInput,
  format: LegacyFormat = 'xml',
  service: 'comorbidity' | 'reserve' = 'comorbidity',
): LegacyCalculatorResponse {
  return {
    clientid: input.clientid,
    // TODO/confirm: riskassessment nested fields vs v1.2
    riskassessment: data.riskAssessment
      ? formatFixedFields(omitKeys(data.riskAssessment, ['ssdiFlag']), ['magnitude', 'volatility'], 2)
      : undefined,
    // TODO/confirm: adjustedduration BP/CP95/CP100 vs v1.2 percentiles
    adjustedduration: (service === 'comorbidity' && input.medicalonly) || !data.adjustedDuration
      ? undefined
      : renameKeys(omitKeys(data.adjustedDuration, ['clinicalMin']), {
          bestPractice: 'bp',
          claimAverage: 'cp95',
          claimMax: 'cp100',
        }),
    projectedcosts: data.projectedCosts
      ? formatCurrencyValues(renameKeys(data.projectedCosts, {
          bestPractice: 'bp',
          claimAverage: 'cp95',
          claimMax: 'cp100',
        })) as Record<string, unknown>
      : undefined,
    adjustedsummaryguidelines: service === 'reserve' ? undefined : data.adjustedSummaryGuidelines ?? undefined,
    comprate: data.compRate != null ? formatCurrency(data.compRate) : undefined,
    icdcodes: input.fulloutput && Array.isArray(data.icdCodes?.icdcode)
      ? {
          icdcode: data.icdCodes!.icdcode!.map((item): LegacyCalcIcdCodeItem => ({
            code: item.code,
            name: item.name,
            stcode: item.stcode ?? null,
            meandurationdays: item.meanDurationDays
              ? {
                  bp: item.meanDurationDays.bestPractice,
                  cp95: item.meanDurationDays.claimAverage,
                  cp100: item.meanDurationDays.claimMax,
                }
              : undefined,
          })),
        }
      : undefined,
    fnolcodes: data.fnolCodes ?? undefined,
    procsummary: (() => {
      if (!data.procsummary) return undefined;
      if (format === 'json') {
        const cpts = data.procsummary.cptcodes?.cptcode;
        if (!Array.isArray(cpts) || cpts.length === 0) return undefined;
        return {
          cptcodes: cpts.map((c) => ({
            code: c.code,
            name: c.name,
            meandurationdays: c.meanDurationDays,
          })),
        };
      }
      return data.procsummary as LegacyCalculatorResponse['procsummary'];
    })(),
    cfactors: data.cfactors
      ? Object.fromEntries(
          Object.entries(data.cfactors).map(([k, v]) => [
            k,
            Array.isArray(v)
              ? (v[0] != null ? String(v[0]) : null)
              : v != null && typeof v === 'object'
              ? Object.fromEntries(
                  Object.entries(v as Record<string, unknown>).map(([ik, iv]) => [
                    ik,
                    Array.isArray(iv) ? (iv[0] != null ? String(iv[0]) : null)
                      : typeof iv === 'number' ? String(iv)
                      : ik === 'alert' && typeof iv === 'string' ? iv.toLowerCase()
                      : iv,
                  ]),
                )
              : typeof v === 'number' ? String(v) : v,
          ]),
        )
      : undefined,
    alertdesc: data.alertdesc ?? undefined,
    notes: data.notes
      ? (Array.isArray(data.notes) ? data.notes : [data.notes]).map((n) => {
          let note = deepRenameKey(n as Record<string, unknown>, 'bestPractice', 'bp');
          note = deepRenameKey(note as Record<string, unknown>, 'claimAverage', 'cp95');
          note = deepRenameKey(note as Record<string, unknown>, 'claimMax', 'cp100');
          return note;
        })
      : undefined,
    odgurl: data.odgByMcgLinks?.duration ?? null,
    deeplinkurl: data.odgByMcgLinks?.duration ?? null,
  };
}

// ─── Main handlers ────────────────────────────────────────────────────────────

export async function handleComorbidity(
  company: CompanyRow,
  raw: Buffer | string,
  format: LegacyFormat = 'xml',
): Promise<LegacyCalculatorResponse> {
  const input = parseCalcXml(raw);
  // TODO/confirm: requestedoutput enum value for comorbidity
  const body = buildCalcRequest(input, 'RasAndRtw');
  const data = await odgPost<OdgCalculatorResponse>(company, '/calculator', body);
  return mapCalcResponse(data, input, format, 'comorbidity');
}

export async function handleReserve(
  company: CompanyRow,
  raw: Buffer | string,
  format: LegacyFormat = 'xml',
): Promise<LegacyCalculatorResponse> {
  const input = parseCalcXml(raw);
  // TODO/confirm: requestedoutput enum value for reserve
  const body = buildCalcRequest(input, 'RasRtwCosts');
  const data = await odgPost<OdgCalculatorResponse>(company, '/calculator', body);
  return mapCalcResponse(data, input, format, 'reserve');
}

export function buildCalcModel(result: LegacyCalculatorResponse): Record<string, unknown> {
  // Remove undefined values but keep nulls (null = intentionally omitted for TODO fields)
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
