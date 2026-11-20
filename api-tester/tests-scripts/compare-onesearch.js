'use strict';

/**
 * compare-onesearch.js
 *
 * Reads a CSV of One Search test cases and fires each POST request at both
 * the live legacy API and the new adapter API in parallel. Compares the
 * structural schema of both responses (property names, nesting, data types -
 * NOT actual values) and writes any discrepancies to an output CSV.
 *
 * Usage:
 *   node api-tester/tests-scripts/compare-onesearch.js [options]
 *
 * Options:
 *   --input  <path>   Input CSV file (default: ./api-tester/tests-scripts/input/onesearch-tests.csv)
 *   --output <path>   Output CSV file (default: ./api-tester/tests-scripts/output/onesearch-results-<timestamp>.csv)
 *   --debug           Print raw HTTP status and response preview for every call (useful for diagnosing failures)
 *
 * Required .env variables (loaded from project root):
 *   LEGACY_API_BASE_URL   Base URL of the live legacy PHP API
 *   ADAPTER_API_BASE_URL  Base URL of the new Express adapter
 *   COMPARE_API_KEY       X-ODG-KEY sent to both environments (same key must exist in both)
 *
 * Optional .env variables:
 *   SEARCH_IGNORE_CASE=Y          When set to 'Y', compare 'name' fields case-insensitively
 *                                 (legacy and adapter may differ in casing)
 *   SEARCH_NAME_COMPARE_LENGTH=N  Only compare the first N characters of each 'name' value
 *                                 so adapter names that extend beyond legacy-truncated length
 *                                 are not flagged. Leave blank to compare the full name.
 *
 * Dependencies (already in root node_modules):
 *   axios, fast-xml-parser, dotenv
 */

const path = require('path');
const fs   = require('fs');

// Load .env from project root (api-tester/tests-scripts → api-tester → project root)
const projectRoot = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(projectRoot, '.env') });

const axios           = require(path.join(projectRoot, 'node_modules', 'axios')).default ?? require(path.join(projectRoot, 'node_modules', 'axios'));
const { XMLParser }   = require(path.join(projectRoot, 'node_modules', 'fast-xml-parser'));
const https           = require('https');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LEGACY_BASE        = (process.env.LEGACY_API_BASE_URL  || '').replace(/\/$/, '');
const ADAPTER_BASE       = (process.env.ADAPTER_API_BASE_URL || '').replace(/\/$/, '');
const API_KEY            = process.env.COMPARE_API_KEY || '';
const IGNORE_CASE        = (process.env.SEARCH_IGNORE_CASE || '').toUpperCase() === 'Y';
const NAME_COMPARE_RAW   = parseInt(process.env.SEARCH_NAME_COMPARE_LENGTH || '', 10);
const NAME_COMPARE_LEN   = isNaN(NAME_COMPARE_RAW) || NAME_COMPARE_RAW <= 0 ? null : NAME_COMPARE_RAW;

const missing = [
  !LEGACY_BASE  && 'LEGACY_API_BASE_URL',
  !ADAPTER_BASE && 'ADAPTER_API_BASE_URL',
  !API_KEY      && 'COMPARE_API_KEY'
].filter(Boolean);

if (missing.length > 0) {
  console.error(`ERROR: Missing required .env variable(s): ${missing.join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

const DEFAULT_INPUT  = path.join(__dirname, 'input', 'onesearch-tests.csv');
const timestamp      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DEFAULT_OUTPUT = path.join(__dirname, 'output', `onesearch-results-${timestamp}.csv`);

const inputFile  = getArg('--input')  || DEFAULT_INPUT;
const outputFile = getArg('--output') || DEFAULT_OUTPUT;
const DEBUG      = process.argv.includes('--debug');

// ---------------------------------------------------------------------------
// CSV parser - RFC 4180 compliant (handles quoted fields with embedded commas/newlines)
// ---------------------------------------------------------------------------

function parseCsv(content) {
  const rows = [];
  let i = 0;
  const n = content.length;

  function parseField() {
    if (i >= n) return '';
    if (content[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let field = '';
      while (i < n) {
        if (content[i] === '"') {
          if (content[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          field += content[i++];
        }
      }
      return field;
    } else {
      // Unquoted field - read until comma or newline
      let field = '';
      while (i < n && content[i] !== ',' && content[i] !== '\n' && content[i] !== '\r') {
        field += content[i++];
      }
      return field;
    }
  }

  while (i < n) {
    const row = [];
    while (true) {
      row.push(parseField());
      if (i >= n || content[i] === '\n' || content[i] === '\r') break;
      if (content[i] === ',') i++; // skip comma between fields
    }
    // skip \r\n or \n
    if (i < n && content[i] === '\r') i++;
    if (i < n && content[i] === '\n') i++;

    if (row.some(f => f.trim() !== '')) rows.push(row);
  }
  return rows;
}

function csvRowsToObjects(rows) {
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = row[idx] !== undefined ? row[idx] : ''; });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// CSV writer - escapes fields according to RFC 4180
// ---------------------------------------------------------------------------

function escapeCsvField(value) {
  const s = String(value === null || value === undefined ? '' : value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCsvLine(fields) {
  return fields.map(escapeCsvField).join(',');
}

const OUTPUT_HEADERS = [
  'test_name', 'url_path', 'format',
  'http_status_legacy', 'http_status_adapter',
  'discrepancy_type', 'property_path',
  'legacy_type', 'adapter_type', 'detail'
];

// ---------------------------------------------------------------------------
// Schema extractor
// Recursively builds a flat map: "dotted.path" -> type string
// type is one of: string | number | boolean | null | array | object
// For arrays the item schema is walked under "path[]"
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Normalize single-item XML result objects → arrays
// fast-xml-parser returns a plain object when only one <item> exists but an
// array when multiple exist.  This pass converts any object-with-type-field
// that lives inside a parent container into a single-element array so schema
// extraction always sees an array regardless of result count.
// ---------------------------------------------------------------------------

function normalizeResultArrays(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeResultArrays);

  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (val && typeof val === 'object' && !Array.isArray(val) && val.type != null) {
      // Single result item returned as object - wrap in array for uniform handling
      result[key] = [normalizeResultArrays(val)];
    } else {
      result[key] = normalizeResultArrays(val);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Schema extractor
// Recursively builds a flat map: "dotted.path" -> type string
// type is one of: string | number | boolean | null | array | object
// counts (optional) accumulates per-type result counts: path -> number
// ---------------------------------------------------------------------------

function extractSchema(value, prefix, schema, counts) {
  if (schema === undefined) schema = {};
  if (prefix === undefined) prefix = '';

  const type = getType(value);
  if (prefix !== '') schema[prefix] = type;

  if (type === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      extractSchema(value[key], childPath, schema, counts);
    }
  } else if (type === 'array') {
    if (value.length === 0) {
      schema[`${prefix}[]`] = 'empty-array';
    } else {
      // If every item has a 'type' discriminator field (e.g. ICD9, ICD10, CPT),
      // group by that value so comparison is order-independent and apples-to-apples.
      // Merge schemas across all items of the same type to catch any field that
      // appears in any item (not just the first one).
      const itemsWithType = value.filter(item => item && typeof item === 'object' && item.type != null);
      if (itemsWithType.length === value.length) {
        const byType = new Map();
        for (const item of value) {
          const typeVal = String(item.type);
          if (!byType.has(typeVal)) byType.set(typeVal, { count: 0, merged: {} });
          byType.get(typeVal).count++;
          mergeItemSchema(item, byType.get(typeVal).merged);
        }
        for (const [typeVal, { count, merged }] of byType) {
          const typePath = `${prefix}[type=${typeVal}]`;
          if (counts) counts[typePath] = count;
          extractSchema(merged, typePath, schema, counts);
        }
      } else {
        // No type discriminator - merge schemas from all items order-independently
        const merged = {};
        for (const item of value) mergeItemSchema(item, merged);
        extractSchema(merged, `${prefix}[]`, schema, counts);
      }
    }
  }
  return schema;
}

// Merges the keys/values of `item` into `target` for union schema building.
// Non-null beats null so a field seen as a real value in any item wins.
function mergeItemSchema(item, target) {
  if (!item || typeof item !== 'object') return;
  for (const key of Object.keys(item)) {
    const incomingType = getType(item[key]);
    if (!(key in target) || (target[key] === 'null' && incomingType !== 'null')) {
      target[key] = item[key];
    }
  }
}

function getType(value) {
  if (value === null)             return 'null';
  if (Array.isArray(value))       return 'array';
  if (typeof value === 'object')  return 'object';
  if (typeof value === 'number')  return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

// ---------------------------------------------------------------------------
// Items-by-type extractor
// Walks the normalized response tree and returns a Map<typePath, item[]>.
// Mirrors the grouping logic in extractSchema so type paths are identical.
// ---------------------------------------------------------------------------

// Returns the original-case key value for display in property paths.
function getItemDisplayKey(item) {
  if (!item || typeof item !== 'object') return String(item ?? '');
  for (const field of ['code', 'id', 'ndcCode', 'icdcode', 'cptcode']) {
    if (item[field] != null) return String(item[field]);
  }
  return JSON.stringify(item);
}

// Returns a lowercase key for map-based record matching so lookup is case-insensitive.
function getItemSortKey(item) {
  return getItemDisplayKey(item).toLowerCase();
}

// Builds a key → item map for key-based record matching.
// If two items share the same key (should not happen for code-keyed results), the last one wins.
function buildItemKeyMap(items) {
  const map = new Map();
  for (const item of items) map.set(getItemSortKey(item), item);
  return map;
}

function extractItemsByType(value, prefix, results) {
  if (results === undefined) results = new Map();
  if (prefix === undefined) prefix = '';
  if (!value || typeof value !== 'object') return results;

  if (Array.isArray(value)) {
    const withType = value.filter(i => i && typeof i === 'object' && i.type != null);
    if (withType.length === value.length && value.length > 0) {
      const byType = new Map();
      for (const item of value) {
        const t = String(item.type);
        if (!byType.has(t)) byType.set(t, []);
        byType.get(t).push(item);
      }
      for (const [t, items] of byType)
        results.set(`${prefix}[type=${t}]`, items);
    } else {
      value.forEach((v, i) => extractItemsByType(v, `${prefix}[${i}]`, results));
    }
  } else {
    for (const [k, v] of Object.entries(value))
      extractItemsByType(v, prefix ? `${prefix}.${k}` : k, results);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Schema comparator
// Returns array of discrepancy objects
// ---------------------------------------------------------------------------

function compareSchemas(legacySchema, adapterSchema, testMeta) {
  const discrepancies = [];
  const allPaths = new Set([...Object.keys(legacySchema), ...Object.keys(adapterSchema)]);

  for (const p of allPaths) {
    const lt = legacySchema[p];
    const at = adapterSchema[p];

    if (lt !== undefined && at === undefined) {
      discrepancies.push({
        ...testMeta,
        discrepancy_type: 'MISSING_IN_ADAPTER',
        property_path: p,
        legacy_type: lt,
        adapter_type: '',
        detail: `Property "${p}" present in legacy response but missing in adapter response`
      });
    } else if (lt === undefined && at !== undefined) {
      discrepancies.push({
        ...testMeta,
        discrepancy_type: 'EXTRA_IN_ADAPTER',
        property_path: p,
        legacy_type: '',
        adapter_type: at,
        detail: `Property "${p}" present in adapter response but missing in legacy response`
      });
    } else if (lt !== at) {
      discrepancies.push({
        ...testMeta,
        discrepancy_type: 'TYPE_MISMATCH',
        property_path: p,
        legacy_type: lt,
        adapter_type: at,
        detail: `Property "${p}" has type "${lt}" in legacy but "${at}" in adapter`
      });
    }
  }
  return discrepancies;
}

// ---------------------------------------------------------------------------
// Content comparator (used for non-200 responses)
// Recursively walks both parsed objects and compares actual leaf values.
// Returns array of { path, legacyValue, adapterValue } for any differences.
// ---------------------------------------------------------------------------

function compareContent(legacyVal, adapterVal, path, diffs) {
  if (diffs === undefined) diffs = [];
  if (path  === undefined) path  = '';

  const lType = getType(legacyVal);
  const aType = getType(adapterVal);

  // Type mismatch at this node - record and stop descending (schema comparison covers it)
  if (lType !== aType) {
    diffs.push({
      path,
      legacyValue: `(${lType}) ${truncate(legacyVal)}`,
      adapterValue: `(${aType}) ${truncate(adapterVal)}`
    });
    return diffs;
  }

  if (lType === 'object' && legacyVal !== null) {
    const allKeys = new Set([...Object.keys(legacyVal), ...Object.keys(adapterVal)]);
    for (const key of allKeys) {
      compareContent(legacyVal[key], adapterVal[key], path ? `${path}.${key}` : key, diffs);
    }
  } else if (lType === 'array') {
    const maxLen = Math.max(legacyVal.length, adapterVal.length);
    for (let i = 0; i < maxLen; i++) {
      compareContent(legacyVal[i], adapterVal[i], `${path}[${i}]`, diffs);
    }
  } else {
    // Leaf value - compare as strings (covers string, number, boolean, null)
    const lStr = String(legacyVal  ?? '');
    const aStr = String(adapterVal ?? '');
    const lastSegment = (path || '').split('.').pop().replace(/\[.*?\]$/, '');
    let mismatch;
    if (lastSegment === 'name') {
      // For name fields: compare only the first NAME_COMPARE_LEN chars (if set),
      // and optionally case-insensitively. Always report the full original values.
      const limit = NAME_COMPARE_LEN !== null ? NAME_COMPARE_LEN : lStr.length;
      const lCmp = IGNORE_CASE ? lStr.slice(0, limit).toLowerCase() : lStr.slice(0, limit);
      const aCmp = IGNORE_CASE ? aStr.slice(0, limit).toLowerCase() : aStr.slice(0, limit);
      mismatch = lCmp !== aCmp;
    } else {
      mismatch = lStr !== aStr;
    }
    if (mismatch) {
      diffs.push({ path, legacyValue: lStr, adapterValue: aStr });
    }
  }
  return diffs;
}

function truncate(val, max) {
  if (max === undefined) max = 80;
  const s = String(val ?? '');
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ---------------------------------------------------------------------------
// Result-presence check
// Heuristic: look for common One Search result array patterns
// ---------------------------------------------------------------------------

function hasResults(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  // Walk up to 2 levels deep looking for a non-empty array
  for (const v1 of Object.values(parsed)) {
    if (Array.isArray(v1) && v1.length > 0) return true;
    if (v1 && typeof v1 === 'object') {
      for (const v2 of Object.values(v1)) {
        if (Array.isArray(v2) && v2.length > 0) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// JSON group flattener
// Both the legacy PHP API and the adapter return JSON responses where results
// are grouped under numeric string keys (e.g. {"500":[...ICD9...],"501":[...ICD10...]}).
// This is a PHP json_encode artefact: non-zero-indexed or associative-numeric PHP arrays
// serialize as objects rather than JSON arrays.
// This function converts that structure into the same flat array of typed items that the
// XML path produces after fast-xml-parser, e.g.:
//   [{ type:"ICD9", code:"250.0", name:"..." }, { type:"ICD10", code:"E11", name:"..." }]
// Items inside each group are expected to carry their own `type` field (just as XML items do).
// The numeric key is discarded — it is only a grouping container, not meaningful data.
// Applied to both sides before normalizeResultArrays so all downstream comparison logic
// (type-grouping, key-join, COUNT_INFO, VALUE_MISMATCH) behaves identically for JSON and XML.
// ---------------------------------------------------------------------------

function flattenJsonGroups(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const keys = Object.keys(parsed);
  if (keys.length === 0) return parsed;

  const numericKeys = keys.filter(k => /^\d+$/.test(k));
  if (numericKeys.length === 0) return parsed; // no numeric result groups — nothing to do

  // Flatten all numeric-keyed groups into a single items array (sorted by key for stability).
  // Each group value is an array of result items; unwrap it into the combined flat array.
  const flatItems = numericKeys
    .map(k => parseInt(k, 10))
    .sort((a, b) => a - b)
    .flatMap(k => {
      const group = parsed[String(k)];
      return Array.isArray(group) ? group : (group != null ? [group] : []);
    });

  const nonNumericKeys = keys.filter(k => !/^\d+$/.test(k));
  if (nonNumericKeys.length === 0) {
    // Pure numeric-keyed object (no metadata) — return the flat items array directly
    return flatItems;
  }
  // Mixed keys: response also contains metadata fields (e.g. clientid, rescount).
  // Keep those as-is and add the flattened items under a 'results' key so downstream
  // schema/value comparison sees both metadata and result items on both sides.
  const result = {};
  for (const k of nonNumericKeys) result[k] = parsed[k];
  result.results = flatItems;
  return result;
}

// ---------------------------------------------------------------------------
// XML parser config - mirrors fast-xml-parser settings used in the adapter
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: () => false,          // let schema extractor handle arrays naturally
  parseTagValue: false,          // keep tag values as strings so "250" and "250.0" remain distinct
  trimValues: true
});

function parseBody(body, format) {
  if (format === 'json') {
    return JSON.parse(body);
  }
  const result = xmlParser.parse(body);
  return result;
}

// ---------------------------------------------------------------------------
// HTTP call - returns { status, body, error }
// ---------------------------------------------------------------------------

async function callApi(url, xmlBody, apiKey, label) {
  try {
    const response = await axios.post(url, xmlBody, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Accept': '*/*',   // override axios default (application/json) so legacy uses URL-based format only
        'X-ODG-KEY': apiKey
      },
      validateStatus: () => true,   // don't throw on 4xx/5xx
      timeout: 30000,
      responseType: 'text',
      httpsAgent: url.startsWith('https://localhost') ? new https.Agent({ rejectUnauthorized: false }) : undefined
    });
    const contentType = response.headers['content-type'] || '';
    if (DEBUG) {
      const preview = (response.data || '').slice(0, 300).replace(/\n/g, ' ');
      console.log(`    [${label}] POST ${url}`);
      console.log(`             HTTP ${response.status} (${contentType}) → ${preview || '(empty body)'}`);
    }
    return { status: response.status, body: response.data, contentType, error: null };
  } catch (err) {
    if (DEBUG) {
      console.log(`    [${label}] POST ${url}`);
      console.log(`             NETWORK ERROR → ${err.message}`);
    }
    return { status: null, body: null, contentType: '', error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Format detection - uses Content-Type header first, falls back to body sniffing
// ---------------------------------------------------------------------------

function detectFormat(body, contentType) {
  if (contentType) {
    if (contentType.includes('application/json') || contentType.includes('text/json')) return 'json';
    if (contentType.includes('application/xml') || contentType.includes('text/xml')) return 'xml';
  }
  // Sniff body when Content-Type is absent or ambiguous (e.g. text/html)
  const trimmed = (body || '').trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  return 'xml';
}

// ---------------------------------------------------------------------------
// Process a single test row
// Returns array of result rows for the output CSV
// ---------------------------------------------------------------------------

async function processRow(row) {
  const { test_name, url_path, xml_body } = row;

  const sep = (p) => p.startsWith("/") ? p : "/" + p;
  const legacyUrl  = LEGACY_BASE  + sep(url_path);
  const adapterUrl = ADAPTER_BASE + sep(url_path);

  // format is filled in after we know what each side actually returned
  const testMeta = {
    test_name,
    url_path,
    format: '',
    http_status_legacy:  '',
    http_status_adapter: ''
  };

  const [legacyResult, adapterResult] = await Promise.all([
    callApi(legacyUrl,  xml_body, API_KEY, 'LEGACY'),
    callApi(adapterUrl, xml_body, API_KEY, 'ADAPTER')
  ]);

  testMeta.http_status_legacy  = legacyResult.status  ?? 'NETWORK_ERROR';
  testMeta.http_status_adapter = adapterResult.status ?? 'NETWORK_ERROR';

  const results = [];

  // Per-side network/timeout errors - report each independently and stop if either fails
  if (legacyResult.error) {
    results.push({
      ...testMeta,
      discrepancy_type: 'NETWORK_ERROR',
      property_path: '',
      legacy_type: 'NETWORK_ERROR',
      adapter_type: '',
      detail: `Legacy network error: ${legacyResult.error}`
    });
  }
  if (adapterResult.error) {
    results.push({
      ...testMeta,
      discrepancy_type: 'NETWORK_ERROR',
      property_path: '',
      legacy_type: '',
      adapter_type: 'NETWORK_ERROR',
      detail: `Adapter network error: ${adapterResult.error}`
    });
  }
  if (legacyResult.error || adapterResult.error) return results;

  // HTTP status mismatch
  if (legacyResult.status !== adapterResult.status) {
    results.push({
      ...testMeta,
      discrepancy_type: 'HTTP_STATUS_DIFF',
      property_path: '',
      legacy_type: String(legacyResult.status),
      adapter_type: String(adapterResult.status),
      detail: `Legacy returned HTTP ${legacyResult.status}, adapter returned HTTP ${adapterResult.status}`
    });
    return results;
  }

  // Detect actual response format from Content-Type / body for each side independently
  const legacyFormat  = detectFormat(legacyResult.body,  legacyResult.contentType);
  const adapterFormat = detectFormat(adapterResult.body, adapterResult.contentType);
  testMeta.format = legacyFormat === adapterFormat
    ? legacyFormat
    : `legacy:${legacyFormat} adapter:${adapterFormat}`;

  // Format mismatch - flag it but continue so schema differences are also captured
  if (legacyFormat !== adapterFormat) {
    results.push({
      ...testMeta,
      discrepancy_type: 'FORMAT_MISMATCH',
      property_path: '',
      legacy_type: legacyFormat,
      adapter_type: adapterFormat,
      detail: `Legacy responded with ${legacyFormat.toUpperCase()} but adapter responded with ${adapterFormat.toUpperCase()} for the same URL`
    });
  }

  // Parse both responses using their individually detected formats
  let legacyParsed = null;
  let adapterParsed = null;
  let legacyParseError = null;
  let adapterParseError = null;

  try {
    legacyParsed = parseBody(legacyResult.body, legacyFormat);
  } catch (e) {
    legacyParseError = e.message;
  }
  try {
    adapterParsed = parseBody(adapterResult.body, adapterFormat);
  } catch (e) {
    adapterParseError = e.message;
  }

  if (legacyParseError || adapterParseError) {
    results.push({
      ...testMeta,
      discrepancy_type: 'PARSE_ERROR',
      property_path: '',
      legacy_type: '',
      adapter_type: '',
      detail: [
        legacyParseError  ? `Legacy parse failed: ${legacyParseError}`  : '',
        adapterParseError ? `Adapter parse failed: ${adapterParseError}` : ''
      ].filter(Boolean).join(' | ')
    });
    return results;
  }

  // For JSON responses, flatten numeric-keyed group objects (PHP json_encode artefact) into
  // a single flat array of typed items before normalization, so the same type-grouping and
  // key-join comparison used for XML applies equally to JSON format responses.
  const legacyPrepped  = legacyFormat  === 'json' ? flattenJsonGroups(legacyParsed)  : legacyParsed;
  const adapterPrepped = adapterFormat === 'json' ? flattenJsonGroups(adapterParsed) : adapterParsed;

  // Normalize single-item XML objects to arrays FIRST so hasResults() and schema
  // extraction both see a consistent array regardless of result count.
  // (fast-xml-parser returns a plain object for a single <item> but an array for multiple)
  const legacyNormalized  = normalizeResultArrays(legacyPrepped);
  const adapterNormalized = normalizeResultArrays(adapterPrepped);

  // ----- Non-200 path: compare status, structure, AND content -----
  // For error responses the body is small and both sides must be identical.
  const bothNon200 = legacyResult.status !== 200 && adapterResult.status !== 200;
  if (bothNon200) {
    // Status already checked above (HTTP_STATUS_DIFF). Now compare body content.
    const contentDiffs = compareContent(legacyNormalized, adapterNormalized);
    for (const diff of contentDiffs) {
      results.push({
        ...testMeta,
        discrepancy_type: 'CONTENT_MISMATCH',
        property_path: diff.path || '(root)',
        legacy_type: diff.legacyValue,
        adapter_type: diff.adapterValue,
        detail: `Non-200 response body differs at "${diff.path || 'root'}": legacy="${diff.legacyValue}" adapter="${diff.adapterValue}"`
      });
    }
    // Also compare structure for non-200 so missing/extra fields are flagged
    const legacyErrSchema  = extractSchema(legacyNormalized);
    const adapterErrSchema = extractSchema(adapterNormalized);
    results.push(...compareSchemas(legacyErrSchema, adapterErrSchema, testMeta));

    if (results.length === 0) {
      results.push({
        ...testMeta,
        discrepancy_type: 'PASS',
        property_path: '',
        legacy_type: '',
        adapter_type: '',
        detail: 'Status code, structure, and content all match'
      });
    }
    return results;
  }

  // ----- 200 path: compare structure only (content differences are expected) -----
  // Result-presence check - only flag when one side has zero results and the other has some.
  // Count differences (e.g. legacy=1, adapter=5 due to elasticsearch) are expected and not flagged.
  const legacyHasResults  = hasResults(legacyNormalized);
  const adapterHasResults = hasResults(adapterNormalized);

  if (legacyHasResults !== adapterHasResults) {
    results.push({
      ...testMeta,
      discrepancy_type: 'RESULT_PRESENCE_DIFF',
      property_path: '',
      legacy_type: legacyHasResults  ? 'has-results' : 'no-results',
      adapter_type: adapterHasResults ? 'has-results' : 'no-results',
      detail: `Legacy ${legacyHasResults ? 'returned results' : 'returned no results'} but adapter ${adapterHasResults ? 'returned results' : 'returned no results'} - result count differences within same presence are acceptable`
    });
    // Still continue to compare schema if both have parsed content
  }

  // Schema comparison - only when both responses parsed successfully
  const legacyCounts  = {};
  const adapterCounts = {};
  const legacySchema  = extractSchema(legacyNormalized,  undefined, undefined, legacyCounts);
  const adapterSchema = extractSchema(adapterNormalized, undefined, undefined, adapterCounts);
  const schemaDiscrepancies = compareSchemas(legacySchema, adapterSchema, testMeta);
  results.push(...schemaDiscrepancies);

  // Type-level presence check + value comparison on common records.
  // If legacy has ≥1 result for a type and adapter has 0 → TYPE_MISSING_IN_ADAPTER (failure).
  // If both have results → compare first min(l,a) records for value equality → VALUE_MISMATCH (failure).
  // If counts differ but both have results → COUNT_INFO (informational, not a failure).
  const legacyItemsByType  = extractItemsByType(legacyNormalized);
  const adapterItemsByType = extractItemsByType(adapterNormalized);

  for (const [typePath, legacyItems] of legacyItemsByType) {
    const adapterItems = adapterItemsByType.get(typePath) || [];

    if (adapterItems.length === 0) {
      results.push({
        ...testMeta,
        discrepancy_type: 'TYPE_MISSING_IN_ADAPTER',
        property_path: typePath,
        legacy_type: String(legacyItems.length),
        adapter_type: '0',
        detail: `Type "${typePath}" has ${legacyItems.length} result(s) in legacy but 0 in adapter`
      });
    } else {
      // Key-join: only compare records whose key (code/id/etc.) exists in BOTH sides.
      // Records unique to one side are simply different results - not a failure.
      const legacyByKey  = buildItemKeyMap(legacyItems);
      const adapterByKey = buildItemKeyMap(adapterItems);
      for (const [key, legacyItem] of legacyByKey) {
        const adapterItem = adapterByKey.get(key);
        if (!adapterItem) continue; // only in legacy - different result set, skip
        const displayKey = getItemDisplayKey(legacyItem); // original case for path label
        const diffs = compareContent(legacyItem, adapterItem);
        for (const diff of diffs) {
          const fieldPath = diff.path ? `${typePath}[code=${displayKey}].${diff.path}` : `${typePath}[code=${displayKey}]`;

          // KNOWN EXCEPTION: For ICD9/ICD10 results, the `name` field may differ when the
          // search was performed by description (e.g. "diabetes") rather than by a specific code.
          // Legacy returns the matched description text as `name`; the adapter returns the
          // code's canonical name from the ODG API.  This is a permanent legacy quirk — not a
          // bug we intend to fix — because legacy is EOL.  Skip these name mismatches to avoid
          // noise in the comparison output.
          if (/\[type=ICD\d+\]/.test(typePath) && diff.path === 'name') continue;

          results.push({
            ...testMeta,
            discrepancy_type: 'VALUE_MISMATCH',
            property_path: fieldPath,
            legacy_type: diff.legacyValue,
            adapter_type: diff.adapterValue,
            detail: `Value mismatch at "${fieldPath}": legacy="${diff.legacyValue}" adapter="${diff.adapterValue}"`
          });
        }
      }
      // COUNT_INFO applies to both XML and JSON format responses.
      // Count differences are expected and not treated as failures because:
      //   1. The adapter caps results at ~500 per type; legacy may return more.
      //   2. Search engines (legacy vs ODG) can return different result sets for the same query.
      // Only records whose key exists on BOTH sides are compared for value equality.
      if (legacyItems.length !== adapterItems.length) {
        results.push({
          ...testMeta,
          discrepancy_type: 'COUNT_INFO',
          property_path: typePath,
          legacy_type: String(legacyItems.length),
          adapter_type: String(adapterItems.length),
          detail: `${typePath}: legacy returned ${legacyItems.length} result(s), adapter returned ${adapterItems.length} - count difference is expected (adapter caps at ~500 per type); compared matching-key records only, this does not fail the test`
        });
      }
    }
  }

  // No issues found - emit PASS
  if (results.length === 0) {
    results.push({
      ...testMeta,
      discrepancy_type: 'PASS',
      property_path: '',
      legacy_type: '',
      adapter_type: '',
      detail: 'Structures match'
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const maskedKey = API_KEY.length > 8
    ? API_KEY.slice(0, 4) + '****' + API_KEY.slice(-4)
    : '****';

  console.log(`\nOne Search API Comparison`);
  console.log(`  Legacy:  ${LEGACY_BASE}`);
  console.log(`  Adapter: ${ADAPTER_BASE}`);
  console.log(`  API Key: ${maskedKey}`);
  console.log(`  Input:   ${inputFile}`);
  console.log(`  Output:  ${outputFile}`);
  if (DEBUG)             console.log(`  Mode:         DEBUG (raw responses printed)`);
  if (IGNORE_CASE)      console.log(`  Case check:   DISABLED for name field (SEARCH_IGNORE_CASE=Y)`);
  if (NAME_COMPARE_LEN) console.log(`  Name compare: first ${NAME_COMPARE_LEN} characters only (SEARCH_NAME_COMPARE_LENGTH=${NAME_COMPARE_LEN})`);
  console.log();

  if (!fs.existsSync(inputFile)) {
    console.error(`ERROR: Input file not found: ${inputFile}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(inputFile, 'utf8');
  const rows       = parseCsv(csvContent);
  const testCases  = csvRowsToObjects(rows);

  if (testCases.length === 0) {
    console.error('ERROR: No test cases found in input CSV');
    process.exit(1);
  }

  console.log(`Running ${testCases.length} test case(s)...\n`);

  // Ensure output directory exists
  const outputDir = path.dirname(outputFile);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const outputLines = [toCsvLine(OUTPUT_HEADERS)];
  let totalPasses  = 0;
  let totalFails   = 0;

  for (let i = 0; i < testCases.length; i++) {
    const row = testCases[i];
    process.stdout.write(`  [${i + 1}/${testCases.length}] ${row.test_name} ... `);

    const resultRows = await processRow(row);

    const statusTag    = `[L:${resultRows[0].http_status_legacy} A:${resultRows[0].http_status_adapter}]`;
    const failingRows  = resultRows.filter(r => r.discrepancy_type !== 'PASS' && r.discrepancy_type !== 'COUNT_INFO');
    const countInfoRows = resultRows.filter(r => r.discrepancy_type === 'COUNT_INFO');
    const passed = failingRows.length === 0;
    if (passed) {
      totalPasses++;
      const note = countInfoRows.length > 0 ? ` (${countInfoRows.length} count note(s))` : '';
      process.stdout.write(`PASS ${statusTag}${note}\n`);
    } else {
      totalFails++;
      const types = [...new Set(failingRows.map(r => r.discrepancy_type))].join(', ');
      process.stdout.write(`FAIL ${statusTag} (${failingRows.length} issue(s): ${types})\n`);
    }

    for (const r of resultRows) {
      outputLines.push(toCsvLine(OUTPUT_HEADERS.map(h => r[h])));
    }
  }

  fs.writeFileSync(outputFile, outputLines.join('\n') + '\n', 'utf8');

  console.log(`\nResults: ${totalPasses} passed, ${totalFails} failed`);
  console.log(`Output:  ${outputFile}\n`);

  if (totalFails > 0) process.exit(1);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
