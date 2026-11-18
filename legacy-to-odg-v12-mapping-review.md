# Legacy PHP to ODG API v1.2 mapping review

Status: **draft for manual correction**. It combines the read-only PHP controller/model analysis from `C:\Saurabh\MyApps\Apache24\odgci_3.1.11` with the published ODG Swagger v1.2 contract. `TODO / confirm` means the Swagger document does not establish a safe one-to-one mapping. The separate Express repository must configure this location through `LEGACY_PHP_REFERENCE_ROOT` for development/test contract verification only; it is not a runtime dependency.

## Common adapter contract

### Legacy request

```http
X-ODG-KEY: <legacy-customer-key>
<no Accept header is used for legacy response format selection>
```

The adapter validates the legacy key, account status, service availability, subscription dates, and subscription output mode using the existing PostgreSQL tables. Customers do **not** send OAuth tokens.

### New ODG request

```http
Authorization: Bearer <adapter-client-credentials-token>
X-ApiVersion: 1.2
Accept: application/json
```

The adapter always requests JSON upstream. Legacy POST bodies are always XML. Serialize the transformed legacy response as XML unless the legacy path ends exactly in `/format/json`; only that path suffix produces JSON.

## Available legacy-validation data

Only these tables are available to the Express application:

| Table | Used for |
|---|---|
| `companymaster` | Find the customer by `webserviceKey`; reject `disabled=Y`; authenticate the customer. Company no longer holds OAuth credentials. |
| `companywebservice` | Validate `companyCode` plus legacy `webserviceCode`; enforce `subscriptionStartDate`/`subscriptionEndDate`; read `outputMode`. |

The service code is supplied by a static route registry in Express. This temporary bridge supports only already subscribed customers and performs no customer/subscription provisioning. It has no maintenance mode. `webserviceusage` is a write-only usage log table (populated by `usageLoggerMiddleware`). `companymaster` and `companywebservice` are read-only; ODG API logs are the primary audit source.
## Per-customer OAuth token reuse

After legacy key and subscription validation, obtain an OAuth client-credentials token using the shared `ODG_API_CLIENT_ID` and `ODG_API_CLIENT_SECRET` from environment configuration. Do **not** request a token for every legacy request.

- Cache key: a non-secret deterministic key built from token URL, client ID identifier, audience, and scopes (no `companyCode` — credentials are shared).
- Cache value: bearer token and calculated expiry; never log or return either the token or client secret.
- Expiry: use OAuth `expires_in` (for example 3600 or 7200 seconds) and refresh before expiry using a bounded safety skew, such as 60 seconds or 10% of the token lifetime, whichever is smaller.
- Concurrency: one in-flight token request per cache key; concurrent legacy requests await that result rather than issuing duplicate token requests.
- 401 handling: invalidate that customer's cached token, acquire one replacement token, and retry the upstream request once only.
- Multi-instance deployment: use a shared secure cache if token reuse is required across Express instances; an in-memory cache is sufficient only for a single instance.
### Standard compatibility rules

- Preserve legacy status codes and `{ "error": "..." }` error bodies; do not pass upstream error bodies through.
- Preserve request-driven `clientid` echoing and legacy `rescount` behavior.
- Preserve legacy query names and XML casing externally; use Swagger v1.2 query/property names only upstream. Every legacy POST body is XML. XML is the default response and `/format/json` is the only JSON response selector. Transform ODG data into the complete legacy response object before either serialization; never directly serialize or pass through ODG data. Legacy field names, nesting, wrappers, singleton/array behavior, conditional omissions, XML element order, and date/number/currency formatting are part of the public contract.
- All JSON below is illustrative structural JSON, not a guarantee of a live-data response.
## Shared legacy error contract — mandatory

The Express adapter must run legacy validation **before** calling ODG API v1.2 and return the exact legacy HTTP status and JSON/XML error description. For the active configuration, `rest_auth`, HTTPS forcing, AJAX-only mode, IP lists, method access checks, and rate limits are disabled; legacy API-key and subscription validation is enabled using only the two tables above.

| Condition | Status | Exact legacy error body |
|---|---:|---|
| Missing or unknown `X-ODG-KEY` | 403 | `{ "error": "Invalid web service key." }` |
| Account disabled | 403 | `{ "error": "Your account is disabled." }` |
| Requested service is absent from the static legacy-service registry | 403 | `{ "error": "Invalid, requested web service does not exist." }` |
| Company has no service subscription | 403 | `{ "error": "You are not subscribed for requested web service." }` |
| Subscription has not started | 403 | `{ "error": "Your subscription will start from MM/DD/YYYY." }` |
| Subscription expired | 403 | `{ "error": "Your subscription is expired on MM/DD/YYYY." }` |
| Unsupported HTTP method for a valid legacy resource | 405 | `{ "error": "Unknown method" }` |

If those currently disabled `RestController` options are enabled later, preserve these framework responses too: 403 `Unsupported protocol`; 406 `Only AJAX requests are allowed`; 401 `This API key does not have access to the requested controller`; 401 `This API key has reached the time limit for this method`; 401 `This API key does not have enough permissions`; 401 `This IP Address has reached the time limit for this method`; 401 `IP denied`; and 401 `IP unauthorized`. The PHP-only `Web service is down for maintenance.` condition is not reproduced because this bridge has no maintenance mode.

Endpoint-level validation errors remain endpoint-specific, such as 400 `Invalid web service request format.`, 400 `Invalid XML, unable to load...`, and the endpoint's existing 404 no-result description. Upstream OAuth, timeout, network, 4xx, and 5xx errors must be mapped to the approved legacy endpoint error—not exposed directly.

## 1. UR Advisor â€” `GET /restws/uradvisor`

### Legacy request

```http
GET /restws/uradvisor?icd=M54.5~M54.50&cpt=99213&flags=RG&country=US&clientid=claim-123
X-ODG-KEY: <key>
```

| Legacy condition/parameter | New ODG candidate | Review state |
|---|---|---|
| ICD-driven request | `GET /tao/icds?icd=<codes>&proc=<cpt>&Flags=RG&Country=US&ClientId=claim-123&FullOutput=<bool>` | Confirmed endpoint and parameter names. |
| `icd=9` or `icd=10` plus CPT/PROC | `GET /tao/procedures?proc=<codes>&resulttype=1` (ICD9) or `&resulttype=2` (ICD10) | **Resolved:** `resulttype=1` for ICD9 lookup, `resulttype=2` for ICD10 lookup. Response `items[].procedure` is the CPT/proc parent; `items[].icds[]` are the ICD children with stats. |
| `country=AU` and `proc` | `/tao/icds` with `proc=<auProcCodes>&Country=AU` | Confirmed. AU uses `proc` key for procedures; response uses `proc` key (not `cpt`) in legacy output. |
| `bp`/`noi` FNOL-only request | `GET /tao/fnol/{bpCode}/{noiCode}` | **Resolved:** the FNOL endpoint returns full TAO data in `items[].taoDataItems[]`. Those items are flattened and fed directly into `buildUraRecords` — no secondary `/tao/icds` call is needed. Empty result → 400 `INVALID_CODES`. |
| ICD request with `bp`/`noi` fallback | `/tao/icds` first; if 404 or no procedure results, fallback to `/tao/fnol` | **Resolved:** fallback triggers when `/tao/icds` returns 404 or all groups have empty procedure arrays. |
| `flags=R/G/Y/B` | `Flags` as repeated query param array | Confirmed. Each character is sent as a separate `Flags` value. |
| subscription `outputMode=F` | `FullOutput=1` (string `'1'`) | **Resolved:** `outputMode='F'` from `companywebservice` sets `fullOutput=true` in the context; passed upstream as `FullOutput: '1'`. |

### New ODG response example

```json
{
  "clientId": "claim-123",
  "items": [
    {
      "code": "99213",
      "name": "Example procedure",
      "incidenceRate": 1.2,
      "procedureFrequency": 2.3,
      "visit25": 1,
      "visit50": 2,
      "visit75": 3,
      "visitMean": 2.1,
      "costMean": 100.0,
      "odgCAA": 1,
      "paymentFlag": "Green",
      "costPerVisit": 50.0,
      "procedureType": "...",
      "averageLostDays": 3.0,
      "medianLostDays": 2.0,
      "percentNeverReturn": 0.1,
      "percentZeroDays": 0.2,
      "taoIndex": 1.0
    }
  ]
}
```

### Legacy response target and field map

```json
[
  {
    "icd": { "code": "M54.5", "name": "Example diagnosis" },
    "cpt": [
      {
        "code": "99213", "name": "Example procedure",
        "incidencerate": 1.2, "cptfrequency": 2.3,
        "visit25": 1, "visit50": 2, "visit75": 3, "visitmean": 2.1,
        "costmean": 100.0, "odgcaa": 1, "paymentflag": "Green", "costpervisit": 50.0
      }
    ]
  }
]
```

| Legacy field | New `TaoData` field |
|---|---|
| `incidencerate` | `incidenceRate` |
| `cptfrequency` / `procfrequency` | `procedureFrequency` |
| `visit25`, `visit50`, `visit75`, `visitmean`, `costmean` | same field with lower camel-case upstream spelling |
| `odgcaa` | `odgCAA` |
| `paymentflag` | `paymentFlag` |
| `costpervisit` | `costPerVisit` |
| `proctype` | `procedureType` |
| `avglostdays`, `medianlostdays`, `pctneverreturn`, `pctzerodays`, `taoindex` | `averageLostDays`, `medianLostDays`, `percentNeverReturn`, `percentZeroDays`, `taoIndex` |

**Resolved:** `/tao/icds` response `items[]` each contain `icd` (parent) and `procedures[]` (children). `/tao/procedures` response `items[]` each contain `procedure` (CPT/proc parent) and `icds[]` (ICD children). Legacy output key for AU is `proc`; for US is `cpt`. ICD child records use `icdfrequency` (not `cptfrequency`) in legacy output.

## 2. Best Practice Guide â€” `GET /restws/bpguide`

### Legacy request

```http
GET /restws/bpguide?icd=M54.5~M54.50&clientid=claim-123
X-ODG-KEY: <key>
```

The legacy endpoint also accepts `bp` and `noi`; it first resolves those FNOL values to an ICD-10 code.

### New ODG request

```http
GET /guidelines?icd10=M54.5&icd10=M54.50
Authorization: Bearer <token>
X-ApiVersion: 1.2
```

Split validated legacy input by ICD family: send ICD-9 values through `icd9`, ICD-10 values through `icd10`. For FNOL, first resolve to ICD using the approved new FNOL operation, then call `/guidelines`.

### New ODG response example

```json
{
  "code": "M54.5",
  "description": "Example diagnosis",
  "bestPracticeGuidelines": [{ "pathway": "...", "minDays": 1, "maxDays": 7, "jobClass": "..." }],
  "activityModifiers": [],
  "physicalTherapyVisits": [],
  "chiropractorVisits": []
}
```

### Legacy response target

```json
{
  "icdcode": "M54.5",
  "name": "Example diagnosis",
  "bp": [{ "primaryRTWpath": "...", "days1": "...", "days": "..." }],
  "activitymod": [{ "jobtype": "...", "jobmodification": "..." }],
  "pt": [{ "primarypath": "...", "visits": "...", "weeks": "..." }],
  "chiro": [{ "primarypath": "...", "visits": "...", "weeks": "..." }]
}
```

| Legacy field | New ODG candidate | Review state |
|---|---|---|
| `icdcode` | `code` | Confirmed. |
| `name` | `description` | Confirmed. |
| `bp[].primaryRTWpath` | `bestPracticeGuidelines[].pathway` | Confirmed. |
| `bp[].days1` | `bestPracticeGuidelines[].minDays` | Confirmed. |
| `bp[].days` | `bestPracticeGuidelines[].maxDays` | Confirmed. |
| `activitymod[].jobtype` | `activityModifiers[].jobType` | **Resolved.** |
| `activitymod[].jobmodification` | `activityModifiers[].jobModification` | **Resolved.** |
| `pt[].primarypath` | `physicalTherapyVisits[].pathway` | **Resolved.** |
| `pt[].visits` | `physicalTherapyVisits[].visits` | **Resolved.** |
| `pt[].weeks` | `physicalTherapyVisits[].weeks` | **Resolved.** |
| `chiro[].primarypath` | `chiropractorVisits[].pathway` | **Resolved.** |
| `chiro[].visits` | `chiropractorVisits[].visits` | **Resolved.** |
| `chiro[].weeks` | `chiropractorVisits[].weeks` | **Resolved.** |

Append legacy `rescount` and `clientid` when requested.

FNOL resolution: calls `/tao/fnol/{bp}/{noi}` and extracts `data.icds[]` (string array) as the ICD list for the `/guidelines` call. If `data.icds` is empty, returns 400 `INVALID_FNOL`.

ICD family split for `/guidelines`: codes beginning with a letter → `icd10=<code>`; otherwise `icd9=<code>`.

## 3. One Search â€” `POST /restws/onesearch`

### Legacy XML request

```xml
<request>
  <text>back pain</text>
  <database>
    <icd9>Y</icd9><icd10>Y</icd10><cpt>Y</cpt><ndc>Y</ndc><proct>Y</proct>
  </database>
  <clientid>claim-123</clientid>
</request>
```

### New ODG request candidate

```http
GET /search?query=back%20pain&type=<selected-types>&facets=false&country=US
Authorization: Bearer <token>
X-ApiVersion: 1.2
```

| Legacy XML value | New candidate |
|---|---|
| `text` | `query` |
| `<database><icd9>Y</icd9>` | add an ICD-9 value to `type` |
| `<database><icd10>Y</icd10>` | add an ICD-10 value to `type` |
| `<database><cpt>Y</cpt>` | add a CPT value to `type` |
| `<database><ndc>Y</ndc>` | add an NDC value to `type` |
| `<database><proct>Y</proct>` | add a procedure-topic value to `type` |

**Resolved.** Confirmed upstream `type` values:

| Legacy database flag | Upstream `type` value |
|---|---|
| `<icd9>Y</icd9>` | `icd9search` |
| `<icd10>Y</icd10>` | `icd10search` |
| `<cpt>Y</cpt>` | `procedurescpt` |
| `<ndc>Y</ndc>` | `formularyndc` |
| `<proct>Y</proct>` | `treatment` |

Sent as repeated `type` query params: `GET /search?query=...&type=icd9search&type=procedurescpt&facets=false&country=US`

### New ODG response shape

```json
{
  "resultSets": [
    { "section": "...", "resultCount": 1, "results": [] }
  ]
}
```

### Legacy response target

```json
{ "type": "ICD9|ICD10|CPT", "code": "...", "name": "..." }
{ "type": "NDC", "code": "...", "name": "...", "brand": "..." }
{ "type": "PROCT", "name": "...", "chapter": "..." }
```

**Resolved.** ODG result-set items by section:

| `section` value | Legacy `type` | Legacy fields | ODG item fields used |
|---|---|---|---|
| `icd9search` | `ICD9` | `code`, `name` | `icdCode` (fallback `code`), `name`/`description` |
| `icd10search` | `ICD10` | `code`, `name` | `icdCode` (fallback `code`), `name`/`description` |
| `procedurescpt` | `CPT` | `code`, `name` | `procedureCode` (fallback `code`), `name`/`description` |
| `formularyndc` | `NDC` | `code`, `name`, `brand` | `code`/`ndcCode`, `nonProprietaryName`/`name`, `tradeName`/`brand`/`proprietaryName` |
| `treatment` | `PROCT` | `name`, `chapter` | `name`/`topic`, `primaryChapter`/`chapter` |

Unknown `section` values are silently skipped.

## 4. Comorbidity Calculator â€” `POST /calculator/comorbidity`

## 5. Reserve Calculator â€” `POST /calculator/reserve`

### Legacy XML request

```xml
<request>
  <clientid>claim-123</clientid><country>US</country><state>CA</state>
  <age>42</age><jds>50</jds><datatype>WC</datatype><jobclass>3</jobclass>
  <medicalonly>0</medicalonly><aww>1200</aww><edl>30</edl><comprate>800</comprate>
  <mdd>10</mdd><lostwages>100</lostwages><injurydate>2026-01-01</injurydate>
  <surgerydate>2026-02-01</surgerydate><fulloutput>Y</fulloutput>
  <icdcodes><code>M54.5</code></icdcodes>
  <bpcode>01</bpcode><noicode>02</noicode>
  <procsummary>
    <cpt><code>99213</code></cpt><hcpcs><code>...</code></hcpcs>
    <icd><code>...</code></icd><ndc><code>12345-6789</code></ndc>
  </procsummary>
  <cfactors><depression>1</depression><opioids>0</opioids></cfactors>
</request>
```

### New ODG JSON request

```json
{
  "requestedoutput": "RasAndRtw",
  "clientId": "claim-123",
  "country": "US",
  "state": "CA",
  "age": 42,
  "jds": 50,
  "dataType": "WC",
  "jobClass": 3,
  "medicalonly": 0,
  "aww": 1200,
  "edl": 30,
  "comprate": 800,
  "mdd": 10,
  "lostWages": 100,
  "injuryDate": "2026-01-01T00:00:00Z",
  "surgeryDate": "2026-02-01T00:00:00Z",
  "fulloutput": 1,
  "icdCodes": { "codes": ["M54.5"] },
  "fnolCodes": [{ "bpcode": "01", "noicode": "02" }],
  "procSummary": {
    "cpt": { "codes": ["99213"] }, "hcpcs": { "codes": [] },
    "icd": { "codes": [] }, "ndc": { "codes": ["12345-6789"] }
  },
  "cfactors": { "depression": 1, "opioids": 0 }
}
```

| Legacy XML | Swagger v1.2 JSON | Mapping status |
|---|---|---|
| `icdcodes/code` | `icdCodes.codes[]` | Confirmed. |
| `procsummary/{cpt,hcpcs,icd,ndc}/code` | `procSummary.<type>.codes[]` | Confirmed. |
| `bpcode`, `noicode` | `fnolCodes[].bpcode`, `.noicode` (US); `toocsCodes[].bpcode`, `.noicode` (AU) | **Resolved:** AU uses `toocsCodes` key. |
| `clientid` | `clientId` | Direct casing. |
| `country`, `state`, `age`, `jds` | `country`, `state`, `age`, `jds` | Confirmed. |
| `jobclass` 1–5 (DOL) | `jobClass: <integer>` | **Resolved:** DOL job classes sent as integer. |
| `jobclass` NCCI (>1 digit or >5) | `ncci: "<4-digit string>"` | **Resolved:** NCCI codes padded to 4 digits, sent as `ncci` string. |
| `aww`, `edl`, `comprate`, `mdd` | `aww`, `edl`, `comprate`, `mdd` | Confirmed. |
| `lostwages` | `lostWages` | Confirmed. |
| `injurydate`, `surgerydate` | `injuryDate`, `surgeryDate` with `T00:00:00Z` appended | Confirmed. |
| `datatype` | `dataType` | Confirmed (passes `WC`/`NO` as-is). |
| `fulloutput=Y` | `fulloutput: 1` | **Resolved:** sent as integer `1`. |
| `cfactors/preexisting` | `cfactors/preExisting` | **Resolved:** capital `E` required. |
| `medicalonly=1` or `=M` | `medicalonly: 1` | Confirmed coercion. |
| calculator mode | `requestedoutput` | See decision below. |

### `requestedoutput` values — RESOLVED

| Legacy endpoint | Upstream `requestedoutput` | Notes |
|---|---|---|
| `/calculator/comorbidity` | `RasRtwCosts` | Same value as reserve. ODG only returns `notes.medical.*.alert` and `alertdesc` for `RasRtwCosts`. `projectedcosts` is excluded from the comorbidity response in the transformer. |
| `/calculator/reserve` | `RasRtwCosts` | Returns risk assessment + RTW/duration + projected costs. |

### New ODG response example

```json
{
  "clientId": "claim-123",
  "adjustedSummaryGuidelines": {},
  "adjustedDuration": { "clinicalMin": 1, "bestPractice": 2, "claimAverage": 3, "claimMax": 4 },
  "projectedCosts": { "bestPractice": 100, "claimAverage": 200, "claimMax": 300 },
  "compRate": 800,
  "icdCodes": {},
  "cfactors": {},
  "procsummary": {},
  "alertdesc": {},
  "riskAssessment": { "score": 1, "magnitude": "...", "volatility": "...", "status": "..." }
}
```

### Legacy response target

```json
{
  "clientid": "claim-123",
  "riskassessment": {},
  "adjustedduration": {},
  "projectedcosts": {},
  "adjustedsummaryguidelines": {},
  "comprate": "$800.00",
  "icdcodes": [],
  "fnolcodes": {},
  "procsummary": { "cptcodes": [], "icdcodes": [] },
  "cfactors": {},
  "alertdesc": {},
  "notes": [],
  "odgurl": "...",
  "deeplinkurl": "..."
}
```

| Legacy output | New ODG field | Review state |
|---|---|---|
| `clientid` | `clientId` | Confirmed. |
| `adjustedsummaryguidelines` | `adjustedSummaryGuidelines` | **Resolved.** Comorbidity only — omitted for Reserve. |
| `adjustedduration.bp/cp95/cp100` | `adjustedDuration.bestPractice/claimAverage/claimMax` | **Resolved.** `clinicalMin` is omitted. Comorbidity: omitted when `medicalonly` set. Reserve: only returned when `fulloutput=Y`. |
| `projectedcosts.bp/cp95/cp100` | `projectedCosts.bestPractice/claimAverage/claimMax` | **Resolved.** Reserve only. Each tier has `indemnity`, `medical`, `expense`, `total` — all formatted as US currency (`$N,NNN.NN`). |
| `comprate` | `compRate` | **Resolved.** Formatted as `$N,NNN.NN`. |
| `riskassessment.score/status/magnitude/volatility` | `riskAssessment.score/status/magnitude/volatility` | **Resolved.** `ssdiFlag` omitted. `magnitude` and `volatility` formatted to 2 decimal places. |
| `icdcodes` (fulloutput only) | `icdCodes.icdcode[]` | **Resolved.** Items: `code`, `name`, `stcode` (from ODG), `meandurationdays.{bp,cp95,cp100}`. Two sub-cases: (1) mixed ICD+FNOL request — only explicitly submitted ICD codes appear; FNOL-resolved ICDs are excluded; (2) FNOL-only request (no explicit ICD codes) — `icdcodes` field is omitted entirely from the response even when `fulloutput=Y`. |
| `fnolcodes` (fulloutput only) | `fnolCodes` | **Resolved.** `icdcodes` sub-field stripped from each FNOL item (legacy never returns it). |
| `procsummary` (fulloutput only) | `procsummary.{cptcodes,icdcodes}` | **Resolved.** CPT items with `meandurationdays=0` filtered out. ICD proc `meandurationdays` formatted to 3dp. |
| `cfactors` (fulloutput only) | `cfactors` | **Resolved.** Entries with `applied=0` are filtered. `preExisting` → `preexisting` in legacy output. `alert` values lowercased. Surgery trigger: codes without a decimal point are CPT (preferred group); codes with a decimal point are ICD procedure (fallback group); only the last code in the preferred group is returned as the trigger. |
| `alertdesc` (fulloutput only) | `alertdesc` | Passed through as-is. |
| `notes` | `notes` | Reserve only. `bestPractice→bp`, `claimAverage→cp95`, `claimMax→cp100` renamed throughout. |
| `odgurl`, `deeplinkurl` | `odgByMcgLinks.duration` | **Resolved.** Both fields map to the same value: `odgByMcgLinks.duration`. When absent, both are `null`. |

### Response serialization rules — confirmed

These cross-cutting rules apply to all legacy output (both XML and JSON) and must be preserved by any reimplementation:

| Rule | Detail |
|---|---|
| Key casing | All output keys are deep-lowercased. Exception: `primaryRTWpath` preserves its mixed case exactly — it must never be lowercased. |
| Null values | `null` values serialize as empty strings (`""`). Never emit the literal string `"null"` or a JSON `null`. |
| Undefined fields | Fields set to `undefined` are stripped entirely — not emitted as empty or null. |
| Upstream array params | Multi-value query params sent to ODG API v1.2 use repeated-key format without brackets: `icd10=A&icd10=B` not `icd10[]=A&icd10[]=B`. |

## End-of-life endpoints

| Legacy endpoint | Decision |
|---|---|
| `POST /restws/procsum` | End of life. Do not map to a new ODG endpoint or implement in Express. |
| `GET /restws/sumguide` | End of life. Do not map to a new ODG endpoint or implement in Express. |

## Manual-review checklist — RESOLVED

All mapping questions have been resolved during implementation. The adapter is in production.
See CLAUDE.md for the current authoritative state of all mapping decisions.
