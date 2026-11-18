---
name: findings-report
description: Generate an HTML discrepancy findings report from a comparison CSV results file
produced by any compare-*.js script (e.g. compare-bpguide.js, compare-uradvisor.js).
Use this skill whenever the user asks to create a findings report, discrepancy report,
or comparison analysis from a CSV output file in api-tester/tests-scripts/output/.
---

# API Comparison Findings Report Generator

Reads a comparison results CSV from `api-tester/tests-scripts/output/` and produces a
self-contained HTML report saved to `docs/<endpoint>-discrepancy-report.html`.
The report is styled for Confluence (open in browser → select all → copy → paste).

---

## Input CSV schema

All compare-*.js scripts write a CSV with these columns:

| Column | Description |
|--------|-------------|
| `test_name` | `<CustomerCode>-TEST-N` — customer prefix is everything before the first `-TEST-` |
| `url_path` | Full path including `/format/json` when applicable |
| `format` | `xml` or `json` |
| `http_status_legacy` | HTTP status returned by legacy PHP API |
| `http_status_adapter` | HTTP status returned by adapter |
| `discrepancy_type` | Type tag written by the compare script. The full set varies by endpoint — see Phase 3 step 3 for per-script attribution. Universal types (all scripts): `PASS`, `HTTP_STATUS_DIFF`, `CONTENT_MISMATCH`, `FORMAT_MISMATCH`, `PARSE_ERROR`, `NETWORK_ERROR`. Additional types: `EXPECTED_DIFF` (bpguide, comorbidity, reserve), `EMPTY_VS_RESULTS` (uradvisor, comorbidity, reserve), `WITHIN_THRESHOLD` (comorbidity, reserve), `COUNT_INFO` (onesearch), `RESULT_PRESENCE_DIFF` / `MISSING_IN_ADAPTER` / `EXTRA_IN_ADAPTER` / `TYPE_MISMATCH` / `TYPE_MISSING_IN_ADAPTER` / `VALUE_MISMATCH` (onesearch only). |
| `property_path` | JSON path of the differing field (empty for PASS / HTTP_STATUS_DIFF) |
| `legacy_value` | Value from legacy API |
| `adapter_value` | Value from adapter |
| `detail` | Human-readable description |

**Note**: One test case produces multiple CSV rows when there are multiple differing fields.
Count unique `test_name` values (not rows) for the total test count. A test is PASS only if
**all** its rows have `discrepancy_type = PASS`.

---

## Phase 1 — Read and parse the CSV

The CSV can be large (500+ rows). Always read in chunks of ~200 lines using `offset`/`limit`
on the Read tool. Collect all rows before starting analysis.

For each row, extract the **customer code** from `test_name`:
- Split on `-TEST-` → everything before the first occurrence is the customer code
- Example: `EmpireLife-ODGDEMO-TEST-1` → customer `EmpireLife-ODGDEMO`

Build these aggregate structures:
1. **Per-test status map** — `Map<test_name, 'PASS'|'FAIL'>`: a test fails if any row has
   `discrepancy_type !== 'PASS'`
2. **Per-customer stats** — `{ total, pass, fail }` counts using the per-test map
3. **Discrepancy rows** — all rows where `discrepancy_type !== 'PASS'`

---

## Phase 2 — Categorize discrepancies by action owner

The report is **not** a raw dump of CSV discrepancy types. It is a decision-support document
for SEAD and Product teams. Group the failing tests into named items based on their
**root cause and who must act**, not by `discrepancy_type`.

### Status buckets

Each item in the report belongs to exactly one of these statuses:

| Status | Badge class | When to use |
|--------|-------------|-------------|
| `PRODUCT ACCEPTED` | `.badge-accepted` | Product confirmed adapter behavior is correct; adapter returns a different result than legacy but the difference is intentional or an improvement. Document for record only. |
| `PENDING SEAD` | `.badge-pending` | Root cause is a content publishing gap or missing data in ODG v1.2 — SEAD team must verify or publish the content. |
| `PENDING PRODUCT DECISION` | `.badge-pending` | The adapter could handle this multiple ways; product must choose. Present 2–3 concrete options. |
| `PENDING PRODUCT CONFIRMATION` | `.badge-pending` | Adapter behavior diverges from legacy in a way that is likely acceptable, but product must explicitly confirm before cutover. |

### What to include in the report

**Always include:**
- Any discrepancy where root cause requires SEAD team verification (content publishing gap,
  ICD codes absent from the ODG v1.2 dataset, missing AU content)
- Any discrepancy where root cause requires a Product decision on behavior options
  (e.g. AU vs US country scope default, result count cap acceptability)
- Product-confirmed decisions for record — even when the adapter is "correct" and no fix is
  needed, stakeholders need to see that the difference was reviewed and accepted
- Errors still pending resolution at report generation time (adapter bugs not yet fixed)

**Always exclude:**
- Adapter-code defects already fixed before the comparison run — these tests now pass and
  there is nothing for SEAD or Product to decide
- Internal QA actions (re-run tests, update test harness scripts)
- References to adapter source files, TypeScript functions, or line numbers
- Raw CSV discrepancy counts that are fully explained by a confirmed architectural difference
  (e.g. Elasticsearch vs SQL search result count differences that product has already accepted)

### Common root cause patterns to look for

| Pattern | Likely status | Notes |
|---------|---------------|-------|
| Legacy 404/500 → Adapter 200 (Elasticsearch finds results SQL REGEXP missed) | PRODUCT ACCEPTED | Adapter improvement, not a regression |
| Legacy 200 → Adapter 404 for AU-specific ICD codes | PENDING SEAD or PENDING PRODUCT DECISION | Check whether content gap or missing country scope parameter |
| Legacy 200 → Adapter 404 for 5-digit ICD-9 procedure codes or malformed codes | PRODUCT ACCEPTED | Drop-digit fallback is confirmed not implemented in adapter |
| ICD sub-code normalization (legacy resolves to parent, adapter returns sub-code) | PRODUCT ACCEPTED | Exact-match behavior confirmed correct |
| ODG v1.2 returns more `activitymod` / content entries than legacy | PENDING SEAD | Could be publishing gap or draft content |
| Result count capped at ~500 vs unbounded legacy result sets | PENDING PRODUCT CONFIRMATION | ODG API design limit |

---

## Phase 3 — Build the HTML report

Generate a self-contained HTML file. Use this exact structure and styling:

### Document shell

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>[Endpoint] — Adapter Comparison Discrepancy Report</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      font-size: 14px;
      color: #172B4D;
      max-width: 1100px;
      margin: 40px auto;
      padding: 0 24px;
      line-height: 1.6;
    }
    h1 { font-size: 26px; border-bottom: 2px solid #DFE1E6; padding-bottom: 8px; margin-top: 32px; }
    h2 { font-size: 20px; border-bottom: 1px solid #DFE1E6; padding-bottom: 6px; margin-top: 36px; color: #0052CC; }
    h3 { font-size: 16px; margin-top: 24px; color: #253858; }
    p  { margin: 10px 0; }
    ul, ol { margin: 10px 0 10px 24px; }
    li { margin: 4px 0; }
    code {
      background: #F4F5F7;
      border: 1px solid #DFE1E6;
      border-radius: 3px;
      padding: 1px 5px;
      font-family: "Courier New", monospace;
      font-size: 12px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 14px 0;
      font-size: 13px;
    }
    th {
      background: #0052CC;
      color: #fff;
      text-align: left;
      padding: 8px 10px;
    }
    td {
      border: 1px solid #DFE1E6;
      padding: 6px 10px;
      vertical-align: top;
    }
    tr:nth-child(even) td { background: #F4F5F7; }
    .badge {
      display: inline-block;
      border-radius: 3px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: bold;
      white-space: nowrap;
    }
    .badge-pass     { background: #E3FCEF; color: #006644; border: 1px solid #57D9A3; }
    .badge-fail     { background: #FFEBE6; color: #BF2600; border: 1px solid #FF5630; }
    .badge-warn     { background: #FFFAE6; color: #974F0C; border: 1px solid #FFE380; }
    .badge-info     { background: #DEEBFF; color: #0747A6; border: 1px solid #4C9AFF; }
    .badge-accepted { background: #FFFAE6; color: #974F0C; border: 1px solid #FFE380; }
    .badge-pending  { background: #EAE6FF; color: #403294; border: 1px solid #998DD9; }
    .note {
      background: #DEEBFF;
      border-left: 4px solid #0052CC;
      padding: 10px 14px;
      border-radius: 3px;
      margin: 12px 0;
    }
    .warn {
      background: #FFFAE6;
      border-left: 4px solid #FF8B00;
      padding: 10px 14px;
      border-radius: 3px;
      margin: 12px 0;
    }
    .pending {
      background: #EAE6FF;
      border-left: 4px solid #6554C0;
      padding: 10px 14px;
      border-radius: 3px;
      margin: 12px 0;
    }
    .summary-grid {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      margin: 16px 0;
    }
    .summary-card {
      flex: 1;
      min-width: 140px;
      border: 1px solid #DFE1E6;
      border-radius: 4px;
      padding: 14px 16px;
      text-align: center;
    }
    .summary-card .number { font-size: 32px; font-weight: bold; }
    .summary-card .label  { font-size: 12px; color: #5E6C84; margin-top: 4px; }
    .num-green  { color: #006644; }
    .num-red    { color: #BF2600; }
    .num-orange { color: #974F0C; }
    .num-blue   { color: #0052CC; }
    .num-purple { color: #403294; }
    hr { border: none; border-top: 1px solid #DFE1E6; margin: 32px 0; }
  </style>
</head>
<body>
  <!-- Report content goes here -->
</body>
</html>
```

### Section order

1. **Page title + meta line** — `<h1>` with endpoint name, then `<p>` showing API path,
   report date, source CSV. Add a brief sentence: "This report covers only open items
   requiring clarification or a decision from the SEAD team or Product. It includes
   product-confirmed behaviors for record."

2. `<hr />`

3. **Discrepancy Type Reference** `<h2>`
   - Opening paragraph: one sentence explaining that each test fires both the legacy PHP API
     and the adapter in parallel and tags output rows with one of the types listed below.
     Also note which types are excluded from the failure count for this endpoint
     (e.g. `EXPECTED_DIFF`, `WITHIN_THRESHOLD`, `COUNT_INFO`).
   - **Reference table** — one row per type **that applies to this endpoint**, with columns:
     **Type | Counts as Failure? | What It Means | Detection Logic**.
     Include only the rows applicable to this endpoint; omit rows for types that are never
     emitted for it. All 16 known types and their attributes are (for skill-internal use —
     do NOT include the "applies to" grouping headings or script names in the HTML output):

     **Universal — all endpoints:**
     - `PASS` — No — status + full body identical — no diffs produced
     - `HTTP_STATUS_DIFF` — Yes — different HTTP status codes; body comparison skipped — `legacyResult.status !== adapterResult.status`
     - `CONTENT_MISMATCH` — Yes — field value differs or adapter missing a record legacy returned (for onesearch: applies to non-200 error responses only; 200 responses use schema-only structural comparison) — recursive comparator; any leaf diff not overridden to a non-failure type
     - `FORMAT_MISMATCH` — Yes — legacy returns XML, adapter returns JSON (or vice versa) — `detectFormat(legacy) !== detectFormat(adapter)` after both calls succeed
     - `PARSE_ERROR` — Yes — response body cannot be parsed as XML or JSON — `JSON.parse()` or `XMLParser.parse()` throws
     - `NETWORK_ERROR` — Yes — HTTP request failed at network level (timeout, connection refused) — `axios.get()` itself throws

     **bpguide, comorbidity, reserve endpoints only:**
     - `EXPECTED_DIFF` — No (accepted) — known intentional adapter-vs-legacy difference: adapter returns more content, an exact sub-code where legacy returned the parent code, alert/stcode fields added by ODG v1.2, adapter-side procsummary extras, or FNOL-triggered score/duration/cost diffs — set by explicit path/pattern allow-lists

     **uradvisor, comorbidity, reserve endpoints only:**
     - `EMPTY_VS_RESULTS` — Yes — one side's array has records and the other has none — triggered when `legacy.length > 0 && adapter.length === 0` or vice versa for a matched section

     **comorbidity, reserve endpoints only:**
     - `WITHIN_THRESHOLD` — No (accepted) — numeric value differs but the absolute difference is within the configured variance threshold — applied to `riskassessment.score`, `adjustedduration.*.days`, `adjustedsummaryguidelines.*` paths

     **onesearch endpoint only** (200-response schema comparison — onesearch compares result structure, not field values, for successful responses):
     - `COUNT_INFO` — No (informational) — result count differs but both sides returned results — recorded for transparency; does not count as a failure because Elasticsearch vs SQL result sets differ by design
     - `RESULT_PRESENCE_DIFF` — Yes — one side returned results for a search type/section, the other returned empty — legacy has results but adapter has none, or vice versa, for a given section
     - `MISSING_IN_ADAPTER` — Yes — a record (by code/id key) present in legacy results is absent from adapter results — key-join match attempted; record not found in adapter side
     - `EXTRA_IN_ADAPTER` — Yes — a record present in adapter results has no corresponding legacy record — key-join match attempted; record not found in legacy side
     - `TYPE_MISMATCH` — Yes — both sides returned the section/type but its structural shape (required properties) differs — schema property check on matched section
     - `TYPE_MISSING_IN_ADAPTER` — Yes — a search result type/section is present in legacy response but absent from adapter response entirely — section key present in legacy but missing from adapter top-level result
     - `VALUE_MISMATCH` — Yes — a key-matched record was found on both sides but a field value differs — only checked for fields in the structural key-join comparison (not full content diff)

   - **This Run summary table** — compact table with columns: **Discrepancy Type | Unique Test Cases | Counts as Failure? | Notes**. Count unique test names per type (not rows). Include a row for each type that this script can produce; show 0 for types with no occurrences. End with a Total row. Do NOT include individual test names or ICD codes — this section must stay small.

4. `<hr />`

5. **Executive Summary** `<h2>`
   - `.summary-grid` stat cards:
     - Total Tests (`.num-blue`)
     - PASS with % (`.num-green`)
     - Product Accepted count (`.num-orange`)
     - Pending SEAD count (`.num-purple`)
     - Pending Product Decision/Confirmation count (`.num-purple`, if any)
   - One-paragraph plain-English summary
   - Per-customer summary table: **Customer | Tests Run | PASS | Product Accepted | Pending SEAD | Pending Product**
     (omit Pending Product column if zero for all customers)

4. `<hr />`

5. **Open Items** `<h2>`
   - One `<h3>` per item, numbered, with status badge inline:
     ```html
     <h3>Item N — Short title (K tests) &nbsp;<span class="badge badge-accepted">PRODUCT ACCEPTED</span></h3>
     ```
     or:
     ```html
     <h3>Item N — Short title &nbsp;<span class="badge badge-pending">PENDING SEAD</span></h3>
     ```
   - Description paragraph explaining root cause in plain English
   - Callout block:
     - `.warn` for PRODUCT ACCEPTED items (yellow callout stating the product decision)
     - `.pending` for PENDING items (purple callout stating the open question and action required)
     - `.note` for additional informational notes
   - Detail table — columns depend on item type:
     - For HTTP status items: Test | Customer | Legacy Status | Adapter Status | Reason
     - For content items: Test | Customer | ICD Code | Property | Legacy Value | Adapter Value
     - For count/structural items: Direction | Cause | Example
   - `<hr />` between items

6. **Summary** `<h2>`
   - Table: **Item | Affected Tests | Affected Customer(s) | Action Required | Owner | Status**
   - Owner is one of: **Product**, **SEAD team**, **Customer communication**, **ODG API Team**
   - Status uses `.badge-accepted` or `.badge-pending` badge

### Value display rules
- Truncate `legacy_value` / `adapter_value` to 120 chars in table cells; show full value on hover via `title` attribute
- Wrap values in `<code>` tags
- Empty strings display as `<em style="color:#999">(empty)</em>`
- `null` / missing display as `—`

---

## Phase 4 — Save and report

- Save to `docs/<endpoint>-discrepancy-report.html`
  - Derive `<endpoint>` from the CSV filename: `legacy-customer-bpguide-results.csv` → `bpguide`
- Do NOT commit the file (it's a generated artifact)
- Tell the user: "Open the file in a browser, select all (Ctrl+A), copy (Ctrl+C),
  then paste into your Confluence page."

---

## Quick reference — known CSV filenames

| CSV file | Endpoint | Report name |
|----------|----------|-------------|
| `legacy-customer-bpguide-results.csv` | `bpguide` | `bpguide-discrepancy-report.html` |
| `legacy-customer-uradvisor-results.csv` | `uradvisor` | `uradvisor-discrepancy-report.html` |
| `legacy-customer-onesearch-results.csv` | `onesearch` | `onesearch-discrepancy-report.html` |
| `legacy-customer-calculator-results.csv` | `calculator` | `calculator-discrepancy-report.html` |
| `legacy-customer-ndcadvisor-results.csv` | `ndcadvisor` | `ndcadvisor-discrepancy-report.html` |

---

## Reference reports

The following completed reports in `docs/` are examples of the correct format and content
philosophy. Read them before generating a new report to ensure consistency in tone,
structure, callout content, and CSS class usage:

| Report | Items | Open issues still pending |
|--------|-------|--------------------------|
| `docs/uradvisor-discrepancy-report.html` | 1 PRODUCT ACCEPTED, 1 PENDING SEAD | C49.21/C49.22 AU content gap (SEAD team) |
| `docs/bpguide-discrepancy-report.html` | 2 PRODUCT ACCEPTED, 1 PENDING SEAD | Activity modifiers G90.5/M79.629/M79.64 (SEAD team) |
| `docs/onesearch-discrepancy-report.html` | 1 PRODUCT ACCEPTED, 1 PENDING PRODUCT DECISION, 1 PENDING PRODUCT CONFIRMATION | MLC-TEST-33 AU country scope (Product); result count cap (Product) |
