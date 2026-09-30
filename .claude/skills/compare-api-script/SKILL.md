---
name: compare-api-script
description: Create a new side-by-side comparison test script for an ODG Legacy API Adapter
endpoint. Use this skill whenever the user asks to create, add, or build a comparison script
(or "compare script") for any legacy web service endpoint such as bpguide, uradvisor,
onesearch, calculator, or similar. Produces both the .js script and the input CSV.
---

# ODG Legacy API Comparison Script Generator

Creates a `compare-<endpoint>.js` script in `api-tester/tests-scripts/` and a matching
`input/<endpoint>-tests.csv`. Modelled after existing scripts in that folder — always read
the closest existing script first and adapt rather than writing from scratch.

---

## Reference scripts (read the right one first)

| Script | Use as template when… |
|--------|----------------------|
| `api-tester/tests-scripts/compare-bp-guide.js` | Endpoint is **GET**, response is **deterministic** (same input → same output), full content + status must match |
| `api-tester/tests-scripts/compare-one-search.js` | Endpoint is **POST with XML body**, response is **non-deterministic** (search results vary), schema-only comparison on 200 |

---

## Phase 1 — Gather endpoint facts

Before writing a line of code, answer these questions by reading the relevant source files:

1. **HTTP method** — GET or POST?
   - Source: `src/routes/restws.ts` or `src/routes/calculator.ts`

2. **Request format** — query params, CI path segments, or XML body?
   - GET endpoints: query params and/or CI-style path segments (e.g. `/icd/724.2/clientid/ABC`)
   - POST endpoints: XML body (CSV columns: `test_name`, `url_path`, `xml_body`)

3. **Response determinism** — given the same input, do both APIs always return identical data?
   - Deterministic (guidelines, calculators) → **full content comparison**
   - Non-deterministic (search results) → **schema-only comparison**

4. **Order sensitivity** — can records or nested array items arrive in different order?
   - Read the transformer (`src/transformers/<endpoint>.ts`) to find natural sort keys
   - Records: sort by a stable identifier (e.g. `icdcode`, `code`)
   - Nested arrays: sort by canonical JSON key if no natural key exists

5. **Excluded test cases** — any branches NOT implemented in the adapter?
   - Check `src/transformers/<endpoint>.ts` for TODO/confirm comments and unimplemented branches
   - Document exclusions clearly in the script header

6. **Format support** — does the endpoint support `/format/json`?
   - Check the route handler for `/format/json` path variant

---

## Phase 2 — Script structure

Copy the closest reference script and make targeted changes. Key areas to update:

### Always change
- File header comment (endpoint name, method, options, CSV columns, exclusion notes)
- Default input/output filenames (`<endpoint>-tests.csv`, `<endpoint>-results-<timestamp>.csv`)
- Console header line (`Best Practice Guide API Comparison` → new name)
- `callApi` function: `axios.get` vs `axios.post` (POST needs `xml_body` from row + `Content-Type: application/xml`)
- `processRow`: use `row.xml_body` for POST; no body for GET

### For full content comparison (GET/deterministic — based on compare-bp-guide.js)
- Keep `compareContent` recursive walker as-is
- Keep `sortForComparison` + all sort helpers if order-insensitive comparison is needed
- Update sort key in `sortXmlResponse`/`sortJsonResponse` to match the record identifier field
- Update `sortXmlRecord`/`sortJsonRecord` nested field names to match the endpoint's response schema

### For schema-only comparison (POST/non-deterministic — based on compare-one-search.js)
- Keep `extractSchema`, `compareSchemas`, `normalizeResultArrays`, `extractItemsByType`, `flattenJsonGroups` as-is
- Keep `hasResults` heuristic or update it to match the endpoint's result array structure
- Three discrepancy types govern type-grouped results:
  - `TYPE_MISSING_IN_ADAPTER` (**failure**) — legacy has ≥1 result for a type (e.g. ICD9), adapter has 0
  - `VALUE_MISMATCH` (**failure**) — a field value differs in a common record; both arrays are sorted by stable key (`code`, `id`, `ndcCode`, `icdcode`, `cptcode`, or canonical JSON fallback) before positional comparison so result order differences don't cause false mismatches
  - `COUNT_INFO` (**info, not a failure**) — both sides have results for the type but counts differ; extra records beyond the common set are skipped

### JSON format responses — PHP numeric-key flattening (applies to all endpoints)

The legacy PHP API (and the adapter, which mirrors it) serializes JSON results using numeric
database category codes as top-level object keys, e.g.:

```json
{ "clientid": "TESTCLIENT", "rescount": "3", "500": [...ICD9 items...], "501": [...ICD10 items...] }
```

This is a PHP `json_encode` artefact: PHP arrays that are non-zero-indexed or associatively
keyed serialize as objects with numeric string keys rather than JSON arrays. The comparison
script handles this via `flattenJsonGroups(parsed)`, applied only for JSON format responses
before `normalizeResultArrays` runs:

- **Detects** any top-level keys matching `/^\d+$/` (numeric strings like "500", "501")
- **Flattens** all numeric-keyed group arrays into a single combined items array
- **Pure numeric object** (no metadata): returns the flat array directly
- **Mixed keys** (metadata like `clientid`/`rescount` + numeric groups): keeps non-numeric
  fields as-is and collects the flattened items under a `results` key

After flattening, items carry their own `type` field (e.g. `"type":"ICD10"`) just like XML
items do, so `extractItemsByType`, type-grouping, key-join value comparison, COUNT_INFO and
VALUE_MISMATCH all apply identically for JSON and XML.

**When adding a new compare script for any endpoint that supports `/format/json`:**
1. Copy `flattenJsonGroups` from `compare-one-search.js` verbatim — no changes needed
2. In `processRow`, apply it before `normalizeResultArrays`:
   ```js
   const legacyPrepped  = legacyFormat  === 'json' ? flattenJsonGroups(legacyParsed)  : legacyParsed;
   const adapterPrepped = adapterFormat === 'json' ? flattenJsonGroups(adapterParsed) : adapterParsed;
   const legacyNormalized  = normalizeResultArrays(legacyPrepped);
   const adapterNormalized = normalizeResultArrays(adapterPrepped);
   ```
3. The function is a no-op when the response has no numeric keys, so it is safe to apply
   unconditionally for all JSON responses — it will not affect well-structured responses.

### Output CSV headers
- Full content: `test_name, url_path, format, http_status_legacy, http_status_adapter, discrepancy_type, property_path, legacy_value, adapter_value, detail`
- Schema-only: `test_name, url_path, format, http_status_legacy, http_status_adapter, discrepancy_type, property_path, legacy_type, adapter_type, detail`

---

## Phase 3 — Input CSV test cases

File: `api-tester/tests-scripts/input/<endpoint>-tests.csv`
This directory is gitignored — the CSV is local only.

### Standard test cases to include for every endpoint

| Category | What to test |
|----------|-------------|
| Happy path | Single valid input, minimal params |
| Multiple inputs | Tilde-separated codes or multiple query params |
| With clientid | Verify `rescount` + `clientid` echo behavior |
| CI path-style | `/endpoint/param/value` if supported |
| `/format/json` | JSON output variant if supported |
| `/format/json` + multiple | JSON with multiple inputs |
| No results | Unknown/invalid code that returns a no-results error |
| Missing required param | Omit the required param entirely |

### Additional test cases for `onesearch` (POST XML)

Because One Search supports multiple database types and both description and exact-code queries,
include the following categories in `one-search-tests.csv`:

| Category | Examples |
|----------|---------|
| Description search per database | `text=diabetes` (ICD9), `text=back pain` (ICD10), `text=aspirin` (NDC), `text=carpal tunnel` (CPT) |
| Exact code per database | `text=A37` (ICD10), `text=J45` (ICD10), `text=250.0` (ICD9), `text=724.2` (ICD9), `text=AA020` (CPT), `text=27447` (CPT) |
| Multi-database combos | ICD9+ICD10, ICD9+CPT, ICD10+NDC, ICD9+ICD10+CPT, all four databases |
| With clientid | XML + clientid, JSON + clientid |
| JSON format variants | JSON for ICD9, ICD10, CPT, NDC, multi-db, exact code, all-databases |
| No results | Nonsense string in each format (XML + JSON) for different database combos |

### Known value comparison exceptions for `onesearch`

**ICD9/ICD10 `name` field** — When a One Search is performed by *description* (e.g. `text=diabetes`),
legacy returns the matched description text as the `name` field for each ICD result.
The adapter returns the code's canonical name from the ODG API instead.
This divergence is **intentional and permanent** — legacy is EOL and this will not be fixed.
The comparison script already skips `VALUE_MISMATCH` for `name` when `typePath` matches
`/\[type=ICD\d+\]/`. Do not add these as failing test cases; they are expected noise.
Exact-code searches (e.g. `text=A37`) do not trigger this issue because only one code matches.

**Result count differences (`COUNT_INFO`)** — This rule applies equally to both XML and JSON
format responses. Count differences between legacy and adapter are **never failures**:
- The adapter caps results at ~500 per type; legacy may return more for broad searches.
- The two search engines (legacy PHP vs ODG API) may return different result sets for the same query.
- Either side can have more records than the other.
Only records whose key (`code`, `icdcode`, `cptcode`, `ndcCode`, or `id`) exists on **both** sides
are compared for value equality. Extra records on either side are silently skipped.

### Do NOT add
- Test cases for branches explicitly excluded from the adapter (e.g. FNOL `bp`/`noi` for bpguide)
- Auth key tests (the script uses a single `COMPARE_API_KEY` for all rows — invalid-key testing is done manually)

---

## Phase 4 — Env vars

All comparison scripts share the same three `.env` variables (already in `.env.example`):

```dotenv
LEGACY_API_BASE_URL=http://legacy-host
ADAPTER_API_BASE_URL=http://localhost:3000
COMPARE_API_KEY=<your-api-key>
```

No new env vars needed unless the endpoint requires a special header.

---

## Phase 5 — Branch and commit

1. Create a new feature branch: `feat/compare-<endpoint>-script`
2. Commit the script: `feat: add <EndpointName> comparison test script`
3. Do NOT commit the input CSV (it is gitignored under `api-tester/tests-scripts/input/`)

---

## Quick reference — endpoint facts already known

| Endpoint | Method | Comparison | Order-insensitive | Excluded cases |
|----------|--------|------------|-------------------|----------------|
| `onesearch` | POST XML | Schema + value-match on common records (`TYPE_MISSING_IN_ADAPTER`=fail; `VALUE_MISMATCH`=fail; `COUNT_INFO`=info) | Type-grouped by `type` field; records key-joined by `code`/`id`/`ndcCode`/`icdcode`/`cptcode` | ICD9/ICD10 `name` mismatch on description searches is skipped (EOL exception — see above) |
| `bpguide` | GET | Full content | Records by `icdcode`; nested `bp/activitymod/pt/chiro` items by canonical key | `bp`/`noi` FNOL params |
| `uradvisor` | GET | Full content | Records by ICD/CPT code | - |
| `calculator/comorbidity` | POST XML | Full content | — | — |
| `calculator/reserve` | POST XML | Full content | — | — |
