'use strict';

/**
 * compare-reserve-calculator.js
 *
 * Reads a CSV of Reserve Calculator test cases and fires each POST request
 * at both the live legacy PHP API and the new adapter API in parallel.
 * Compares HTTP status codes AND the full response body content (property paths
 * + leaf values) and writes any discrepancies to an output CSV.
 *
 * Reserve Calculator responses are deterministic for the same input, so
 * both sides must match exactly (modulo optional URL field skipping).
 *
 * Usage:
 *   node api-tester/tests-scripts/compare-reserve-calculator.js [options]
 *
 * Options:
 *   --input  <path>   Input CSV file  (default: ./api-tester/tests-scripts/input/reserve-calculator-tests.csv)
 *   --output <path>   Output CSV file (default: ./api-tester/tests-scripts/output/reserve-calculator-results-<timestamp>.csv)
 *   --debug           Print raw HTTP status and response preview for every call
 *
 * Input CSV columns:
 *   test_name   Descriptive label for the test case
 *   url_path    Path sent to both environments, e.g. /calculator/reserve
 *               or /calculator/reserve/format/json
 *   xml_body    XML POST body for the test case
 *
 * Required .env variables (loaded from project root):
 *   LEGACY_API_BASE_URL   Base URL of the live legacy PHP API
 *   ADAPTER_API_BASE_URL  Base URL of the new Express adapter
 *   COMPARE_API_KEY       X-ODG-KEY sent to both environments (same key must exist in both)
 *
 * Optional .env variables:
 *   CALC_SKIP_URL_COMPARE=Y   When set to 'Y', skip comparison of odgurl and
 *                             deeplinkurl fields (useful when adapter generates
 *                             slightly different URL parameter ordering)
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LEGACY_BASE     = (process.env.LEGACY_API_BASE_URL  || '').replace(/\/$/, '');
const ADAPTER_BASE    = (process.env.ADAPTER_API_BASE_URL || '').replace(/\/$/, '');
const API_KEY         = process.env.COMPARE_API_KEY || '';
const SKIP_URLS       = (process.env.CALC_SKIP_URL_COMPARE || '').toUpperCase() === 'Y';

const NAME_COMPARE_RAW = parseInt(process.env.CALC_NAME_COMPARE_LENGTH || '', 10);
const NAME_COMPARE_LEN = isNaN(NAME_COMPARE_RAW) || NAME_COMPARE_RAW <= 0 ? null : NAME_COMPARE_RAW;

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

const DEFAULT_INPUT  = path.join(__dirname, 'input', 'reserve-calculator-tests.csv');
const timestamp      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DEFAULT_OUTPUT = path.join(__dirname, 'output', `reserve-calculator-results-${timestamp}.csv`);

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
// CSV writer — RFC 4180 compliant (always quote fields so Excel treats numeric
// strings as text and does not auto-format values like "40.00" → 40)
// ---------------------------------------------------------------------------

function escapeCsvField(value) {
  const s = String(value === null || value === undefined ? '' : value);
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
  if (value === null)             return 'null';
  if (Array.isArray(value))       return 'array';
  if (typeof value === 'object')  return 'object';
  if (typeof value === 'number')  return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function truncate(val, max) {
  if (max === undefined) max = 120;
  const s = String(val ?? '');
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ---------------------------------------------------------------------------
// Order-insensitive array normalizer
//
// The calculator full-output icdcodes array is sorted descending by
// meandurationdays by the legacy PHP (and should be identical in the adapter),
// but we sort canonically before diffing to avoid false positives from minor
// ordering differences.
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

// ---------------------------------------------------------------------------
// Known non-breaking paths
//
// Legacy returns an alert field on each adjustedduration dataset (bp, cp95,
// cp100) when the RAS score triggers a colour-coded alert.  The adapter does
// not yet surface these fields.  Diffs on these paths are reported as
// EXPECTED_DIFF — they are informational and do not fail the test.
// ---------------------------------------------------------------------------

// Exact paths where legacy has a value and the adapter omits the field entirely.
// XML responses are wrapped in a <root> element so paths start with "root.";
// JSON responses have no wrapper so the same fields appear without the prefix.
const EXPECTED_DIFF_PATHS = new Set([
  'root.adjustedduration.bp.alert',
  'root.adjustedduration.cp95.alert',
  'root.adjustedduration.cp100.alert',
  'adjustedduration.bp.alert',
  'adjustedduration.cp95.alert',
  'adjustedduration.cp100.alert',
]);

// Regex patterns for paths that vary by array index but are still expected diffs.
// Matches both the single-item form (no index) and the multi-item form ([N]).
const EXPECTED_DIFF_PATTERNS = [
  // stcode anywhere in the response: adapter does not have this property and
  // always returns it empty; legacy may return a value.
  /\.stcode$/,
  // alertdesc and any sub-fields: legacy may surface alertdesc fields that the
  // adapter does not yet return. Matches root.alertdesc.* (XML) and alertdesc.* (JSON).
  /^(root\.)?alertdesc(\..+)?$/,
];

// Regex patterns for paths where the adapter returns data but legacy does not.
// When the adapter returns procsummary for a CPT code that legacy omits, the
// diff is expected — legacy simply did not populate this field.
const ADAPTER_EXTRA_PATTERNS = [
  /^root\.icdcodes\.icdcode(\[\d+\])?\.procsummary/,
];

// Paths that are EXPECTED_DIFF when the adapter response contains FNOL codes
// (root.fnolcodes.icdcodes).  When FNOL is submitted alongside other codes,
// ODG API maps the FNOL code to an ICD code and includes it as an extra code
// to process, which shifts the risk score and duration values.  Legacy does
// not include the mapped FNOL ICD code in the response at all.
const FNOL_EXPECTED_DIFF_PATHS = new Set([
  'root.riskassessment.score',
  'root.adjustedduration.bp.days',
  'root.adjustedduration.cp95.days',
  'root.adjustedduration.cp100.days',
  // Reserve also includes projectedcosts which depend on duration, so those
  // may shift when FNOL codes are present.
  'root.projectedcosts.bp.indemnity',
  'root.projectedcosts.bp.medical',
  'root.projectedcosts.bp.expense',
  'root.projectedcosts.bp.total',
  'root.projectedcosts.cp95.indemnity',
  'root.projectedcosts.cp95.medical',
  'root.projectedcosts.cp95.expense',
  'root.projectedcosts.cp95.total',
  'root.projectedcosts.cp100.indemnity',
  'root.projectedcosts.cp100.medical',
  'root.projectedcosts.cp100.expense',
  'root.projectedcosts.cp100.total',
  'root.comprate',
]);

// Matches root.fnolcodes.icdcodes and any sub-paths (e.g. [0], .icdcode, etc.)
const FNOL_CODES_PATH_RE = /^root\.fnolcodes\.icdcodes/;

// Returns true if the adapter parsed response contains FNOL-mapped ICD codes.
function adapterHasFnolCodes(adapterParsed) {
  const fnolCodes = adapterParsed && adapterParsed.root && adapterParsed.root.fnolcodes && adapterParsed.root.fnolcodes.icdcodes;
  return fnolCodes !== undefined && fnolCodes !== null && fnolCodes !== '';
}

// context: optional object with { hasFnolCodes: boolean }
function isExpectedDiff(path, legacyValue, adapterValue, context) {
  // FNOL-triggered expected diffs: ODG API includes the FNOL-mapped ICD code
  // as an extra input which changes the score/duration/costs and adds fnolcodes
  // to the response; legacy never returns fnolcodes or the extra ICD's impact.
  if (context && context.hasFnolCodes) {
    if (FNOL_CODES_PATH_RE.test(path)) return true;
    if (FNOL_EXPECTED_DIFF_PATHS.has(path)) return true;
  }

  // Adapter returns procsummary for a CPT code that legacy does not populate.
  if (legacyValue === '' && adapterValue !== '') {
    if (ADAPTER_EXTRA_PATTERNS.some(re => re.test(path))) return true;
  }

  // Only classify as EXPECTED_DIFF when legacy has a value and adapter is missing it.
  if (legacyValue === '' || adapterValue !== '') return false;
  if (EXPECTED_DIFF_PATHS.has(path)) return true;
  return EXPECTED_DIFF_PATTERNS.some(re => re.test(path));
}

// ---------------------------------------------------------------------------
// URL field names that may legitimately differ between legacy and adapter
// (e.g. parameter ordering, encoding). Skipped when CALC_SKIP_URL_COMPARE=Y.
// ---------------------------------------------------------------------------

const URL_FIELDS = new Set(['odgurl', 'deeplinkurl']);

function isUrlField(path) {
  // Match the last segment of the dotted path, e.g. "root.odgurl" → "odgurl"
  const last = (path || '').split('.').pop().replace(/\[.*?\]$/, '');
  return URL_FIELDS.has(last);
}

// ---------------------------------------------------------------------------
// Full content comparator
//
// Recursively walks both parsed objects and records every value difference.
// Arrays: matched element-by-element after deepNormalize sorting.
// Optionally skips odgurl / deeplinkurl leaf fields (CALC_SKIP_URL_COMPARE=Y).
// ---------------------------------------------------------------------------

function compareContent(legacyVal, adapterVal, path, diffs) {
  if (diffs === undefined) diffs = [];
  if (path  === undefined) path  = '';

  // Skip URL fields if configured
  if (SKIP_URLS && isUrlField(path)) return diffs;

  const lType = getType(legacyVal);
  const aType = getType(adapterVal);

  if (lType !== aType) {
    diffs.push({
      path:         path || '(root)',
      legacyValue:  `(${lType}) ${truncate(JSON.stringify(legacyVal))}`,
      adapterValue: `(${aType}) ${truncate(JSON.stringify(adapterVal))}`,
    });
    return diffs;
  }

  if (lType === 'object' && legacyVal !== null) {
    const allKeys = new Set([...Object.keys(legacyVal), ...Object.keys(adapterVal)]);
    for (const key of allKeys) {
      compareContent(legacyVal[key], adapterVal[key], path ? `${path}.${key}` : key, diffs);
    }
  } else if (lType === 'array') {
    const lLen = legacyVal.length;
    const aLen = adapterVal.length;

    if (lLen > 0 && aLen === 0) {
      diffs.push({
        path:           path || '(root)',
        legacyValue:    `${lLen} item(s)`,
        adapterValue:   '0 items',
        emptyVsResults: true,
      });
      return diffs;
    }
    if (lLen === 0 && aLen > 0) {
      diffs.push({
        path:           path || '(root)',
        legacyValue:    '0 items',
        adapterValue:   `${aLen} item(s)`,
        emptyVsResults: true,
      });
      return diffs;
    }

    // Compare element-by-element (arrays have been sorted canonically before
    // this call via deepNormalize, so ordering differences are eliminated)
    const maxLen = Math.max(lLen, aLen);
    for (let idx = 0; idx < maxLen; idx++) {
      compareContent(legacyVal[idx], adapterVal[idx], `${path}[${idx}]`, diffs);
    }
  } else {
    // Leaf: compare as strings; skip if the only difference is case.
    // For 'name' fields, compare only the first NAME_COMPARE_LEN characters (if set).
    const lStr = String(legacyVal  ?? '');
    const aStr = String(adapterVal ?? '');
    const lastSegment = (path || '').split('.').pop().replace(/\[.*?\]$/, '');
    let mismatch;
    if (lastSegment === 'name' && NAME_COMPARE_LEN !== null) {
      const lCmp = lStr.slice(0, NAME_COMPARE_LEN).toLowerCase();
      const aCmp = aStr.slice(0, NAME_COMPARE_LEN).toLowerCase();
      mismatch = lCmp !== aCmp;
    } else {
      mismatch = lStr !== aStr && lStr.toLowerCase() !== aStr.toLowerCase();
    }
    if (mismatch) {
      diffs.push({ path: path || '(root)', legacyValue: lStr, adapterValue: aStr });
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// XML parser config — mirrors fast-xml-parser settings used in the adapter
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: () => false,
  parseTagValue: false,  // keep all tag values as strings; prevents numeric coercion
  trimValues: true,
  // Explicitly prevent leading-zero strings (e.g. NCCI codes "0172", "0005") from
  // being coerced to integers, which would silently drop the leading zero and make
  // "0172" compare as "172", producing false CONTENT_MISMATCH failures.
  numberParseOptions: {
    leadingZeros: false,
  },
});

function parseBody(body, format) {
  if (format === 'json') return JSON.parse(body);
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
// HTTP POST — returns { status, body, contentType, error }
// ---------------------------------------------------------------------------

async function callApi(url, xmlBody, apiKey, label) {
  try {
    const response = await axios.post(url, xmlBody, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Accept':       '*/*',   // override axios default so legacy uses URL-based format only
        'X-ODG-KEY':    apiKey,
      },
      validateStatus: () => true,   // don't throw on 4xx/5xx
      timeout: 30000,
      responseType: 'text',
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
// Process a single test row
// Returns array of result rows for the output CSV
// ---------------------------------------------------------------------------

async function processRow(row) {
  const { test_name, url_path, xml_body } = row;

  const legacyUrl  = LEGACY_BASE  + url_path;
  const adapterUrl = ADAPTER_BASE + url_path;

  const testMeta = {
    test_name,
    url_path,
    format:              '',
    http_status_legacy:  '',
    http_status_adapter: '',
  };

  const [legacyResult, adapterResult] = await Promise.all([
    callApi(legacyUrl,  xml_body, API_KEY, 'LEGACY'),
    callApi(adapterUrl, xml_body, API_KEY, 'ADAPTER'),
  ]);

  testMeta.http_status_legacy  = legacyResult.status  ?? 'NETWORK_ERROR';
  testMeta.http_status_adapter = adapterResult.status ?? 'NETWORK_ERROR';

  const results = [];

  // Network errors — report each independently and stop
  if (legacyResult.error) {
    results.push({
      ...testMeta,
      discrepancy_type: 'NETWORK_ERROR',
      property_path:    '',
      legacy_value:     'NETWORK_ERROR',
      adapter_value:    '',
      detail:           `Legacy network error: ${legacyResult.error}`,
    });
  }
  if (adapterResult.error) {
    results.push({
      ...testMeta,
      discrepancy_type: 'NETWORK_ERROR',
      property_path:    '',
      legacy_value:     '',
      adapter_value:    'NETWORK_ERROR',
      detail:           `Adapter network error: ${adapterResult.error}`,
    });
  }
  if (legacyResult.error || adapterResult.error) return results;

  // HTTP status mismatch
  if (legacyResult.status !== adapterResult.status) {
    results.push({
      ...testMeta,
      discrepancy_type: 'HTTP_STATUS_DIFF',
      property_path:    '',
      legacy_value:     String(legacyResult.status),
      adapter_value:    String(adapterResult.status),
      detail:           `Legacy returned HTTP ${legacyResult.status}, adapter returned HTTP ${adapterResult.status}`,
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
      property_path:    '',
      legacy_value:     legacyFormat,
      adapter_value:    adapterFormat,
      detail:           `Legacy responded with ${legacyFormat.toUpperCase()} but adapter responded with ${adapterFormat.toUpperCase()}`,
    });
  }

  // Parse both responses
  let legacyParsed      = null;
  let adapterParsed     = null;
  let legacyParseError  = null;
  let adapterParseError = null;

  try { legacyParsed  = parseBody(legacyResult.body,  legacyFormat);  } catch (e) { legacyParseError  = e.message; }
  try { adapterParsed = parseBody(adapterResult.body, adapterFormat); } catch (e) { adapterParseError = e.message; }

  if (legacyParseError || adapterParseError) {
    results.push({
      ...testMeta,
      discrepancy_type: 'PARSE_ERROR',
      property_path:    '',
      legacy_value:     '',
      adapter_value:    '',
      detail:           [
        legacyParseError  ? `Legacy parse failed: ${legacyParseError}`   : '',
        adapterParseError ? `Adapter parse failed: ${adapterParseError}` : '',
      ].filter(Boolean).join(' | '),
    });
    return results;
  }

  // Sort any arrays canonically before comparison to avoid false positives
  // from ordering differences in icdcodes / procsummary arrays (full output)
  const legacyNormalized  = deepNormalize(legacyParsed);
  const adapterNormalized = deepNormalize(adapterParsed);

  // Detect whether the adapter response contains FNOL-mapped ICD codes.
  // When true, diffs on fnolcodes paths and score/duration/costs fields are
  // EXPECTED_DIFF because ODG API includes the FNOL-mapped ICD as an extra
  // code to process, affecting risk score, duration, and projected costs.
  const hasFnolCodes = adapterHasFnolCodes(adapterParsed);
  const diffContext  = { hasFnolCodes };

  // Full content comparison — calculator responses are deterministic for the
  // same input so both 200 and non-200 bodies must match exactly.
  const contentDiffs = compareContent(legacyNormalized, adapterNormalized);
  for (const diff of contentDiffs) {
    let discrepancy_type;
    if (diff.emptyVsResults) {
      discrepancy_type = 'EMPTY_VS_RESULTS';
    } else if (isExpectedDiff(diff.path, diff.legacyValue, diff.adapterValue, diffContext)) {
      discrepancy_type = 'EXPECTED_DIFF';
    } else {
      discrepancy_type = 'CONTENT_MISMATCH';
    }
    const fnolDetail = hasFnolCodes && (FNOL_CODES_PATH_RE.test(diff.path) || FNOL_EXPECTED_DIFF_PATHS.has(diff.path))
      ? `Expected diff (FNOL code present): ODG API includes FNOL-mapped ICD as extra input — legacy="${truncate(diff.legacyValue, 80)}" adapter="${truncate(diff.adapterValue, 80)}"`
      : null;
    const procSummaryDetail = !fnolDetail && discrepancy_type === 'EXPECTED_DIFF' && ADAPTER_EXTRA_PATTERNS.some(re => re.test(diff.path))
      ? `Expected diff (adapter procsummary): adapter returns procsummary for CPT code that legacy omits — legacy="${truncate(diff.legacyValue, 80)}" adapter="${truncate(diff.adapterValue, 80)}"`
      : null;
    const alertdescDetail = !fnolDetail && !procSummaryDetail && discrepancy_type === 'EXPECTED_DIFF' && /^(root\.)?alertdesc(\..+)?$/.test(diff.path)
      ? `Expected diff (alertdesc): legacy returns alertdesc field that adapter does not yet surface — legacy="${truncate(diff.legacyValue, 80)}" adapter omits`
      : null;
    const detail = diff.emptyVsResults
      ? `One side returned no items at "${diff.path}": legacy="${diff.legacyValue}" adapter="${diff.adapterValue}"`
      : fnolDetail
      ? fnolDetail
      : procSummaryDetail
      ? procSummaryDetail
      : alertdescDetail
      ? alertdescDetail
      : discrepancy_type === 'EXPECTED_DIFF'
      ? `Expected non-breaking diff at "${diff.path}": legacy="${diff.legacyValue}" adapter omits this field (not yet implemented)`
      : `Value differs at "${diff.path}": legacy="${truncate(diff.legacyValue, 80)}" adapter="${truncate(diff.adapterValue, 80)}"`;
    results.push({
      ...testMeta,
      discrepancy_type,
      property_path: diff.path,
      legacy_value:  diff.legacyValue,
      adapter_value: diff.adapterValue,
      detail,
    });
  }

  if (results.length === 0) {
    results.push({
      ...testMeta,
      discrepancy_type: 'PASS',
      property_path:    '',
      legacy_value:     '',
      adapter_value:    '',
      detail:           'Status code and full response body match',
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

  console.log(`\nReserve Calculator API Comparison`);
  console.log(`  Legacy:  ${LEGACY_BASE}`);
  console.log(`  Adapter: ${ADAPTER_BASE}`);
  console.log(`  API Key: ${maskedKey}`);
  console.log(`  Input:   ${inputFile}`);
  console.log(`  Output:  ${outputFile}`);
  if (DEBUG)             console.log(`  Mode:         DEBUG (raw responses printed)`);
  if (SKIP_URLS)         console.log(`  URL compare:  DISABLED for odgurl and deeplinkurl fields (CALC_SKIP_URL_COMPARE=Y)`);
  if (NAME_COMPARE_LEN)  console.log(`  Name compare: first ${NAME_COMPARE_LEN} characters only (CALC_NAME_COMPARE_LENGTH=${NAME_COMPARE_LEN})`);
  console.log();

  if (!fs.existsSync(inputFile)) {
    console.error(`ERROR: Input file not found: ${inputFile}`);
    console.error(`       Create ${inputFile} with columns: test_name,url_path,xml_body`);
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

    const statusTag      = `[L:${resultRows[0].http_status_legacy} A:${resultRows[0].http_status_adapter}]`;
    const failingRows    = resultRows.filter(r => r.discrepancy_type !== 'PASS' && r.discrepancy_type !== 'EXPECTED_DIFF');
    const expectedDiffs  = resultRows.filter(r => r.discrepancy_type === 'EXPECTED_DIFF');
    const passed         = failingRows.length === 0;

    if (passed) {
      totalPasses++;
      const note = expectedDiffs.length > 0 ? ` (${expectedDiffs.length} expected diff(s): EXPECTED_DIFF)` : '';
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
