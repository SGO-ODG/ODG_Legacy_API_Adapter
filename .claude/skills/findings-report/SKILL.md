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
| `discrepancy_type` | `PASS`, `HTTP_STATUS_DIFF`, `CONTENT_MISMATCH`, or `EXPECTED_DIFF` |
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

## Phase 2 — Categorize discrepancies

Group failing rows into **categories** based on `discrepancy_type` and `property_path`:

| Category | Filter rule | Badge color |
|----------|-------------|-------------|
| HTTP Status Differences | `discrepancy_type === 'HTTP_STATUS_DIFF'` | red (`#dc3545`) |
| Content Mismatches | `discrepancy_type === 'CONTENT_MISMATCH'` | orange (`#fd7e14`) |
| Expected Differences | `discrepancy_type === 'EXPECTED_DIFF'` | blue (`#0d6efd`) |

Within each category, sub-group by `property_path` to show patterns.

For **priority actions**, classify as:
- **High**: HTTP status mismatches (customer-visible failures) and CONTENT_MISMATCH on core
  fields (status codes, numeric values)
- **Medium**: CONTENT_MISMATCH on formatting or optional fields
- **Low**: EXPECTED_DIFF (known acceptable divergences)

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
    .badge-pass    { background: #E3FCEF; color: #006644; border: 1px solid #57D9A3; }
    .badge-fail    { background: #FFEBE6; color: #BF2600; border: 1px solid #FF5630; }
    .badge-warn    { background: #FFFAE6; color: #974F0C; border: 1px solid #FFE380; }
    .badge-info    { background: #DEEBFF; color: #0747A6; border: 1px solid #4C9AFF; }
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
    .error {
      background: #FFEBE6;
      border-left: 4px solid #FF5630;
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
    hr { border: none; border-top: 1px solid #DFE1E6; margin: 32px 0; }
  </style>
</head>
<body>
  <!-- Report content goes here -->
</body>
</html>
```

### Section order

1. **Page title + meta line** — `<h1>` with endpoint name, then `<p>` showing API path, report date, source CSV
2. `<hr />`
3. **Executive Summary** — `<h2>`, then `.summary-grid` stat cards (Total Test Rows, PASS, HTTP Status Mismatch, Content Mismatch, Expected Diffs), followed by per-customer summary table (Customer | Tests Run | PASS | HTTP Status Mismatch | Content Mismatch | Expected Diffs)
4. `<hr />`
5. **Discrepancy Categories** — `<h2>`, then one `<h3>` per category with badge count, description paragraph, `.error`/`.warn` callout, detailed table, `.note` recommendation
6. `<hr />`
7. **Summary of Recommended Actions** — `<h2>`, table (Priority | Category | Action | Owner) using `.badge-fail`/`.badge-warn`/`.badge-info` for priority
8. Footer `<section>` with Additional Notes `<ul>`

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
