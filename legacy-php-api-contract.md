# Legacy PHP API contract (source-derived)

This document is a read-only analysis of the CodeIgniter controllers and models in `C:\Saurabh\MyApps\Apache24\odgci_3.1.11`. It covers the nine customer-facing legacy APIs. All require the `X-ODG-KEY` header. XML is the response format unless the path ends with `/format/json`, in which case the response is JSON. All POST request bodies are XML; `clientid` is echoed where noted.

For the separate Express repository, retain this PHP checkout as a local reference configured by `LEGACY_PHP_REFERENCE_ROOT`; it is not a runtime dependency.

## New Express persistence boundary

The new Express application has access only to `companymaster` and `companywebservice`.

- Validate the legacy key with `companymaster.webserviceKey`; reject `companymaster.disabled = Y`.
- Validate the requested legacy service, subscription dates, and `outputMode` with `companywebservice`.
- OAuth credentials are shared across all companies via `ODG_API_CLIENT_ID` and `ODG_API_CLIENT_SECRET` in environment configuration. `companymaster` does not hold per-company OAuth credentials.
- Do not use `webservicemaster`. `webserviceusage` is a write-only table populated by `usageLoggerMiddleware` after each authenticated request (controlled by `USAGE_LOGGING_ENABLED`). `companymaster` and `companywebservice` are read-only. ODG API logs are the primary audit source. This temporary bridge supports only existing subscribed customers and provides no maintenance mode, customer provisioning, or subscription provisioning.
## Lifecycle and new-API mapping decisions

| Legacy endpoint | Status | New ODG API mapping |
|---|---|---|
| `POST /restws/procsum` | End of life | No Express implementation or replacement mapping. |
| `GET /restws/sumguide` | End of life | No Express implementation or replacement mapping. |
| `GET /restws/bpguide` | Supported | `GET /guidelines`; transform the new response to the legacy Best Practice Guide shape. |

## GET `/restws/ndcadvisor`

| Parameter | Required | Behavior |
|---|---:|---|
| `ndc` | Yes | NDC/PBS code(s), `~` separated. Numeric US values normalize to `NNNNN-NNNN`; alphabetic values are keyword searches. `all` returns 404. |
| `country` | No | `AU` switches to PBS; otherwise US NDC. |
| `output` | No | `F` adds `procsummary` for a direct US NDC lookup; in AU returns the fuller PBS record. |
| `clientid` | No | Echoed in response. |
| output format | No | CSV is rejected. |

US NDC record fields: `ndcCode`, `brandName`, `genericName`, `tradeName`, `drugClass`, `GE`, `status`, `strength`, `effectiveDate`; full mode may add `procsummary`.

AU/PBS compact fields: `pbsCode`, `drugClass`, `odgGenericName`, `odgGenericEquiv`, `odgStatus`, `atcCode`, `manufacCode`, `brandName`, `drugMPName`, `amtMppReferredTerm`. The full PBS response returns database columns except `cost` and `id`.

The response is a single record for one match or an array for multiple matches, plus `rescount` and optional `clientid`.

## GET `/restws/ndcdownload`

Optional query parameter: `clientid`.

Returns every NDC record with: `ndcCode`, `brandName`, `genericName`, `tradeName`, `drugClass`, `GE`, `status`, `strength`, `effectiveDate`.

CSV is supported. When `clientid` is supplied, the legacy output also adds `rescount` and `clientid`.

Adapter implementation pages through `/formulary/ndc` using `pageSize=100` and repeats until `totalRecords` are collected, then returns the full unpaginated array.

## GET `/restws/uradvisor`

| Parameter | Required | Behavior |
|---|---:|---|
| `icd` | Conditional | ICD-9/10 code(s), `~` separated; literal `9` or `10` performs an ICD lookup from procedures. Required unless FNOL values are supplied. |
| `cpt` | Conditional | US CPT code(s), `~` separated. Required for US when `icd=9` or `icd=10`. |
| `proc` | Conditional | Australian procedure code(s), `~` separated. |
| `country` | No | `AU` selects Australian data and uses `proc`. |
| `flags` | No | Approval filter: `R`, `G`, `Y`, `B` map to Red, Green, Yellow, Black. |
| `bp` | Conditional | FNOL body-part code, zero-padded to two digits. |
| `noi` | Conditional | FNOL nature-of-injury code, zero-padded to two digits. |
| `clientid` | No | Echoed in response. |
| `outputMode` | Internal | Subscription data normally overrides this to `F` or `S`. |

Response groups child records under a parent `icd`, `cpt`, or AU `proc`:

```json
[
  {
    "icd": { "code": "...", "name": "..." },
    "cpt": [
      {
        "code": "...", "name": "...", "incidencerate": "...",
        "cptfrequency": "...", "visit25": "...", "visit50": "...",
        "visit75": "...", "visitmean": "...", "costmean": "...",
        "odgcaa": "...", "paymentflag": "...", "costpervisit": "..."
      }
    ]
  }
]
```

For an ICD-from-CPT lookup, the parent is `cpt` (or `proc` in AU) and children are `icd`. Full subscription mode adds `proctype`; US adds `avglostdays`, `medianlostdays`, `pctneverreturn`, `pctzerodays`, `taoindex`; AU adds `taoindex`.

## GET `/restws/sumguide`

**Lifecycle: End of life.** This source-derived contract is retained only to document the existing PHP behavior. It must not be implemented in the new Express compatibility layer.

Parameters: `icd` (`~` separated ICD-9/10), or `bp` plus `noi` as FNOL fallback; optional `clientid`. CSV is rejected.

Each record:

```json
{
  "icdcode": "...", "name": "...", "claimsmidrange": "...",
  "claimsatrisk": "...", "absencesmidrange": "...", "absencesatrisk": "..."
}
```

Records are ordered descending by `absencesmidrange`. `clientid` causes `rescount` and `clientid` to be added.

## GET `/restws/bpguide`

**New ODG API mapping:** `GET /guidelines`. The Express adapter must preserve the legacy input validation, FNOL fallback, response envelope, and XML/JSON serialization while transforming the new API response into the legacy structure below.

Parameters: `icd` (`~` separated), or `bp` plus `noi` as FNOL fallback; optional `clientid`. CSV is rejected.

Each record:

```json
{
  "icdcode": "...", "name": "...",
  "bp": [{ "primaryRTWpath": "...", "days1": "...", "days": "..." }],
  "activitymod": [{ "jobtype": "...", "jobmodification": "..." }],
  "pt": [{ "primarypath": "...", "visits": "...", "weeks": "..." }],
  "chiro": [{ "primarypath": "...", "visits": "...", "weeks": "..." }]
}
```

Only ICDs with at least one populated guide section are returned. `clientid` adds `rescount` and `clientid`.

FNOL fallback: when `bp`/`noi` are provided instead of `icd`, the adapter calls `/tao/fnol/{bp}/{noi}` and extracts the `icds[]` array from the response, then uses those codes to call `/guidelines`. If the FNOL endpoint returns no ICDs, returns 400 with the invalid FNOL codes error.

Upstream field mappings (confirmed):
- `code` → `icdcode`, `description` → `name`
- `bestPracticeGuidelines[].pathway` → `bp[].primaryRTWpath`; `.minDays` → `bp[].days1`; `.maxDays` → `bp[].days`
- `activityModifiers[].jobType` → `activitymod[].jobtype`; `.jobModification` → `activitymod[].jobmodification`
- `physicalTherapyVisits[].pathway` → `pt[].primarypath`; `.visits` → `pt[].visits`; `.weeks` → `pt[].weeks`
- `chiropractorVisits[].pathway` → `chiro[].primarypath`; `.visits` → `chiro[].visits`; `.weeks` → `chiro[].weeks`

ICD family detection: codes starting with a letter (e.g. `M54.5`) are ICD-10; otherwise ICD-9. Sent as `icd10=<code>` or `icd9=<code>` query params to `/guidelines`.

## POST `/restws/procsum`

**Lifecycle: End of life.** This source-derived contract is retained only to document the existing PHP behavior. It must not be implemented in the new Express compatibility layer.

The body is XML; any root element is accepted.

```xml
<request>
  <categoryid>...</categoryid>
  <cptcode>...</cptcode>
  <hcpcscode>...</hcpcscode>
  <ndccode>...</ndccode>
  <icdcodes><code>...</code><code>...</code></icdcodes>
  <bpcode>...</bpcode><noicode>...</noicode>
  <chapter>...</chapter><keyword>...</keyword><searchin>S</searchin>
  <recommtype>...</recommtype><limit>...</limit><piq>...</piq>
  <clientid>...</clientid>
</request>
```

At least one selector is required: `categoryid`, `cptcode`, `hcpcscode`, `ndccode`, `icdcodes`, `chapter`, `keyword`, or both `bpcode` and `noicode`.

- `ndccode` normalizes to `NNNNN-NNNN`.
- `icdcodes/code` values are validated and may be normalized.
- `bpcode`/`noicode` are FNOL fallback fields.
- `searchin=S` searches summary text; any other value searches topic.
- `keyword` may be `~` separated.
- `piq` adds `id` to each returned record.

Response record:

```json
{
  "catids": "...", "chapter": "...", "topic": "...", "url": "...",
  "recommtype": "...", "recommstmt": "...", "fullsumtext": "...",
  "fullsumhtml": "...", "odgcrittext": "...", "odgcrithtml": "...",
  "reltopictext": "...", "reltopichtml": "...", "riskbentext": "...",
  "riskbenhtml": "...", "id": "..."
}
```

`id` is conditional on `piq`. `clientid` adds `rescount` and `clientid`.

## POST `/restws/onesearch`

```xml
<request>
  <text>search text</text>
  <database>
    <icd9>Y</icd9><icd10>Y</icd10><cpt>Y</cpt><ndc>Y</ndc><proct>Y</proct>
  </database>
  <clientid>...</clientid>
</request>
```

`text` is required and must be at least two characters. At least one database flag must exist. A database is selected only when its value is exactly `Y`. If no database flag is `Y`, returns 404 `One or more database element child (search in) required to process your request.`

Response variants:

```json
{ "type": "ICD9|ICD10|CPT", "code": "...", "name": "..." }
{ "type": "NDC", "code": "...", "name": "...", "brand": "..." }
{ "type": "PROCT", "name": "...", "chapter": "..." }
```

Other-name and best-practice hits are emitted as `ICD9` or `ICD10`. `clientid` adds `rescount` and `clientid`.

Upstream `/search` type values (confirmed): `icd9search`, `icd10search`, `procedurescpt`, `formularyndc`, `treatment`. The `section` field in each result set is mapped back to legacy `type` values. CPT result items use `procedureCode` for the code field; ICD items use `icdCode`; NDC items use `proprietaryName`/`nonProprietaryName`/`tradeName`; PROCT items use `primaryChapter`.

## POST `/calculator/comorbidity`
## POST `/calculator/reserve`

Both endpoints accept the same XML structure. Any root element name is accepted (`<cbcalc>`, `<reservecalc>`, `<request>`, etc.):

```xml
<request>
  <clientid>...</clientid><country>US|AU</country><state>...</state>
  <age>...</age><jds>0-100</jds><datatype>WC|NO</datatype><jobclass>...</jobclass>
  <medicalonly>0|1|M</medicalonly><aww>...</aww><edl>...</edl>
  <comprate>...</comprate><mdd>...</mdd><lostwages>...</lostwages>
  <injurydate>YYYY-MM-DD</injurydate><surgerydate>YYYY-MM-DD</surgerydate>
  <fulloutput>Y</fulloutput>
  <icdcodes><code>...</code></icdcodes><bpcode>...</bpcode><noicode>...</noicode>
  <procsummary>
    <cpt><code>...</code></cpt><hcpcs><code>...</code></hcpcs>
    <icd><code>...</code></icd><ndc><code>...</code></ndc>
  </procsummary>
  <cfactors>
    <depression>...</depression><diabetes>...</diabetes><hypertension>...</hypertension>
    <legalrep>...</legalrep><obesity>...</obesity><opioids>...</opioids>
    <smoker>...</smoker><subabuse>...</subabuse><surgery>...</surgery>
    <pregnancy>...</pregnancy><preexisting>...</preexisting>
  </cfactors>
</request>
```

Shared behavior:

- At least one valid diagnosis, CPT/HCPCS, or ICD procedure must survive validation. Error: 404 `One or more valid Diagnosis (ICD) or Procedure (CPT) code required to calculate.`
- `state` defaults to `US`; `country` defaults to `US`. For `country=AU` with no `state`, state defaults to `AUS`.
- `jds` (0–100) takes precedence over `jobclass` when both are provided.
- `jobclass` 1–5 are DOL physical demand levels (sent upstream as integer `jobClass`). Any other value (length > 1 digit, or numeric value > 5) is treated as a 4-digit NCCI occupation code, padded with leading zeros (e.g. `172` → `0172`), and sent upstream as string `ncci`.
- Direct ICDs can fall back to `bpcode`/`noicode` FNOL mapping when ICD lookup returns no results.
- FNOL codes (`bpcode`/`noicode`) are zero-padded to 2 digits. For `country=AU`, the upstream field is `toocsCodes` (not `fnolCodes`).
- Repeated code values are de-duplicated.
- `fulloutput=Y` enables detailed sections (`icdcodes`, `procsummary`, `cfactors`, `alertdesc`, `fnolcodes`).
- `cfactors` entries with `applied=0` (evaluated but not applied by ODG) are filtered from the response.
- `preexisting` in legacy XML maps to `preExisting` (capital E) upstream.
- `injurydate`/`surgerydate` are sent upstream with `T00:00:00Z` appended.
- `odgurl` and `deeplinkurl` both map to `odgByMcgLinks.duration` from the ODG response.

### Comorbidity-specific behavior

- Upstream `requestedoutput`: `RasAndRtw`
- Returns: `riskassessment`, `adjustedduration` (unless `medicalonly` is set), `adjustedsummaryguidelines` (always), `cfactors`, `alertdesc`
- Does **not** return: `projectedcosts`, `notes`
- `riskassessment.ssdiFlag` is omitted; `magnitude` and `volatility` are formatted to 2 decimal places

### Reserve-specific behavior

- Upstream `requestedoutput`: `RasRtwCosts`
- Returns: `riskassessment`, `projectedcosts` (always), `adjustedduration` (only when `fulloutput=Y`), `comprate` (formatted as `$N,NNN.NN`), `notes` (when present)
- Does **not** return: `adjustedsummaryguidelines`
- `projectedcosts` contains `bp`, `cp95`, `cp100` tiers, each with `indemnity`, `medical`, `expense`, `total` formatted as US currency

### Response field reference

```json
{
  "clientid": "...",
  "odgurl": "...",
  "deeplinkurl": "...",
  "comprate": "$0.00",
  "riskassessment": { "score": "...", "status": "...", "magnitude": "0.00", "volatility": "0.00" },
  "adjustedduration": {
    "bp": { "days": "..." }, "cp95": { "days": "..." }, "cp100": { "days": "..." }
  },
  "projectedcosts": {
    "bp":   { "indemnity": "$0.00", "medical": "$0.00", "expense": "$0.00", "total": "$0.00" },
    "cp95": { "indemnity": "$0.00", "medical": "$0.00", "expense": "$0.00", "total": "$0.00" },
    "cp100":{ "indemnity": "$0.00", "medical": "$0.00", "expense": "$0.00", "total": "$0.00" }
  },
  "adjustedsummaryguidelines": {},
  "icdcodes": { "icdcode": [{ "code": "...", "name": "...", "stcode": "...", "meandurationdays": { "bp": "...", "cp95": "...", "cp100": "..." } }] },
  "fnolcodes": { "bodypart": { "code": "...", "name": "..." }, "natureofinjury": { "code": "...", "name": "..." } },
  "procsummary": {
    "cptcodes": { "cptcode": [{ "code": "...", "name": "...", "meandurationdays": "..." }] },
    "icdcodes": { "icdcode": [{ "code": "...", "name": "...", "meandurationdays": "0.000" }] }
  },
  "cfactors": {},
  "alertdesc": { "red": "...", "yellow": "..." },
  "notes": []
}
```

Notes on conditional fields:
- `icdcodes`, `fnolcodes`, `procsummary`, `cfactors`, `alertdesc` only appear when `fulloutput=Y`
- Procsummary CPT items with `meandurationdays=0` are filtered. ICD proc `meandurationdays` is formatted to 3 decimal places (e.g. `24.300`)
- `cfactors` surgery trigger: CPT code preferred over ICD procedure code when multiple triggers exist; only the last trigger in the preferred group is returned. CPT codes are identified by the absence of a decimal point in the code value; ICD procedure codes have a decimal point.
- `icdcodes` FNOL deduplication: when the request contains both explicit ICD codes and FNOL codes, only the explicitly submitted ICD codes appear in `icdcodes` (FNOL-resolved ICDs are excluded). When the request is FNOL-only (no explicit ICD codes provided), `icdcodes` is omitted entirely from the response even when `fulloutput=Y`.

### Response serialization rules

These rules apply to both XML and JSON output and must be preserved by any reimplementation:

- **Key casing**: All response keys are deep-lowercased. Exception: `primaryRTWpath` preserves its mixed case and must never be lowercased.
- **Null values**: `null` field values are serialized as empty strings (`""`). They are never emitted as the literal string `"null"` or as a JSON `null`.
- **Undefined fields**: Fields with value `undefined` are stripped from the output entirely (not emitted as empty or null).
- **Upstream array query params**: Sent in repeated-key format without brackets — `icd10=A&icd10=B`, not `icd10[]=A&icd10[]=B`. This applies to all multi-value params sent to ODG API v1.2.

## Source limitations

The PHP model code defines field names and output nesting above. Exact values and some calculator inner structures are data-dependent; a payload/response capture is required to lock byte-level XML serialization and every conditional field variation.
