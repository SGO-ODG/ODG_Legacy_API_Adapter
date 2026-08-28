# Legacy PHP to ODG API v1.2 mapping review

Status: **draft for manual correction**. It combines the read-only PHP controller/model analysis from `C:\Saurabh\MyApps\Apache24\odgci_3.1.11` with the published ODG Swagger v1.2 contract. `TODO / confirm` means the Swagger document does not establish a safe one-to-one mapping. The separate Express repository must configure this location through `LEGACY_PHP_REFERENCE_ROOT` for development/test contract verification only; it is not a runtime dependency.

## Common adapter contract

### Legacy request

```http
X-ODG-KEY: <legacy-customer-key>
<no Accept header is used for legacy response format selection>
```

The adapter validates the legacy key, account status, service availability, subscription dates, and subscription output mode using the existing MySQL tables. Customers do **not** send OAuth tokens.

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
| `companymaster` | Find the customer by `webserviceKey`; reject `disabled=Y`; select that customer's `odgapiClientId` and `odgapiClientSecret` for OAuth client credentials. |
| `companywebservice` | Validate `companyCode` plus legacy `webserviceCode`; enforce `subscriptionStartDate`/`subscriptionEndDate`; read `outputMode`. |

The service code is supplied by a static route registry in Express. This temporary bridge supports only already subscribed customers and performs no customer/subscription provisioning. It has no maintenance mode; no local API-call audit or usage writer is used because `webserviceusage` is unavailable. Database access is read-only; ODG API logs are the audit source.
## Per-customer OAuth token reuse

After legacy key and subscription validation, obtain an OAuth client-credentials token using that company's `odgapiClientId` and `odgapiClientSecret`. Do **not** request a token for every legacy request.

- Cache key: a non-secret deterministic key for `companyCode`, token URL, client ID identifier, audience, and scopes.
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

## 1. NDC Advisor â€” `GET /restws/ndcadvisor`

### Legacy request

```http
GET /restws/ndcadvisor?ndc=12345-6789~98765-4321&country=US&output=F&clientid=claim-123
X-ODG-KEY: <key>
```

| Legacy parameter | Upstream candidate | Mapping status |
|---|---|---|
| `ndc`, numeric single code | `GET /formulary/ndc/{ndcCode}` | Confirmed endpoint; normalize legacy input to `NNNNN-NNNN`. |
| `ndc`, numeric multiple codes | `GET /formulary/ndc?ndc=<repeated value>` | Endpoint confirmed; confirm the required OpenAPI array serialization. |
| `ndc`, alphabetic keyword | `GET /formulary/ndc?keyword=<ndc>` | Confirmed parameter. |
| `country=AU`, direct/keyword code | `/formulary/pbs/{pbsCode}` or `/formulary/pbs?pbs=...&keyword=...` | Confirmed endpoints/parameters. |
| `clientid` | No upstream equivalent required | Echo after transformation. |
| `output=F` | No confirmed direct equivalent | **TODO:** legacy US output adds `procsummary`; Procedure Summary is EOL, so approve whether to omit it, reject this combination, or source it elsewhere. |

### New ODG response examples

```json
{
  "page": 1,
  "pageSize": 25,
  "totalRecords": 1,
  "ndcInformation": [
    {
      "productNdc": "12345-6789",
      "odgNdcCode": "12345-6789",
      "strength": "10 mg",
      "tradeName": "Example trade name",
      "effectiveDate": "2026-01-01T00:00:00Z",
      "proprietaryName": "Example brand",
      "nonProprietaryName": "Example generic",
      "pharmClasses": "Example class",
      "formularyInformation": []
    }
  ]
}
```

```json
{
  "page": 1,
  "pageSize": 25,
  "totalRecords": 1,
  "pbsInformation": [
    {
      "pbsCode": "1234A",
      "brandName": "Example brand",
      "atcCode": "A01",
      "manufacCode": "MFG",
      "drugMpName": "Example medicine",
      "amtMppPreferredTerm": "Example term",
      "formularyInformation": []
    }
  ]
}
```

### Legacy response target

```json
{
  "ndcCode": "12345-6789",
  "brandName": "Example brand",
  "genericName": "Example generic",
  "tradeName": "Example trade name",
  "drugClass": "Example class",
  "GE": "...",
  "status": "...",
  "strength": "10 mg",
  "effectiveDate": "01/01/2026",
  "rescount": 1,
  "clientid": "claim-123"
}
```

| Legacy response field | New response candidate | Review state |
|---|---|---|
| `ndcCode` | `odgNdcCode` (fallback `productNdc`) | Confirm. |
| `brandName` | `proprietaryName` | Confirm. |
| `genericName` | `nonProprietaryName` | Confirm. |
| `tradeName` | `tradeName` | Direct. |
| `drugClass` | `pharmClasses` | Confirm formatting/multiplicity. |
| `strength` | `strength` | Direct. |
| `effectiveDate` | `effectiveDate`, formatted `MM/DD/YYYY` | Confirm timezone/date-only behavior. |
| `GE`, `status` | likely `formularyInformation` | **TODO:** field-level mapping is not exposed by top-level Swagger schema. |
| AU compact legacy fields | `PbsInfo` plus `formularyInformation` | **TODO:** `drugClass`, `odgGenericName`, `odgGenericEquiv`, `odgStatus` are not top-level `PbsInfo` fields. |

## 2. NDC Download â€” `GET /restws/ndcdownload`

### Legacy request

```http
GET /restws/ndcdownload?clientid=batch-1
X-ODG-KEY: <key>
```

### New ODG request

```http
GET /formulary/ndc?page=1&pageSize=<upstream-maximum>
Authorization: Bearer <token>
X-ApiVersion: 1.2
```

Repeat pages until all `totalRecords` are collected. **TODO:** confirm upstream maximum `pageSize`, ordering guarantee, and whether records can change during a paged export.

### Response transformation

Transform each `NdcInfo` using the NDC field table above. The legacy response is an unpaginated array of records; return all collected records, and append legacy `rescount`/`clientid` behavior when supplied. CSV must serialize the transformed legacy fields, not upstream pagination properties.

## 3. UR Advisor â€” `GET /restws/uradvisor`

### Legacy request

```http
GET /restws/uradvisor?icd=M54.5~M54.50&cpt=99213&flags=RG&country=US&clientid=claim-123
X-ODG-KEY: <key>
```

| Legacy condition/parameter | New ODG candidate | Review state |
|---|---|---|
| ICD-driven request | `GET /tao/icds?icd=<codes>&proc=<cpt>&Flags=RG&Country=US&ClientId=claim-123&FullOutput=<bool>` | Confirmed endpoint and parameter names. |
| `icd=9` or `icd=10` plus CPT/PROC | `GET /tao/procedures?proc=<codes>&ResultType=<ICD version>` | **TODO:** `ResultType` enum/value for legacy 9 vs. 10 is not documented in the reviewed schema. |
| `country=AU` and `proc` | `/tao/icds` with `proc`, `Country=AU` | Confirm with AU test data. |
| `bp`/`noi` FNOL fallback | `/tao/fnol/{bpCode}/{noiCode}` then `/tao/icds` if needed | **TODO:** confirm whether the direct FNOL response can replace the legacy ICD-derived flow. |
| `flags=R/G/Y/B` | `Flags` | Confirm value syntax is still identical. |
| subscription `outputMode=F` | `FullOutput=true` | Candidate mapping; confirm exact boolean semantics. |

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

**TODO:** confirm how upstream `items` identifies/contains the legacy parent ICD/CPT grouping. That relationship is not shown by the top-level Swagger schema and must be validated with a live response.

## 4. Best Practice Guide â€” `GET /restws/bpguide`

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
| `icdcode` | `code` | Direct. |
| `name` | `description` | Direct. |
| `bp.primaryRTWpath` | `bestPracticeGuidelines[].pathway` | Candidate. |
| `bp.days1`, `bp.days` | `bestPracticeGuidelines[].minDays`, `.maxDays` | Candidate; validate meaning and numeric formatting. |
| `activitymod` | `activityModifiers` | **TODO:** inspect nested item schema/live response. |
| `pt` | `physicalTherapyVisits` | **TODO:** inspect nested item schema/live response. |
| `chiro` | `chiropractorVisits` | **TODO:** inspect nested item schema/live response. |

Append legacy `rescount` and `clientid` when requested.

## 5. One Search â€” `POST /restws/onesearch`

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

**TODO / required correction:** Swagger documents `type` as an array but does not expose its allowed values in the reviewed schema. Confirm exact values and array serialization with the ODG API owner.

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

**TODO / required correction:** The Swagger top-level schema does not define the individual `results` item properties. Confirm the result-item schema and create an explicit section/type-to-legacy-record mapping before implementation.

## 6. Comorbidity Calculator â€” `POST /calculator/comorbidity`

## 7. Reserve Calculator â€” `POST /calculator/reserve`

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
| `icdcodes/code` | `icdCodes.codes[]` | Confirmed property structure. |
| `procsummary/{cpt,hcpcs,icd,ndc}/code` | `procSummary.<type>.codes[]` | Confirmed property structure. |
| `bpcode`, `noicode` | `fnolCodes[].bpcode`, `.noicode` | Confirmed property names. |
| `clientid`, `country`, `state`, `age`, `jds`, `jobclass`, `aww`, `edl`, `comprate`, `mdd`, `injurydate`, `surgerydate` | corresponding lower/camel-cased Swagger fields | Confirm date parsing and numeric coercion. |
| `datatype` | `dataType` | Confirm enum values. |
| `lostwages` | `lostWages` | Direct casing transformation. |
| `fulloutput=Y` | `fulloutput=1` | Candidate conversion; confirm allowed numeric/boolean form. |
| `cfactors/preexisting` | `cfactors/preExisting` | Confirm capital `E` required by Swagger. |
| calculator mode | `requestedoutput` | See required decision below. |

### Required `requestedoutput` decision

| Legacy endpoint | Candidate Swagger enum | Reason | Review state |
|---|---|---|---|
| `/calculator/comorbidity` | `RasAndRtw` | Legacy produces risk assessment plus adjusted duration/return-to-work information. | **Confirm.** |
| `/calculator/reserve` | `RasRtwCosts` | Legacy produces reserve costs and may produce risk/duration details. | **Confirm.** |

If exact legacy behavior cannot be represented by one enum, request the most complete permitted output and discard fields during legacy transformation.

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

| Legacy output | New output candidate | Review state |
|---|---|---|
| `clientid` | `clientId` | Direct casing transform. |
| `adjustedsummaryguidelines` | `adjustedSummaryGuidelines` | Direct casing transform. |
| `adjustedduration` | `adjustedDuration` | **TODO:** legacy nested BP/CP95/CP100 structure differs from Swagger percentile fields. |
| `projectedcosts` | `projectedCosts` | **TODO:** legacy nested BP/CP95/CP100 structure differs from Swagger percentile fields. |
| `comprate` | `compRate`, formatted as `$0.00` | Confirm currency/rounding rules. |
| `riskassessment` | `riskAssessment` | **TODO:** inspect legacy and v1.2 nested fields side by side. |
| `icdcodes`, `procsummary`, `cfactors`, `alertdesc` | correspondingly named v1.2 fields | Confirm every nested field and casing. |
| `fnolcodes` | `fnolCodes` | Confirm output nesting/type. |
| `notes` | `notes` | Reserve only; confirm schema. |
| `odgurl`, `deeplinkurl` | no Swagger v1.2 response field | **TODO:** retain PHP-equivalent URL construction in Express or obtain an approved replacement; cannot be derived from the new API response. |

## End-of-life endpoints

| Legacy endpoint | Decision |
|---|---|
| `POST /restws/procsum` | End of life. Do not map to a new ODG endpoint or implement in Express. |
| `GET /restws/sumguide` | End of life. Do not map to a new ODG endpoint or implement in Express. |

## Manual-review checklist

- Confirm OAuth token URL, audience, scopes, and client credentials secret source.
- Confirm query-array serialization for `/formulary/*`, `/guidelines`, `/tao/*`, and `/search`.
- Provide sample successful and error responses for every mapped new endpoint, especially `/search`, `/guidelines`, and `/tao/*`.
- Approve or revise every `TODO / confirm` mapping before Express implementation.
- Decide exact customer-facing EOL behavior for Procedure Summary and Summary Guide during/after PHP retirement.
