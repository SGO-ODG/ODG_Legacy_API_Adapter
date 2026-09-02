'use strict';

/**
 * compare-bp-guide.js
 *
 * Reads a CSV of Best Practice Guide test cases and fires each GET request at
 * both the live legacy API and the new adapter API in parallel. Compares HTTP
 * status codes AND the full response body content (property paths + leaf values)
 * and writes any discrepancies to an output CSV.
 *
 * Unlike compare-one-search.js (which does schema-only comparison on 200 responses
 * because search results legitimately differ), bpguide responses are deterministic
 * for the same ICD input so both sides must match exactly.
 *
 * Usage:
 *   node api-tester/tests-scripts/compare-bp-guide.js [options]
 *
 * Options:
 *   --input  <path>   Input CSV file (default: ./api-tester/tests-scripts/input/bp-guide-tests.csv)
 *   --output <path>   Output CSV file (default: ./api-tester/tests-scripts/output/bp-guide-results-<timestamp>.csv)
 *   --debug           Print raw HTTP status and response preview for every call
 *
 * Input CSV columns:
 *   test_name   Descriptive label for the test case
 *   url_path    Full path + query string sent to both environments
 *               e.g. /restws/bpguide?icd=724.2
 *                    /restws/bpguide?icd=M54.5&clientid=TESTCLIENT
 *                    /restws/bpguide/icd/724.2/clientid/ABC    (CI path-style)
 *                    /restws/bpguide/format/json?icd=724.2     (JSON format)
 *
 * NOTE: bp and noi (FNOL) path-variable test cases are intentionally excluded
 * because that branch is not supported in the adapter.
 *
 * Required .env variables (loaded from project root):
 *   LEGACY_API_BASE_URL   Base URL of the live legacy PHP API
 *   ADAPTER_API_BASE_URL  Base URL of the new Express adapter
 *   COMPARE_API_KEY       X-ODG-KEY sent to both environments
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

const LEGACY_BASE  = (process.env.LEGACY_API_BASE_URL  || '').replace(/\/$/, '');
const ADAPTER_BASE = (process.env.ADAPTER_API_BASE_URL || '').replace(/\/$/, '');
const API_KEY      = process.env.COMPARE_API_KEY || '';

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

const DEFAULT_INPUT  = path.join(__dirname, 'input', 'bp-guide-tests.csv');
const timestamp      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DEFAULT_OUTPUT = path.join(__dirname, 'output', `bp-guide-results-${timestamp}.csv`);

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
// CSV writer - RFC 4180 compliant
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
  'legacy_value', 'adapter_value', 'detail'
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
// Order-insensitive normalizer
//
// bpguide records and their nested section items (bp, activitymod, pt, chiro)
// may be returned in a different order by legacy vs adapter. Before comparing,
// sort everything into a deterministic canonical order so compareContent does
// not flag order-only differences.
//
// XML shape (fast-xml-parser):
//   single record : { root: { item: { icdcode, bp: { item: {...} }, ... } } }
//   multiple      : { root: { item: [ {...}, {...} ], clientid?, rescount? } }
//   nested single : bp.item is an object; nested multiple: bp.item is an array
//
// JSON shape:
//   without clientid : [ { icdcode, bp: [...], ... } ]
//   with clientid    : { "0": {...}, "1": {...}, rescount, clientid }
// ---------------------------------------------------------------------------

// Recursively sort object keys for a stable canonical string representation.
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

// Sort an array by canonicalKey; leave non-arrays unchanged.
function sortArrayIfArray(val) {
  if (!Array.isArray(val)) return val;
  return [...val].sort((a, b) => {
    const ka = canonicalKey(a);
    const kb = canonicalKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// Sort a single XML record's nested section arrays (bp/activitymod/pt/chiro).
// Each section is either null, { item: obj } (single), or { item: [obj, ...] } (multiple).
function sortXmlRecord(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = { ...rec };
  for (const field of ['bp', 'activitymod', 'pt', 'chiro']) {
    const section = rec[field];
    if (section && typeof section === 'object' && section.item !== undefined) {
      out[field] = { ...section, item: sortArrayIfArray(section.item) };
    }
  }
  return out;
}

// Sort top-level XML records by icdcode, then sort each record's nested sections.
function sortXmlResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.root) return parsed;
  const root    = parsed.root;
  const rawItem = root.item;
  let sortedItem;
  if (Array.isArray(rawItem)) {
    sortedItem = [...rawItem]
      .sort((a, b) => String(a?.icdcode ?? '') < String(b?.icdcode ?? '') ? -1 : 1)
      .map(sortXmlRecord);
  } else if (rawItem && typeof rawItem === 'object') {
    // Single record - no array sort needed, just sort its nested sections
    sortedItem = sortXmlRecord(rawItem);
  } else {
    sortedItem = rawItem;
  }
  return { ...parsed, root: { ...root, item: sortedItem } };
}

// Sort a single JSON record's nested section arrays.
function sortJsonRecord(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = { ...rec };
  for (const field of ['bp', 'activitymod', 'pt', 'chiro']) {
    if (Array.isArray(rec[field])) out[field] = sortArrayIfArray(rec[field]);
  }
  return out;
}

// Sort top-level JSON records by icdcode, then sort each record's nested sections.
function sortJsonResponse(parsed) {
  if (Array.isArray(parsed)) {
    return [...parsed]
      .sort((a, b) => String(a?.icdcode ?? '') < String(b?.icdcode ?? '') ? -1 : 1)
      .map(sortJsonRecord);
  }
  // With clientid: { "0": {...}, "1": {...}, rescount, clientid }
  if (parsed && typeof parsed === 'object') {
    const recordEntries = Object.entries(parsed).filter(([k]) => /^\d+$/.test(k));
    const metaEntries   = Object.entries(parsed).filter(([k]) => !/^\d+$/.test(k));
    const sorted = recordEntries
      .map(([, v]) => v)
      .sort((a, b) => String(a?.icdcode ?? '') < String(b?.icdcode ?? '') ? -1 : 1)
      .map(sortJsonRecord);
    const out = {};
    sorted.forEach((rec, i) => { out[String(i)] = rec; });
    for (const [k, v] of metaEntries) out[k] = v;
    return out;
  }
  return parsed;
}

function sortForComparison(parsed, format) {
  if (format === 'json') return sortJsonResponse(parsed);
  return sortXmlResponse(parsed);
}

// ---------------------------------------------------------------------------
// Full content comparator
// Recursively walks both parsed objects and records every value difference.
// Arrays: compared element-by-element; length mismatch is reported.
// Objects: union of keys from both sides is walked.
// ---------------------------------------------------------------------------

function compareContent(legacyVal, adapterVal, path, diffs) {
  if (diffs === undefined) diffs = [];
  if (path  === undefined) path  = '';

  const lType = getType(legacyVal);
  const aType = getType(adapterVal);

  if (lType !== aType) {
    diffs.push({
      path: path || '(root)',
      legacyValue:  `(${lType}) ${truncate(JSON.stringify(legacyVal))}`,
      adapterValue: `(${aType}) ${truncate(JSON.stringify(adapterVal))}`
    });
    return diffs;
  }

  if (lType === 'object' && legacyVal !== null) {
    const allKeys = new Set([...Object.keys(legacyVal), ...Object.keys(adapterVal)]);
    for (const key of allKeys) {
      compareContent(legacyVal[key], adapterVal[key], path ? `${path}.${key}` : key, diffs);
    }
  } else if (lType === 'array') {
    if (legacyVal.length !== adapterVal.length) {
      diffs.push({
        path: `${path || '(root)'}.length`,
        legacyValue:  String(legacyVal.length),
        adapterValue: String(adapterVal.length)
      });
    }
    const maxLen = Math.max(legacyVal.length, adapterVal.length);
    for (let i = 0; i < maxLen; i++) {
      compareContent(legacyVal[i], adapterVal[i], `${path}[${i}]`, diffs);
    }
  } else {
    // Leaf: compare as strings to handle number/string coercion uniformly
    const lStr = String(legacyVal  ?? '');
    const aStr = String(adapterVal ?? '');
    if (lStr !== aStr) {
      diffs.push({ path: path || '(root)', legacyValue: lStr, adapterValue: aStr });
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// XML parser config - same settings as the adapter's own parser
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: () => false,
  parseTagValue: true,
  trimValues: true
});

function parseBody(body, format) {
  if (format === 'json') {
    return JSON.parse(body);
  }
  return xmlParser.parse(body);
}

// ---------------------------------------------------------------------------
// Format detection - Content-Type first, body sniff as fallback
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
// HTTP GET - returns { status, body, contentType, error }
// ---------------------------------------------------------------------------

async function callApi(url, apiKey, label) {
  try {
    const response = await axios.get(url, {
      headers: {
        'Accept':    '*/*',
        'X-ODG-KEY': apiKey
      },
      validateStatus: () => true,
      timeout: 30000,
      responseType: 'text'
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

  const legacyUrl  = LEGACY_BASE  + url_path;
  const adapterUrl = ADAPTER_BASE + url_path;

  const testMeta = {
    test_name,
    url_path,
    format:              '',
    http_status_legacy:  '',
    http_status_adapter: ''
  };

  const [legacyResult, adapterResult] = await Promise.all([
    callApi(legacyUrl,  API_KEY, 'LEGACY'),
    callApi(adapterUrl, API_KEY, 'ADAPTER')
  ]);

  testMeta.http_status_legacy  = legacyResult.status  ?? 'NETWORK_ERROR';
  testMeta.http_status_adapter = adapterResult.status ?? 'NETWORK_ERROR';

  const results = [];

  // Network errors - report each independently and stop
  if (legacyResult.error) {
    results.push({
      ...testMeta,
      discrepancy_type: 'NETWORK_ERROR',
      property_path: '',
      legacy_value:  'NETWORK_ERROR',
      adapter_value: '',
      detail: `Legacy network error: ${legacyResult.error}`
    });
  }
  if (adapterResult.error) {
    results.push({
      ...testMeta,
      discrepancy_type: 'NETWORK_ERROR',
      property_path: '',
      legacy_value:  '',
      adapter_value: 'NETWORK_ERROR',
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
      legacy_value:  String(legacyResult.status),
      adapter_value: String(adapterResult.status),
      detail: `Legacy returned HTTP ${legacyResult.status}, adapter returned HTTP ${adapterResult.status}`
    });
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
      detail: `Legacy responded with ${legacyFormat.toUpperCase()} but adapter responded with ${adapterFormat.toUpperCase()}`
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
      property_path: '',
      legacy_value:  '',
      adapter_value: '',
      detail: [
        legacyParseError  ? `Legacy parse failed: ${legacyParseError}`   : '',
        adapterParseError ? `Adapter parse failed: ${adapterParseError}` : ''
      ].filter(Boolean).join(' | ')
    });
    return results;
  }

  // Normalize ordering before comparison: records are sorted by icdcode and
  // nested section arrays (bp, activitymod, pt, chiro) are sorted by canonical
  // key so order differences don't produce false failures.
  // Non-200 error bodies have no record arrays so sortForComparison is a no-op.
  const legacyNormalized  = sortForComparison(legacyParsed,  legacyFormat);
  const adapterNormalized = sortForComparison(adapterParsed, adapterFormat);

  // Full content comparison - bpguide responses must match exactly for both
  // 200 (guideline data is deterministic) and non-200 (error bodies must match).
  const contentDiffs = compareContent(legacyNormalized, adapterNormalized);
  for (const diff of contentDiffs) {
    results.push({
      ...testMeta,
      discrepancy_type: 'CONTENT_MISMATCH',
      property_path:  diff.path,
      legacy_value:   diff.legacyValue,
      adapter_value:  diff.adapterValue,
      detail: `Value differs at "${diff.path}": legacy="${truncate(diff.legacyValue, 80)}" adapter="${truncate(diff.adapterValue, 80)}"`
    });
  }

  if (results.length === 0) {
    results.push({
      ...testMeta,
      discrepancy_type: 'PASS',
      property_path: '',
      legacy_value:  '',
      adapter_value: '',
      detail: 'Status code and full response body match'
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

  console.log(`\nBest Practice Guide API Comparison`);
  console.log(`  Legacy:  ${LEGACY_BASE}`);
  console.log(`  Adapter: ${ADAPTER_BASE}`);
  console.log(`  API Key: ${maskedKey}`);
  console.log(`  Input:   ${inputFile}`);
  console.log(`  Output:  ${outputFile}`);
  if (DEBUG) console.log(`  Mode:    DEBUG (raw responses printed)`);
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
