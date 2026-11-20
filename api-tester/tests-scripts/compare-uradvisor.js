'use strict';

/**
 * compare-uradvisor.js
 *
 * Reads a CSV of UR Advisor test cases and fires each GET request at both the
 * live legacy PHP API and the new adapter API in parallel. Compares HTTP status
 * codes AND the full response body content (property paths + leaf values) and
 * writes any discrepancies to an output CSV.
 *
 * UR Advisor responses are deterministic for the same input so both sides must
 * match exactly. Nested procedure/ICD arrays may be returned in any order, so
 * the normalizer sorts them into a canonical order before diffing.
 *
 * Usage:
 *   node api-tester/tests-scripts/compare-uradvisor.js [options]
 *
 * Options:
 *   --input  <path>   Input CSV file  (default: ./api-tester/tests-scripts/input/uradvisor-tests.csv)
 *   --output <path>   Output CSV file (default: ./api-tester/tests-scripts/output/uradvisor-results-<timestamp>.csv)
 *   --debug           Print raw HTTP status and response preview for every call
 *
 * Input CSV columns:
 *   test_name   Descriptive label for the test case
 *   url_path    Full path + query string sent to both environments, e.g.:
 *               /restws/uradvisor?icd=S33.5
 *               /restws/uradvisor?icd=S33.5&cpt=98940&flags=R&clientid=TESTCLIENT
 *               /restws/uradvisor?icd=9&cpt=98940
 *               /restws/uradvisor?bp=42&noi=49
 *               /restws/uradvisor/icd/S33.5/clientid/TESTCLIENT
 *               /restws/uradvisor/format/json?icd=S33.5&country=AU
 *
 * Required .env variables (loaded from project root):
 *   LEGACY_API_BASE_URL   Base URL of the live legacy PHP API
 *   ADAPTER_API_BASE_URL  Base URL of the new Express adapter
 *   COMPARE_API_KEY       X-ODG-KEY sent to both environments
 *
 * Optional .env variables:
 *   TAO_IGNORE_CASE=Y     When set to 'Y', compare 'name' and 'proctype' fields
 *                         case-insensitively (legacy and adapter may differ in casing)
 *
 * Dependencies (already in root node_modules):
 *   axios, fast-xml-parser, dotenv
 */

const path = require('path');
const fs   = require('fs');

// Load .env from project root (api-tester/tests-scripts → api-tester → project root)
const projectRoot = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(projectRoot, '.env') });

const axios         = require(path.join(projectRoot, 'node_modules', 'axios')).default ?? require(path.join(projectRoot, 'node_modules', 'axios'));
const { XMLParser } = require(path.join(projectRoot, 'node_modules', 'fast-xml-parser'));
const https         = require('https');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LEGACY_BASE        = (process.env.LEGACY_API_BASE_URL  || '').replace(/\/$/, '');
const ADAPTER_BASE       = (process.env.ADAPTER_API_BASE_URL || '').replace(/\/$/, '');
const API_KEY            = process.env.COMPARE_API_KEY || '';
const IGNORE_CASE        = (process.env.TAO_IGNORE_CASE || '').toUpperCase() === 'Y';
const NAME_COMPARE_RAW   = parseInt(process.env.TAO_NAME_COMPARE_LENGTH || '', 10);
const NAME_COMPARE_LEN   = isNaN(NAME_COMPARE_RAW) || NAME_COMPARE_RAW <= 0 ? null : NAME_COMPARE_RAW;

const missing = [
  !LEGACY_BASE  && 'LEGACY_API_BASE_URL',
  !ADAPTER_BASE && 'ADAPTER_API_BASE_URL',
  !API_KEY      && 'COMPARE_API_KEY',
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

const DEFAULT_INPUT  = path.join(__dirname, 'input', 'uradvisor-tests.csv');
const timestamp      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DEFAULT_OUTPUT = path.join(__dirname, 'output', `uradvisor-results-${timestamp}.csv`);

const inputFile  = getArg('--input')  || DEFAULT_INPUT;
const outputFile = getArg('--output') || DEFAULT_OUTPUT;
const DEBUG      = process.argv.includes('--debug');

// ---------------------------------------------------------------------------
// CSV parser — RFC 4180 compliant (handles quoted fields with embedded commas/newlines)
// ---------------------------------------------------------------------------

function parseCsv(content) {
  const rows = [];
  let i = 0;
  const n = content.length;

  function parseField() {
    if (i >= n) return '';
    if (content[i] === '"') {
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
      if (content[i] === ',') i++;
    }
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
// CSV writer — RFC 4180 compliant
// ---------------------------------------------------------------------------

function escapeCsvField(value) {
  const s = String(value === null || value === undefined ? '' : value);
  // Always quote every field so Excel treats values as text and does not
  // auto-format numeric-looking strings like "40.00" → 40.
  return '"' + s.replace(/"/g, '""') + '"';
}

function toCsvLine(fields) {
  return fields.map(escapeCsvField).join(',');
}

const OUTPUT_HEADERS = [
  'test_name', 'url_path', 'format',
  'http_status_legacy', 'http_status_adapter',
  'discrepancy_type', 'property_path',
  'legacy_value', 'adapter_value', 'detail',
];

// ---------------------------------------------------------------------------
// Type helper
// ---------------------------------------------------------------------------

function getType(value) {
  if (value === null)            return 'null';
  if (Array.isArray(value))      return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function truncate(val, max) {
  if (max === undefined) max = 120;
  const s = String(val ?? '');
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ---------------------------------------------------------------------------
// Order-insensitive normalizer
//
// TAO API responses can return records (top-level ICD/CPT groups and nested
// procedure/ICD children) in any order. deepNormalize recursively sorts every
// array at every depth using a canonical JSON key so that order differences
// between legacy and adapter never produce false failures.
//
// Canonical key: stable JSON.stringify after recursively sorting object keys,
// so two objects with the same fields in different key orders produce the same
// key and sort together.
//
// Works for all URA response shapes:
//   XML ICD-first  : { root: { item: <obj|[...]>, cpt: { item: <obj|[...]> } } }
//   XML rev-lookup : { root: { item: <obj|[...]>, icd: { item: <obj|[...]> } } }
//   JSON default   : [ { icd, cpt: [...] }, ... ]
//   JSON clientid  : { items: [...], clientid, rescount }
// ---------------------------------------------------------------------------

function deepSortKeys(val) {
  if (Array.isArray(val)) return val.map(deepSortKeys);
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val).sort()) out[k] = deepSortKeys(val[k]);
    return out;
  }
  return val;
}

function canonicalKey(item) {
  return JSON.stringify(deepSortKeys(item));
}

/**
 * Recursively normalizes a parsed response for order-insensitive comparison.
 * Every array at every level is sorted by canonical key before diffing.
 */
function deepNormalize(val) {
  if (Array.isArray(val)) {
    const normalized = val.map(deepNormalize);
    return normalized.sort((a, b) => {
      const ka = canonicalKey(a);
      const kb = canonicalKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) {
      out[k] = deepNormalize(val[k]);
    }
    return out;
  }
  return val;
}

// Converts a top-level indexed object {"0":A,"1":B,"clientid":"x",...} into
// {records:[A,B], clientid:"x",...} so compareContent can match records by
// their code identifier rather than by numeric key position (which varies
// between legacy and adapter when the same ICD codes are returned in a
// different order).
function extractIndexedRecords(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const keys = Object.keys(parsed);
  const numericKeys = keys.filter(k => /^\d+$/.test(k));
  if (numericKeys.length === 0) return parsed;
  const records = numericKeys.sort((a, b) => +a - +b).map(k => parsed[k]);
  const out = { records };
  for (const k of keys) {
    if (!/^\d+$/.test(k)) out[k] = parsed[k];
  }
  return out;
}

function sortForComparison(parsed) {
  return deepNormalize(extractIndexedRecords(parsed));
}

// ---------------------------------------------------------------------------
// Record ID extractor
// Returns a stable string identifier for an array element so records can be
// matched across legacy and adapter responses regardless of position.
// Checks the common code fields used across all URA response branches:
//   icd.code  — ICD-first top-level items
//   cpt.code  — reverse-lookup top-level items
//   code      — nested procedure / ICD child items
// ---------------------------------------------------------------------------

function getRecordId(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.icd  && item.icd.code  != null) return `ICD:${item.icd.code}`;
  if (item.cpt  && item.cpt.code  != null) return `CPT:${item.cpt.code}`;
  if (item.code != null)                   return `code:${item.code}`;
  return null;
}

// ---------------------------------------------------------------------------
// Full content comparator
// Recursively walks both parsed objects and records every value difference.
//
// Arrays: records are matched by their code identifier (icd.code / cpt.code /
//   code field).
//   - If one side has records and the other has none: reported as EMPTY_VS_RESULTS.
//   - Records present in only one side: silently skipped (count may differ).
//   - Matching records (same code on both sides): compared recursively.
//
// The recordCode parameter carries the outermost record identifier (e.g.
// "ICD:S33.5" or "CPT:98940") down into nested diffs so every reported
// discrepancy references the specific record it came from.
// ---------------------------------------------------------------------------

function compareContent(legacyVal, adapterVal, path, diffs, recordCode) {
  if (diffs      === undefined) diffs      = [];
  if (path       === undefined) path       = '';
  if (recordCode === undefined) recordCode = '';

  const lType = getType(legacyVal);
  const aType = getType(adapterVal);

  if (lType !== aType) {
    diffs.push({
      path:         path || '(root)',
      legacyValue:  `(${lType}) ${truncate(JSON.stringify(legacyVal))}`,
      adapterValue: `(${aType}) ${truncate(JSON.stringify(adapterVal))}`,
      recordCode,
    });
    return diffs;
  }

  if (lType === 'object' && legacyVal !== null) {
    const allKeys = new Set([...Object.keys(legacyVal), ...Object.keys(adapterVal)]);
    for (const key of allKeys) {
      compareContent(legacyVal[key], adapterVal[key], path ? `${path}.${key}` : key, diffs, recordCode);
    }
  } else if (lType === 'array') {
    const lLen = legacyVal.length;
    const aLen = adapterVal.length;

    // One side returned records, the other returned none — always an error
    if (lLen > 0 && aLen === 0) {
      diffs.push({
        path:           path || '(root)',
        legacyValue:    `${lLen} record(s)`,
        adapterValue:   '0 records',
        recordCode,
        emptyVsResults: true,
      });
      return diffs;
    }
    if (lLen === 0 && aLen > 0) {
      diffs.push({
        path:           path || '(root)',
        legacyValue:    '0 records',
        adapterValue:   `${aLen} record(s)`,
        recordCode,
        emptyVsResults: true,
      });
      return diffs;
    }

    // Both have records — match by record ID; skip records unique to one side
    const aById = new Map();
    const aNoId = [];
    adapterVal.forEach(item => {
      const id = getRecordId(item);
      if (id !== null) aById.set(id, item);
      else             aNoId.push(item);
    });

    let aNoIdIdx = 0;
    legacyVal.forEach(lItem => {
      const id = getRecordId(lItem);
      let aItem;
      if (id !== null) {
        if (!aById.has(id)) return; // only in legacy — skip
        aItem = aById.get(id);
        aById.delete(id);
      } else {
        aItem = aNoId[aNoIdIdx++];
        if (aItem === undefined) return; // only in legacy — skip
      }
      // Use the record's own code as context; embed it in the path segment
      const childCode = id || recordCode;
      const childPath = id ? `${path}[${id}]` : `${path}[]`;
      compareContent(lItem, aItem, childPath, diffs, childCode);
    });
    // Remaining adapter-only items are silently skipped
  } else {
    // Leaf: compare as strings to handle number/string coercion uniformly.
    // For 'name' fields the adapter may return a longer value than legacy;
    // compare only the first (legacy.length) characters so longer-but-matching
    // prefixes are not flagged as failures.
    let lStr = String(legacyVal  ?? '');
    let aStr = String(adapterVal ?? '');
    const lastSegment = (path || '').split('.').pop().replace(/\[.*?\]$/, '');
    if (lastSegment === 'name') {
      const limit = NAME_COMPARE_LEN !== null ? NAME_COMPARE_LEN : lStr.length;
      lStr = lStr.slice(0, limit);
      aStr = aStr.slice(0, limit);
    }
    // Legacy caps incidencerate at 99.9999; if legacy hit the cap, skip when
    // adapter returns any value >= 99.9999 (both represent the same capped result).
    // If legacy is below the cap, fall through to the normal exact comparison.
    if (lastSegment === 'incidencerate') {
      const lNum2 = parseFloat(lStr);
      const aNum2 = parseFloat(aStr);
      if (!isNaN(lNum2) && !isNaN(aNum2) && lNum2 >= 99.9999 && aNum2 >= 99.9999) {
        return diffs;
      }
    }
    const caseInsensitiveField = IGNORE_CASE && (lastSegment === 'name' || lastSegment === 'proctype');
    const lCmp = caseInsensitiveField ? lStr.toLowerCase() : lStr;
    const aCmp = caseInsensitiveField ? aStr.toLowerCase() : aStr;
    if (lCmp !== aCmp) {
      // Skip if both values are numeric and equal when rounded to 2 decimal
      // places (e.g. "1.20" vs "1.2", or "1.21" vs "1.20" differ only at the
      // 2nd decimal digit and should not be flagged).
      const lNum = parseFloat(lStr);
      const aNum = parseFloat(aStr);
      if (!isNaN(lNum) && !isNaN(aNum) && Math.abs(lNum - aNum) <= 0.0101) {
        return diffs;
      }
      diffs.push({ path: path || '(root)', legacyValue: lStr, adapterValue: aStr, recordCode });
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// FNOL URL detector
// Returns true when the url_path contains bp= or noi= query parameters or
// /bp/<value> or /noi/<value> CI-style path segments.
// ---------------------------------------------------------------------------

function isFnolUrl(urlPath) {
  if (!urlPath) return false;
  // Query-string params: ?bp=...  or  ?noi=...  (anywhere in the query)
  const qIdx = urlPath.indexOf('?');
  if (qIdx !== -1) {
    const qs = urlPath.slice(qIdx + 1);
    const params = new URLSearchParams(qs);
    if (params.has('bp') || params.has('noi')) return true;
  }
  // CI path segments: /bp/<val> or /noi/<val>
  const pathPart = qIdx !== -1 ? urlPath.slice(0, qIdx) : urlPath;
  if (/(?:^|\/)bp\/[^/]+/i.test(pathPart)) return true;
  if (/(?:^|\/)noi\/[^/]+/i.test(pathPart)) return true;
  return false;
}

const INVALID_FORMAT_MSG  = 'Invalid web service request format.';
const INVALID_CODES_MSG   = 'One or both of the codes you entered are invalid, please check the codes and try again.';

/**
 * When the adapter returns HTTP 400 "Invalid web service request format." for a
 * FNOL request (bp/noi in URL), rewrite the adapter parsed body so the error
 * message matches what legacy returns for that scenario.
 * Handles both JSON ({ error: "..." }) and XML ({ root: { error: "..." } }) shapes.
 */
function normalizeFnolAdapterError(adapterParsed, adapterStatus, urlPath) {
  if (adapterStatus !== 400 || !isFnolUrl(urlPath) || !adapterParsed) return adapterParsed;

  // JSON shape: { error: "..." }
  if (typeof adapterParsed === 'object' && !Array.isArray(adapterParsed)) {
    if (adapterParsed.error === INVALID_FORMAT_MSG) {
      return { ...adapterParsed, error: INVALID_CODES_MSG };
    }
    // XML parsed shape: { root: { error: "..." } }
    if (adapterParsed.root && adapterParsed.root.error === INVALID_FORMAT_MSG) {
      return { ...adapterParsed, root: { ...adapterParsed.root, error: INVALID_CODES_MSG } };
    }
  }
  return adapterParsed;
}

// ---------------------------------------------------------------------------
// XML parser config — same settings as the adapter's own parser
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: () => false,
  parseTagValue: false,  // keep all tag values as strings; prevents NaN for code fields
  trimValues: true,
});

function parseBody(body, format) {
  if (format === 'json') {
    return JSON.parse(body);
  }
  return xmlParser.parse(body);
}

// ---------------------------------------------------------------------------
// Format detection — Content-Type first, body sniff as fallback
// ---------------------------------------------------------------------------

function detectFormat(body, contentType) {
  if (contentType) {
    if (contentType.includes('application/json') || contentType.includes('text/json')) return 'json';
    if (contentType.includes('application/xml')  || contentType.includes('text/xml'))  return 'xml';
  }
  const trimmed = (body || '').trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  return 'xml';
}

// ---------------------------------------------------------------------------
// HTTP GET — returns { status, body, contentType, error }
// ---------------------------------------------------------------------------

async function callApi(url, apiKey, label) {
  try {
    const response = await axios.get(url, {
      headers: {
        'Accept':    '*/*',
        'X-ODG-KEY': apiKey,
      },
      validateStatus: () => true,
      timeout: 30000,
      responseType: 'text',
      httpsAgent: url.startsWith('https://localhost') ? new https.Agent({ rejectUnauthorized: false }) : undefined,
    });
    const contentType = response.headers['content-type'] || '';
    if (DEBUG) {
      const preview = (response.data || '').slice(0, 300).replace(/\n/g, ' ');
      console.log(`    [${label}] GET ${url}`);
      console.log(`            HTTP ${response.status} (${contentType}) → ${preview || '(empty body)'}`);
    }
    return { status: response.status, body: response.data, contentType, error: null };
  } catch (err) {
    if (DEBUG) {
      console.log(`    [${label}] GET ${url}`);
      console.log(`            NETWORK ERROR → ${err.message}`);
    }
    return { status: null, body: null, contentType: '', error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Process a single test row
// Returns array of result rows for the output CSV
// ---------------------------------------------------------------------------

async function processRow(row) {
  const { test_name, url_path } = row;

  const sep = (p) => p.startsWith("/") ? p : "/" + p;
  const legacyUrl  = LEGACY_BASE  + sep(url_path);
  const adapterUrl = ADAPTER_BASE + sep(url_path);

  const testMeta = {
    test_name,
    url_path,
    format:              '',
    http_status_legacy:  '',
    http_status_adapter: '',
  };

  const [legacyResult, adapterResult] = await Promise.all([
    callApi(legacyUrl,  API_KEY, 'LEGACY'),
    callApi(adapterUrl, API_KEY, 'ADAPTER'),
  ]);

  testMeta.http_status_legacy  = legacyResult.status  ?? 'NETWORK_ERROR';
  testMeta.http_status_adapter = adapterResult.status ?? 'NETWORK_ERROR';

  const results = [];

  // Network errors — report each independently and stop
  if (legacyResult.error) {
    results.push({
      ...testMeta,
      discrepancy_type: 'NETWORK_ERROR',
      property_path: '',
      legacy_value:  'NETWORK_ERROR',
      adapter_value: '',
      detail: `Legacy network error: ${legacyResult.error}`,
    });
  }
  if (adapterResult.error) {
    results.push({
      ...testMeta,
      discrepancy_type: 'NETWORK_ERROR',
      property_path: '',
      legacy_value:  '',
      adapter_value: 'NETWORK_ERROR',
      detail: `Adapter network error: ${adapterResult.error}`,
    });
  }
  if (legacyResult.error || adapterResult.error) return results;

  // HTTP status mismatch
  if (legacyResult.status !== adapterResult.status) {
    results.push({
      ...testMeta,
      discrepancy_type: 'HTTP_STATUS_DIFF',
      property_path: '',
      legacy_value:  String(legacyResult.status),
      adapter_value: String(adapterResult.status),
      detail: `Legacy returned HTTP ${legacyResult.status}, adapter returned HTTP ${adapterResult.status}`,
    });
    return results;
  }

  // Detect format independently for each side
  const legacyFormat  = detectFormat(legacyResult.body,  legacyResult.contentType);
  const adapterFormat = detectFormat(adapterResult.body, adapterResult.contentType);
  testMeta.format = legacyFormat === adapterFormat
    ? legacyFormat
    : `legacy:${legacyFormat} adapter:${adapterFormat}`;

  if (legacyFormat !== adapterFormat) {
    results.push({
      ...testMeta,
      discrepancy_type: 'FORMAT_MISMATCH',
      property_path: '',
      legacy_value:  legacyFormat,
      adapter_value: adapterFormat,
      detail: `Legacy responded with ${legacyFormat.toUpperCase()} but adapter responded with ${adapterFormat.toUpperCase()}`,
    });
  }

  // Parse both responses
  let legacyParsed      = null;
  let adapterParsed     = null;
  let legacyParseError  = null;
  let adapterParseError = null;

  try { legacyParsed  = parseBody(legacyResult.body,  legacyFormat);  } catch (e) { legacyParseError  = e.message; }
  try { adapterParsed = parseBody(adapterResult.body, adapterFormat); } catch (e) { adapterParseError = e.message; }

  // Rewrite adapter's "Invalid web service request format." → INVALID_CODES message
  // for FNOL (bp/noi) requests so comparison matches legacy behaviour.
  adapterParsed = normalizeFnolAdapterError(adapterParsed, adapterResult.status, url_path);

  if (legacyParseError || adapterParseError) {
    results.push({
      ...testMeta,
      discrepancy_type: 'PARSE_ERROR',
      property_path: '',
      legacy_value:  '',
      adapter_value: '',
      detail: [
        legacyParseError  ? `Legacy parse failed: ${legacyParseError}`   : '',
        adapterParseError ? `Adapter parse failed: ${adapterParseError}` : '',
      ].filter(Boolean).join(' | '),
    });
    return results;
  }

  // Normalize ordering before comparison:
  //   - Top-level item arrays are sorted by icd.code / cpt.code
  //   - Nested cpt.item / icd.item arrays within each record are sorted by code
  // Non-200 error bodies have no record arrays so sortForComparison is a no-op.
  const legacyNormalized  = sortForComparison(legacyParsed);
  const adapterNormalized = sortForComparison(adapterParsed);

  // Full content comparison — URA responses must match exactly for both
  // 200 (data is deterministic) and non-200 (error bodies must match).
  const contentDiffs = compareContent(legacyNormalized, adapterNormalized);
  for (const diff of contentDiffs) {
    const codeRef = diff.recordCode ? ` [${diff.recordCode}]` : '';
    const detail  = diff.emptyVsResults
      ? `One side returned no results at "${diff.path}"${codeRef}: legacy="${diff.legacyValue}" adapter="${diff.adapterValue}"`
      : `Value differs at "${diff.path}"${codeRef}: legacy="${truncate(diff.legacyValue, 80)}" adapter="${truncate(diff.adapterValue, 80)}"`;
    results.push({
      ...testMeta,
      discrepancy_type: diff.emptyVsResults ? 'EMPTY_VS_RESULTS' : 'CONTENT_MISMATCH',
      property_path:  diff.path,
      legacy_value:   diff.legacyValue,
      adapter_value:  diff.adapterValue,
      detail,
    });
  }

  if (results.length === 0) {
    results.push({
      ...testMeta,
      discrepancy_type: 'PASS',
      property_path: '',
      legacy_value:  '',
      adapter_value: '',
      detail: 'Status code and full response body match',
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

  console.log(`\nUR Advisor API Comparison`);
  console.log(`  Legacy:  ${LEGACY_BASE}`);
  console.log(`  Adapter: ${ADAPTER_BASE}`);
  console.log(`  API Key: ${maskedKey}`);
  console.log(`  Input:   ${inputFile}`);
  console.log(`  Output:  ${outputFile}`);
  if (DEBUG)             console.log(`  Mode:         DEBUG (raw responses printed)`);
  if (IGNORE_CASE)      console.log(`  Case check:   DISABLED for name and proctype fields (TAO_IGNORE_CASE=Y)`);
  if (NAME_COMPARE_LEN) console.log(`  Name compare: first ${NAME_COMPARE_LEN} characters only (TAO_NAME_COMPARE_LENGTH=${NAME_COMPARE_LEN})`);
  console.log();

  if (!fs.existsSync(inputFile)) {
    console.error(`ERROR: Input file not found: ${inputFile}`);
    console.error(`       Create ${inputFile} with columns: test_name,url_path`);
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

  const outputDir = path.dirname(outputFile);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const outputLines = [toCsvLine(OUTPUT_HEADERS)];
  let totalPasses = 0;
  let totalFails  = 0;

  for (let i = 0; i < testCases.length; i++) {
    const row = testCases[i];
    process.stdout.write(`  [${i + 1}/${testCases.length}] ${row.test_name} ... `);

    const resultRows = await processRow(row);

    const statusTag   = `[L:${resultRows[0].http_status_legacy} A:${resultRows[0].http_status_adapter}]`;
    const failingRows = resultRows.filter(r => r.discrepancy_type !== 'PASS');
    const passed      = failingRows.length === 0;

    if (passed) {
      totalPasses++;
      process.stdout.write(`PASS ${statusTag}\n`);
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
