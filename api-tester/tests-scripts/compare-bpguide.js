'use strict';

/**
 * compare-bpguide.js
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
 *   node api-tester/tests-scripts/compare-bpguide.js [options]
 *
 * Options:
 *   --input  <path>   Input CSV file (default: ./api-tester/tests-scripts/input/bpguide-tests.csv)
 *   --output <path>   Output CSV file (default: ./api-tester/tests-scripts/output/bpguide-results-<timestamp>.csv)
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
const https         = require('https');

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

const DEFAULT_INPUT  = path.join(__dirname, 'input', 'bpguide-tests.csv');
const timestamp      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DEFAULT_OUTPUT = path.join(__dirname, 'output', `bpguide-results-${timestamp}.csv`);

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
// Recursively sorts every array at every depth by canonical key so that
// ordering differences in nested child elements (bp, activitymod, pt, chiro
// items, etc.) never produce false failures.
// Root-level items are matched by ICD prefix — see compareItemsList below.
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

// Recursively normalize a parsed response: sort every array at every depth
// by canonical key so the comparison is fully order-insensitive.
function deepNormalize(val) {
  if (Array.isArray(val)) {
    const items = val.map(deepNormalize);
    return items.sort((a, b) => {
      const ka = canonicalKey(a);
      const kb = canonicalKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) out[k] = deepNormalize(val[k]);
    return out;
  }
  return val;
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

  // Adapter returns a property / element that legacy omits entirely.
  // Legacy may not return output for certain ICD codes — treat as EXPECTED_DIFF.
  if ((legacyVal === undefined || legacyVal === null || legacyVal === '') &&
      adapterVal !== undefined && adapterVal !== null && adapterVal !== '') {
    diffs.push({
      path:         path || '(root)',
      legacyValue:  '',
      adapterValue: truncate(JSON.stringify(adapterVal)),
      type:         'EXPECTED_DIFF',
    });
    return diffs;
  }

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
      // Adapter returning more items than legacy is expected — legacy may omit records.
      const type = legacyVal.length < adapterVal.length ? 'EXPECTED_DIFF' : undefined;
      diffs.push({
        path:         `${path || '(root)'}.length`,
        legacyValue:  String(legacyVal.length),
        adapterValue: String(adapterVal.length),
        type,
      });
    }

    // For object/array element arrays, use set-based matching by canonical key.
    // Index-based comparison misaligns when adapter has extra items interspersed
    // (e.g. activitymod with an extra "Modified work" entry sorts between existing items).
    const firstElem = legacyVal[0] ?? adapterVal[0];
    if (firstElem !== null && firstElem !== undefined && typeof firstElem === 'object') {
      const usedAdapterIdx = new Set();
      for (let i = 0; i < legacyVal.length; i++) {
        const legKey = canonicalKey(legacyVal[i]);
        let matchIdx = -1;
        for (let j = 0; j < adapterVal.length; j++) {
          if (!usedAdapterIdx.has(j) && canonicalKey(adapterVal[j]) === legKey) {
            matchIdx = j; break;
          }
        }
        if (matchIdx >= 0) {
          usedAdapterIdx.add(matchIdx);
          // Exact canonical match — no diffs needed for this element
        } else {
          // No exact canonical match. Try a partial match by well-known label fields
          // (primaryRTWpath for bp, primarypath for pt/chiro, jobtype for activitymod)
          // so that field-level differences are shown rather than adapter="".
          const LABEL_KEYS = ['primaryRTWpath', 'primarypath', 'jobtype'];
          const labelKey = LABEL_KEYS.find(k =>
            Object.prototype.hasOwnProperty.call(legacyVal[i], k)
          );
          if (labelKey) {
            const legLabel = String(legacyVal[i][labelKey] ?? '');
            let partialIdx = -1;
            for (let j = 0; j < adapterVal.length; j++) {
              if (!usedAdapterIdx.has(j) &&
                  String(adapterVal[j]?.[labelKey] ?? '') === legLabel) {
                partialIdx = j; break;
              }
            }
            if (partialIdx >= 0) {
              usedAdapterIdx.add(partialIdx);
              // Partial label match — recurse to show actual field-level differences
              compareContent(legacyVal[i], adapterVal[partialIdx], `${path || '(root)'}[${i}]`, diffs);
            } else {
              // No match at all — adapter is truly missing this item
              diffs.push({
                path:         `${path || '(root)'}[${i}]`,
                legacyValue:  truncate(JSON.stringify(legacyVal[i])),
                adapterValue: '',
              });
            }
          } else {
            // No known label key — report as missing
            diffs.push({
              path:         `${path || '(root)'}[${i}]`,
              legacyValue:  truncate(JSON.stringify(legacyVal[i])),
              adapterValue: '',
            });
          }
        }
      }
      // Extra adapter items (not matched to any legacy item) → EXPECTED_DIFF
      for (let j = 0; j < adapterVal.length; j++) {
        if (!usedAdapterIdx.has(j)) {
          diffs.push({
            path:         `${path || '(root)'}[${j}]`,
            legacyValue:  '',
            adapterValue: truncate(JSON.stringify(adapterVal[j])),
            type:         'EXPECTED_DIFF',
          });
        }
      }
    } else {
      // Primitive arrays: index-based comparison
      const maxLen = Math.max(legacyVal.length, adapterVal.length);
      for (let i = 0; i < maxLen; i++) {
        compareContent(legacyVal[i], adapterVal[i], `${path}[${i}]`, diffs);
      }
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
// ICD-aware root-item comparison
//
// Root-level <item> records are matched by ICD code prefix (before the
// decimal) so that legacy "G63" correctly pairs with adapter "G63.8".
// Unmatched adapter items (extra records not in legacy) are EXPECTED_DIFF.
// Inner arrays (bp, activitymod, pt, chiro) are compared via deepNormalize
// so their internal ordering never causes false failures.
// ---------------------------------------------------------------------------

// Returns the portion of an ICD code before the decimal point, upper-cased.
function getIcdPrefix(code) {
  if (code === null || code === undefined) return '';
  return String(code).split('.')[0].toUpperCase();
}

// Extract the array of top-level <item> records from a parsed response.
// Handles: XML  → { root: { item: [...] or {...} } }
//          JSON → top-level array [...] or numeric-key object { "0": {...} }
function extractRootItems(parsed) {
  if (!parsed) return [];
  // XML (and possibly JSON) with root wrapper
  if (Object.prototype.hasOwnProperty.call(parsed, 'root')) {
    const rootVal = parsed.root;
    if (!rootVal || typeof rootVal !== 'object') return [];
    const item = rootVal.item;
    if (!item) return [];
    if (Array.isArray(item)) return item;
    if (typeof item === 'object') return [item];
    return [];
  }
  // Top-level JSON array
  if (Array.isArray(parsed)) return parsed;
  // Top-level JSON object with numeric string keys
  // (non-numeric keys like "clientid" may also be present and are ignored here)
  const keys = Object.keys(parsed);
  const numericKeys = keys.filter(k => /^\d+$/.test(k));
  if (numericKeys.length > 0) {
    return numericKeys.sort((a, b) => +a - +b).map(k => parsed[k]);
  }
  return [];
}

// Returns progressively shorter ICD strings to try as fallback candidates,
// stripping one character at a time from the right down to the root prefix.
// E.g. "M79.664" → ["M79.66", "M79.6", "M79"]
//      "724.2"   → ["724"]
//      "M79"     → []
function icdTrimCandidates(code) {
  const s = String(code ?? '').toUpperCase();
  const dotIdx = s.indexOf('.');
  const root = dotIdx >= 0 ? s.slice(0, dotIdx) : s;
  const candidates = [];
  let current = s;
  while (true) {
    current = current.slice(0, -1);
    if (current.endsWith('.')) current = current.slice(0, -1);
    if (current.length < root.length) break;
    candidates.push(current);
    if (current === root) break;
  }
  return candidates;
}

// Pair legacy items with adapter items.
// Pass 1: exact full icdcode match (case-insensitive).
// Pass 2: for unmatched legacy items, progressively trim one char at a time
//         from the right (e.g. M79.664 → M79.66 → M79.6 → M79) until a
//         match is found among remaining adapter items.
// Returns [{ legacy, adapter }] — adapter-only items have legacy=null.
function matchByIcd(legacyItems, adapterItems) {
  const pairs = [];
  const usedAdapter = new Set();
  const unmatchedLegacy = [];

  // Pass 1: exact full icdcode match
  for (const legItem of legacyItems) {
    const legCode = String((legItem && legItem.icdcode) ?? '').toUpperCase();
    let bestIdx = -1;
    if (legCode) {
      for (let i = 0; i < adapterItems.length; i++) {
        if (usedAdapter.has(i)) continue;
        if (String((adapterItems[i] && adapterItems[i].icdcode) ?? '').toUpperCase() === legCode) {
          bestIdx = i; break;
        }
      }
    }
    if (bestIdx >= 0) {
      usedAdapter.add(bestIdx);
      pairs.push({ legacy: legItem, adapter: adapterItems[bestIdx] });
    } else {
      unmatchedLegacy.push(legItem);
    }
  }

  // Pass 2: progressive-trim fallback for unmatched legacy items
  for (const legItem of unmatchedLegacy) {
    const legCode = String((legItem && legItem.icdcode) ?? '').toUpperCase();
    const candidates = icdTrimCandidates(legCode);
    let bestIdx = -1;

    for (const candidate of candidates) {
      const hasDot = candidate.includes('.');
      for (let i = 0; i < adapterItems.length; i++) {
        if (usedAdapter.has(i)) continue;
        const adpCode = String((adapterItems[i] && adapterItems[i].icdcode) ?? '').toUpperCase();
        const matches = adpCode === candidate ||
          (hasDot ? adpCode.startsWith(candidate) : adpCode.startsWith(candidate + '.'));
        if (matches) { bestIdx = i; break; }
      }
      if (bestIdx >= 0) break;
    }

    // Forward-prefix: legacy code is a prefix of the adapter code
    // e.g. legacy "C15" matches adapter "C15.0" (legacy truncates to root)
    if (bestIdx < 0 && legCode) {
      for (let i = 0; i < adapterItems.length; i++) {
        if (usedAdapter.has(i)) continue;
        const adpCode = String((adapterItems[i] && adapterItems[i].icdcode) ?? '').toUpperCase();
        if (adpCode.startsWith(legCode + '.')) { bestIdx = i; break; }
      }
    }

    if (bestIdx >= 0) {
      usedAdapter.add(bestIdx);
      pairs.push({ legacy: legItem, adapter: adapterItems[bestIdx] });
    } else {
      pairs.push({ legacy: legItem, adapter: null });
    }
  }

  // Remaining adapter-only items → will become EXPECTED_DIFF
  for (let i = 0; i < adapterItems.length; i++) {
    if (!usedAdapter.has(i)) {
      pairs.push({ legacy: null, adapter: adapterItems[i] });
    }
  }
  return pairs;
}

// Compare one matched (legacy, adapter) item pair and push diffs.
// icdcode difference  → EXPECTED_DIFF (prefix matched but full code may differ)
// name difference     → EXPECTED_DIFF (expected when icd code variant differs)
// all other fields    → deepNormalize then compareContent (order-insensitive)
// adapter-only item   → EXPECTED_DIFF (adapter returned extra record)
// legacy-only item    → CONTENT_MISMATCH (adapter is missing a record)
function comparePair(legacy, adapter, diffs) {
  const legIcd = String((legacy  && legacy.icdcode)  ?? '');
  const adpIcd = String((adapter && adapter.icdcode) ?? '');
  const icdLabel = legIcd || adpIcd || 'unknown';
  const itemPath = `item[icd=${icdLabel}]`;

  if (!legacy && adapter) {
    diffs.push({
      path:         itemPath,
      legacyValue:  '',
      adapterValue: truncate(JSON.stringify(adapter)),
      type:         'EXPECTED_DIFF',
    });
    return;
  }

  if (legacy && !adapter) {
    diffs.push({
      path:         itemPath,
      legacyValue:  truncate(JSON.stringify(legacy)),
      adapterValue: '',
    });
    return;
  }

  // Both present — compare icdcode and name first, then remaining fields
  if (legIcd !== adpIcd) {
    diffs.push({ path: `${itemPath}.icdcode`, legacyValue: legIcd, adapterValue: adpIcd, type: 'EXPECTED_DIFF' });
  }

  const legName = String(legacy.name  ?? '');
  const adpName = String(adapter.name ?? '');
  if (legName !== adpName) {
    diffs.push({ path: `${itemPath}.name`, legacyValue: legName, adapterValue: adpName, type: 'EXPECTED_DIFF' });
  }

  // Compare all other fields; deepNormalize makes inner array comparison
  // order-insensitive so ordering differences are never flagged.
  const legRest = Object.assign({}, legacy);
  const adpRest = Object.assign({}, adapter);
  delete legRest.icdcode; delete legRest.name;
  delete adpRest.icdcode; delete adpRest.name;

  compareContent(deepNormalize(legRest), deepNormalize(adpRest), itemPath, diffs);
}

// Top-level ICD-aware comparison of two parsed bpguide responses.
// When no root items are detected (error/empty response) falls back to generic
// compareContent so error-message mismatches are still caught.
function compareItemsList(legacyParsed, adapterParsed) {
  const diffs        = [];
  const legacyItems  = extractRootItems(legacyParsed);
  const adapterItems = extractRootItems(adapterParsed);

  if (legacyItems.length === 0 && adapterItems.length === 0) {
    return compareContent(deepNormalize(legacyParsed), deepNormalize(adapterParsed));
  }

  const pairs = matchByIcd(legacyItems, adapterItems);
  for (const { legacy, adapter } of pairs) {
    comparePair(legacy, adapter, diffs);
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
  parseTagValue: false,  // keep all values as strings to preserve trailing zeros (e.g. 726.10 not 726.1)
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
      responseType: 'text',
      httpsAgent: url.startsWith('https://localhost') ? new https.Agent({ rejectUnauthorized: false }) : undefined
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

  const sep = (p) => p.startsWith('/') ? p : '/' + p;
  const legacyUrl  = LEGACY_BASE  + sep(url_path);
  const adapterUrl = ADAPTER_BASE + sep(url_path);

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

  // ICD-aware comparison: root items are matched by ICD prefix so that
  // "G63" (legacy) correctly pairs with "G63.8" (adapter), extra adapter
  // items are EXPECTED_DIFF, and inner arrays are order-insensitive via
  // deepNormalize. Falls back to generic compareContent for error responses.
  const contentDiffs = compareItemsList(legacyParsed, adapterParsed);

  for (const diff of contentDiffs) {
    const discrepancy_type = diff.type || 'CONTENT_MISMATCH';
    const detail = discrepancy_type === 'EXPECTED_DIFF'
      ? `Expected diff at "${diff.path}": legacy="${truncate(diff.legacyValue, 80)}" adapter="${truncate(diff.adapterValue, 80)}"`
      : `Value differs at "${diff.path}": legacy="${truncate(diff.legacyValue, 80)}" adapter="${truncate(diff.adapterValue, 80)}"`;
    results.push({
      ...testMeta,
      discrepancy_type,
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

    const statusTag     = `[L:${resultRows[0].http_status_legacy} A:${resultRows[0].http_status_adapter}]`;
    const failingRows   = resultRows.filter(r => r.discrepancy_type !== 'PASS' && r.discrepancy_type !== 'EXPECTED_DIFF');
    const expectedDiffs = resultRows.filter(r => r.discrepancy_type === 'EXPECTED_DIFF');
    const passed        = failingRows.length === 0;

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
