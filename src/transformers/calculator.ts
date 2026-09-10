import { CompanyRow } from '../db/companymaster';
import { odgPost, UpstreamError } from '../upstream/odgClient';
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
  jobClass?: string;  // raw string; preserves leading zeros for 4-digit NCCI codes (e.g. "0172")
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

  // Root element with no children (e.g. <cbcalc></cbcalc>) parses to an empty string — treat as invalid XML.
  if (!parsed[root] || typeof parsed[root] !== 'object') {
    throw new LegacyError(ERRORS.INVALID_XML());
  }

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
    state: (() => {
      const s = r('state');
      if (s) return s;
      return (r('country') ?? 'US').toUpperCase() === 'AU' ? 'AUS' : 'US';
    })(),
    age: safeInt(r('age')),
    jds: safeFloat(r('jds')),
    dataType: r('datatype') ?? undefined,
    jobClass: (() => {
      const raw = r('jobclass');
      if (!raw) return undefined;
      // If length > 1 or numeric value > 5 it is an NCCI code — pad to 4 digits to
      // preserve leading zeros (e.g. "172" → "0172", "0172" stays "0172").
      // Single-digit values 1–5 are DOL job classes and need no padding.
      const n = parseInt(raw, 10);
      return (!isNaN(n) && (raw.length > 1 || n > 5)) ? raw.padStart(4, '0') : raw;
    })(),
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
    // NCCI codes are padded to 4 digits during parsing (length > 1).
    // DOL job classes are single-digit strings "1"–"5".
    // Must check length, not numeric value, because NCCI codes like "0005" parse
    // to integer 5 which would incorrectly route to the DOL branch if compared as > 5.
    if (input.jobClass.length > 1) body.ncci = input.jobClass;   // 4-digit NCCI string e.g. "0005"
    else body.jobClass = parseInt(input.jobClass, 10);            // DOL class integer 1–5
  }
  if (input.medicalonly != null) body.medicalonly = (input.medicalonly === '1' || input.medicalonly.toUpperCase() === 'M') ? 1 : 0;
  if (input.aww != null) body.aww = input.aww;
  if (input.edl != null) body.edl = input.edl;
  if (input.comprate != null) body.comprate = input.comprate;
  if (input.mdd != null) body.mdd = input.mdd;
  if (input.lostWages != null) body.lostWages = input.lostWages;
  if (input.injuryDate) body.injuryDate = `${input.injuryDate}T00:00:00Z`;
  if (input.surgeryDate) body.surgeryDate = `${input.surgeryDate}T00:00:00Z`;
  if (input.fnolCodes) {
    const fnolKey = input.country.toUpperCase() === 'AU' ? 'toocsCodes' : 'fnolCodes';
    body[fnolKey] = input.fnolCodes;
  }
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

// When a cfactor has multiple triggers (e.g. surgery), prefer CPT codes over ICD
// procedure codes. ICD procedure codes contain a decimal (e.g. "85.11"); CPT codes
// do not (e.g. "22840"). Within the preferred group, use the last code — legacy API
// returns only one trigger.
function selectPreferredTrigger(triggers: unknown[]): string | null {
  const strs = triggers.map(String).filter((s) => s.length > 0);
  if (strs.length === 0) return null;
  const cptCodes = strs.filter((s) => !s.includes('.'));
  return cptCodes.length > 0 ? cptCodes[cptCodes.length - 1] : strs[strs.length - 1];
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
      ? (() => {
          // When FNOL codes are present, ODG resolves them to ICDs and includes those
          // in the icdcodes response. Legacy only returns explicitly submitted ICD codes.
          // If both FNOL and ICD codes were given: filter to only the explicit ICD codes.
          // If only FNOL (no explicit ICD codes): skip icdcodes entirely.
          const hasFnol = input.fnolCodes && input.fnolCodes.length > 0;
          const explicitIcds = input.icdCodes;
          if (hasFnol && explicitIcds.length === 0) return undefined;
          const sourceItems = hasFnol
            ? data.icdCodes!.icdcode!.filter((item) => explicitIcds.includes(item.code ?? ''))
            : data.icdCodes!.icdcode!;
          if (sourceItems.length === 0) return undefined;
          const items = sourceItems.map((item): LegacyCalcIcdCodeItem => ({
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
          }));
          return format === 'json' ? items : { icdcode: items };
        })()
      : undefined,
    fnolcodes: input.fulloutput && data.fnolCodes
      ? (() => {
          // Strip icdcodes from each fnolcodes item — legacy output does not include it.
          // fnolCodes may be a direct array or a wrapper object like { fnolcode: [...] }.
          const stripIcdcodes = (item: unknown): unknown => {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              const out: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
                if (k.toLowerCase() !== 'icdcodes') out[k] = v;
              }
              return out;
            }
            return item;
          };
          const raw = data.fnolCodes as Record<string, unknown>;
          if (Array.isArray(raw)) {
            return raw.map(stripIcdcodes);
          }
          // Wrapper object: strip from items in any nested array (e.g. { fnolcode: [...] })
          const result: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(raw)) {
            result[k] = Array.isArray(v) ? v.map(stripIcdcodes) : v;
          }
          return result;
        })()
      : undefined,
    procsummary: (() => {
      if (!data.procsummary) return undefined;

      const cpts = data.procsummary.cptcodes?.cptcode;
      const procIcds = data.procsummary.icdcodes?.icdcode;

      const hasCpt = Array.isArray(cpts) && cpts.length > 0;

      const cptFiltered = hasCpt
        ? cpts!
            .map((c) => ({ code: c.code, name: c.name, meandurationdays: c.meanDurationDays }))
            .filter((c) => (c.meandurationdays ?? 0) > 0)
        : [];
      const cptArray = cptFiltered.length > 0 ? cptFiltered : null;
      const cptcodes = cptArray
        ? { cptcodes: format === 'json' ? cptArray : { cptcode: cptArray } }
        : {};

      // ICD procedure codes: always include when present. Exclude superprocedurename
      // and format meandurationdays to 3 decimal places (e.g. 24.300, 17.000).
      const procIcdArray = Array.isArray(procIcds) && procIcds.length > 0
        ? procIcds.map((c) => ({
            code: c.code,
            name: c.name,
            meandurationdays: c.meanDurationDays != null ? c.meanDurationDays.toFixed(3) : undefined,
          }))
        : null;
      const icdcodes = procIcdArray
        ? { icdcodes: format === 'json' ? procIcdArray : { icdcode: procIcdArray } }
        : {};

      const result = { ...cptcodes, ...icdcodes };
      return Object.keys(result).length > 0 ? result : undefined;
    })(),
    cfactors: (() => {
      if (!data.cfactors) return undefined;
      const mapped = Object.fromEntries(
        Object.entries(data.cfactors)
          .filter(([, v]) => {
            // Exclude factors where applied === 0 — ODG API returns these when
            // a factor was evaluated but not applied; legacy never surfaces them.
            if (v == null || typeof v !== 'object' || Array.isArray(v)) return true;
            const raw = (v as Record<string, unknown>).applied;
            const applied = Array.isArray(raw) ? raw[0] : raw;
            return applied == null || String(applied) !== '0';
          })
          .map(([k, v]) => [
          k,
          Array.isArray(v)
            ? (v[0] != null ? String(v[0]) : null)
            : v != null && typeof v === 'object'
            ? Object.fromEntries(
                Object.entries(v as Record<string, unknown>).map(([ik, iv]) => [
                  ik,
                  Array.isArray(iv)
                    ? (ik === 'trigger' ? selectPreferredTrigger(iv) : (iv[0] != null ? String(iv[0]) : null))
                    : ik === 'applied' ? parseInt(String(iv), 10)
                    : typeof iv === 'number' ? String(iv)
                    : ik === 'alert' && typeof iv === 'string' ? iv.toLowerCase()
                    : iv,
                ]),
              )
            : typeof v === 'number' ? String(v) : v,
        ]),
      );
      return Object.keys(mapped).length > 0 ? mapped : undefined;
    })(),
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
  try {
    const data = await odgPost<OdgCalculatorResponse>(company, '/calculator', body);
    return mapCalcResponse(data, input, format, 'comorbidity');
  } catch (err) {
    // FNOL codes that ODG cannot resolve to a valid ICD → upstream returns 404.
    // Map to legacy 400 "invalid codes" so the customer knows their FNOL codes are bad.
    if (err instanceof UpstreamError && (err.statusCode === 404 || err.statusCode === 400) && input.fnolCodes?.length) {
      throw new LegacyError(ERRORS.INVALID_CODES());
    }
    throw err;
  }
}

export async function handleReserve(
  company: CompanyRow,
  raw: Buffer | string,
  format: LegacyFormat = 'xml',
): Promise<LegacyCalculatorResponse> {
  const input = parseCalcXml(raw);
  // TODO/confirm: requestedoutput enum value for reserve
  const body = buildCalcRequest(input, 'RasRtwCosts');
  try {
    const data = await odgPost<OdgCalculatorResponse>(company, '/calculator', body);
    return mapCalcResponse(data, input, format, 'reserve');
  } catch (err) {
    // FNOL codes that ODG cannot resolve to a valid ICD → upstream returns 404.
    // Map to legacy 400 "invalid codes" so the customer knows their FNOL codes are bad.
    if (err instanceof UpstreamError && (err.statusCode === 404 || err.statusCode === 400) && input.fnolCodes?.length) {
      throw new LegacyError(ERRORS.INVALID_CODES());
    }
    throw err;
  }
}

export function buildCalcModel(result: LegacyCalculatorResponse): Record<string, unknown> {
  // Remove undefined values but keep nulls (null = intentionally omitted for TODO fields)
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
