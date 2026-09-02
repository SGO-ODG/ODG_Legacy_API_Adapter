'use strict';

/**
 * compare-one-search.js
 *
 * Reads a CSV of One Search test cases and fires each POST request at both
 * the live legacy API and the new adapter API in parallel. Compares the
 * structural schema of both responses (property names, nesting, data types -
 * NOT actual values) and writes any discrepancies to an output CSV.
 *
 * Usage:
 *   node api-tester/tests-scripts/compare-one-search.js [options]
 *
 * Options:
 *   --input  <path>   Input CSV file (default: ./api-tester/tests-scripts/input/one-search-tests.csv)
 *   --output <path>   Output CSV file (default: ./api-tester/tests-scripts/output/one-search-results-<timestamp>.csv)
 *   --debug           Print raw HTTP status and response preview for every call (useful for diagnosing failures)
 *
 * Required .env variables (loaded from project root):
 *   LEGACY_API_BASE_URL   Base URL of the live legacy PHP API
 *   ADAPTER_API_BASE_URL  Base URL of the new Express adapter
 *   COMPARE_API_KEY       X-ODG-KEY sent to both environments (same key must exist in both)
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

const DEFAULT_INPUT  = path.join(__dirname, 'input', 'one-search-tests.csv');
const timestamp      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DEFAULT_OUTPUT = path.join(__dirname, 'output', `one-search-results-${timestamp}.csv`);

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
    if (lStr !== aStr) {
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
// XML parser config - mirrors fast-xml-parser settings used in the adapter
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: () => false,          // let schema extractor handle arrays naturally
  parseTagValue: true,           // parse numeric values as numbers
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
      responseType: 'text'
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

  const legacyUrl  = LEGACY_BASE  + url_path;
  const adapterUrl = ADAPTER_BASE + url_path;

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

  // Normalize single-item XML objects to arrays FIRST so hasResults() and schema
  // extraction both see a consistent array regardless of result count.
  // (fast-xml-parser returns a plain object for a single <item> but an array for multiple)
  const legacyNormalized  = normalizeResultArrays(legacyParsed);
  const adapterNormalized = normalizeResultArrays(adapterParsed);

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

  // Per-type count differences are informational - not a failure.
  // e.g. legacy returned 1 ICD9 result, adapter returned 4 (elasticsearch may surface more).
  const allTypePaths = new Set([...Object.keys(legacyCounts), ...Object.keys(adapterCounts)]);
  for (const typePath of allTypePaths) {
    const lCount = legacyCounts[typePath] ?? 0;
    const aCount = adapterCounts[typePath] ?? 0;
    if (lCount !== aCount) {
      results.push({
        ...testMeta,
        discrepancy_type: 'COUNT_INFO',
        property_path: typePath,
        legacy_type: String(lCount),
        adapter_type: String(aCount),
        detail: `${typePath}: legacy returned ${lCount} result(s), adapter returned ${aCount} - count difference is expected and does not fail the test`
      });
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
  if (DEBUG) console.log(`  Mode:    DEBUG (raw responses printed)`);
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
