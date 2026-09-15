import { CompanyRow } from '../db/companymaster';
import { odgGet } from '../upstream/odgClient';
import { OdgSearchResponse } from '../types/odg';
import { LegacySearchResultBase } from '../types/legacy';
import { parseXmlBody, xmlStr, xmlRootKey } from '../parsers/xmlBody';
import { LegacyError, ERRORS } from '../errors/legacyErrors';

// ─── Request parsing ──────────────────────────────────────────────────────────

export interface OneSearchContext {
  text: string;
  types: string[];      // upstream /search type values
  clientid?: string;
  /** Preserves the legacy database flag that was active, for response type mapping */
  dbFlags: {
    icd9: boolean;
    icd10: boolean;
    cpt: boolean;
    ndc: boolean;
    proct: boolean;
  };
}

/** Maps legacy database flags to upstream /search `type` query parameter values. */
const DB_TO_SEARCH_TYPE: Record<string, string> = {
  icd9: 'icd9search',
  icd10: 'icd10search',
  cpt: 'procedurescpt',
  ndc: 'formularyndc',
  proct: 'treatment',
};

/**
 * Maps the ODG /search response `section` values back to the legacy `type`
 * field values expected in the output.
 * Keys are lowercase so the lookup is case-insensitive.
 */
const SECTION_TO_LEGACY_TYPE: Record<string, string> = {
  icd9search:    'ICD9',
  icd10search:   'ICD10',
  procedurescpt: 'CPT',
  formularyndc:  'NDC',
  treatment:     'PROCT',
};

export function parseOneSearchBody(raw: Buffer | string): OneSearchContext {
  const parsed = parseXmlBody(raw);
  // Accept any root element name (<request>, <onesearch>, etc.)
  const root = xmlRootKey(parsed);

  const text = xmlStr(parsed, root, 'text');
  if (text === undefined) {
    // <text> element is entirely absent from the XML body
    throw new LegacyError(ERRORS.MISSING_XML_ELEMENTS());
  }
  if (text.trim().length < 2) {
    // <text> is present but has fewer than 2 non-whitespace characters (includes empty)
    throw new LegacyError(ERRORS.SEARCH_TEXT_TOO_SHORT());
  }

  // Read database flags — only 'Y' (exact) selects a database
  const db = (parsed as Record<string, unknown>)[root] as Record<string, unknown>;
  const database = db?.database as Record<string, unknown> | undefined;

  if (!database) {
    throw new LegacyError(ERRORS.MISSING_XML_ELEMENTS());
  }

  const icd9 = String(database.icd9 ?? '') === 'Y';
  const icd10 = String(database.icd10 ?? '') === 'Y';
  const cpt = String(database.cpt ?? '') === 'Y';
  const ndc = String(database.ndc ?? '') === 'Y';
  const proct = String(database.proct ?? '') === 'Y';

  if (!icd9 && !icd10 && !cpt && !ndc && !proct) {
    throw new LegacyError({
      status: 404,
      body: { error: 'One or more database element child (search in) required to process your request.' },
    });
  }

  const types: string[] = [];
  if (icd9) types.push(DB_TO_SEARCH_TYPE.icd9);
  if (icd10) types.push(DB_TO_SEARCH_TYPE.icd10);
  if (cpt) types.push(DB_TO_SEARCH_TYPE.cpt);
  if (ndc) types.push(DB_TO_SEARCH_TYPE.ndc);
  if (proct) types.push(DB_TO_SEARCH_TYPE.proct);

  const clientid = xmlStr(parsed, root, 'clientid');

  return {
    text: text.trim(),
    types,
    clientid: clientid ?? undefined,
    dbFlags: { icd9, icd10, cpt, ndc, proct },
  };
}

// ─── Upstream call ────────────────────────────────────────────────────────────

async function fetchSearchResults(
  company: CompanyRow,
  ctx: OneSearchContext,
): Promise<OdgSearchResponse> {
  return odgGet<OdgSearchResponse>(company, '/search', {
    query: ctx.text,
    type: ctx.types,
    facets: false,
    country: 'US',
  });
}

// ─── Response transformation ──────────────────────────────────────────────────

/**
 * Maps one ODG result-set item to the legacy shape.
 * Returns null for unrecognised section names so the item is silently skipped.
 * TODO/confirm: ODG result item field names are candidates — verify against live API.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapResultItem(item: any, section: string): LegacySearchResultBase | null {
  const legacyType = SECTION_TO_LEGACY_TYPE[section.toLowerCase()];
  if (!legacyType) return null;

  if (legacyType === 'NDC') {
    return {
      type: 'NDC',
      code: item.code ?? item.ndcCode ?? '',
      name: item.nonProprietaryName ?? item.name ?? '',
      brand: item.tradeName ?? item.brand ?? item.proprietaryName ?? '',
    };
  }

  if (legacyType === 'PROCT') {
    return {
      type: 'PROCT',
      name: item.name ?? item.topic ?? '',
      chapter: item.primaryChapter ?? item.chapter ?? '',
    };
  }

  // CPT — ODG returns the code in procedureCode
  if (legacyType === 'CPT') {
    return {
      type: 'CPT',
      code: item.procedureCode ?? item.code ?? '',
      name: item.name ?? item.description ?? '',
    };
  }

  // ICD9, ICD10 — ODG returns the code in icdCode
  return {
    type: legacyType,
    code: item.icdCode ?? item.code ?? '',
    name: item.name ?? item.description ?? '',
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export interface OneSearchResult {
  results: LegacySearchResultBase[];
  clientid?: string;
}

export async function handleOneSearch(
  company: CompanyRow,
  ctx: OneSearchContext,
): Promise<OneSearchResult> {
  const data = await fetchSearchResults(company, ctx);
  const resultSets = data.resultSets ?? [];

  const results: LegacySearchResultBase[] = [];
  for (const set of resultSets) {
    const section = set.section ?? '';
    for (const item of set.results ?? []) {
      const mapped = mapResultItem(item, section);
      if (mapped) results.push(mapped);
    }
  }

  if (results.length === 0) {
    throw new LegacyError(ERRORS.NO_RESULTS('search criteria'));
  }

  return { results, clientid: ctx.clientid };
}

// ─── Response serialisation ───────────────────────────────────────────────────

/**
 * Builds the model for the XML response.
 *
 * Legacy XML shape (mirrors PHP Format::to_xml behaviour for numeric arrays):
 *   <root>
 *     <item><type>ICD9</type><code>...</code><name>...</name></item>
 *     <item><type>NDC</type><code>...</code><name>...</name><brand>...</brand></item>
 *     ...
 *     <rescount>N</rescount>   ← only present when clientid is provided
 *     <clientid>...</clientid> ← only present when clientid is provided
 *   </root>
 */
export function buildOneSearchXmlModel(result: OneSearchResult): Record<string, unknown> {
  const { results, clientid } = result;
  const model: Record<string, unknown> = { item: results };
  if (clientid) {
    model.rescount = results.length;
    model.clientid = clientid;
  }
  return model;
}

/**
 * Builds the body for the JSON response.
 *
 * Mirrors PHP json_encode behaviour for the mixed-key array:
 * - No clientid → plain JSON array  [ {type,code,name}, ... ]
 * - With clientid → JSON object with numeric string keys plus rescount/clientid
 *   { "0": {type,code,name}, ..., "rescount": N, "clientid": "..." }
 */
export function buildOneSearchJsonBody(result: OneSearchResult): unknown {
  const { results, clientid } = result;
  if (!clientid) {
    return results;
  }
  const obj: Record<string, unknown> = {};
  (results as unknown as Record<string, unknown>[]).forEach((r, i) => {
    obj[String(i)] = r;
  });
  obj.rescount = results.length;
  obj.clientid = clientid;
  return obj;
}
