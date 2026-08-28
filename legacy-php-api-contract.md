# Legacy PHP API contract (source-derived)

This document is a read-only analysis of the CodeIgniter controllers and models in `C:\Saurabh\MyApps\Apache24\odgci_3.1.11`. It covers the nine customer-facing legacy APIs. All require the `X-ODG-KEY` header. XML is the response format unless the path ends with `/format/json`, in which case the response is JSON. All POST request bodies are XML; `clientid` is echoed where noted.

For the separate Express repository, retain this PHP checkout as a local reference configured by `LEGACY_PHP_REFERENCE_ROOT`; it is not a runtime dependency.

## New Express persistence boundary

The new Express application has access only to `companymaster` and `companywebservice`.

- Validate the legacy key with `companymaster.webserviceKey`; reject `companymaster.disabled = Y`.
- Read `companymaster.odgapiClientId` and `companymaster.odgapiClientSecret` only after validation, and use them to obtain an OAuth token for that company.
- Validate the requested legacy service, subscription dates, and `outputMode` with `companywebservice`.
- Do not use `webservicemaster` or write to `webserviceusage`; use static route configuration only; database access is read-only and no local API-call audit or usage writer is used. ODG API logs are the audit source. This temporary bridge supports only existing subscribed customers and provides no maintenance mode, customer provisioning, or subscription provisioning.
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

`text` is required and must be at least two characters. At least one database flag must exist. A database is selected only when its value is exactly `Y`.

Response variants:

```json
{ "type": "ICD9|ICD10|CPT", "code": "...", "name": "..." }
{ "type": "NDC", "code": "...", "name": "...", "brand": "..." }
{ "type": "PROCT", "name": "...", "chapter": "..." }
```

Other-name and best-practice hits are emitted as `ICD9` or `ICD10`. `clientid` adds `rescount` and `clientid`.

## POST `/calculator/comorbidity`
## POST `/calculator/reserve`

Both endpoints accept the same XML structure:

```xml
<request>
  <clientid>...</clientid><country>US|AU</country><state>...</state>
  <age>...</age><jds>0-100</jds><datatype>...</datatype><jobclass>...</jobclass>
  <medicalonly>0|1|M</medicalonly><aww>...</aww><edl>...</edl>
  <comprate>...</comprate><mdd>...</mdd><lostwages>...</lostwages>
  <injurydate>...</injurydate><surgerydate>...</surgerydate><fulloutput>Y</fulloutput>
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

- At least one valid diagnosis, CPT/HCPCS, or ICD procedure must survive validation.
- `state` defaults to `US`; `country` defaults to `US`.
- `jds` takes precedence over `jobclass`.
- Direct ICDs can fall back to `bpcode`/`noicode` FNOL mapping.
- Repeated code values are de-duplicated.
- `fulloutput=Y` enables detailed sections.

Comorbidity returns risk assessment and, unless medical-only, adjusted duration. Reserve always returns `projectedcosts`; it uses a supplied `edl` directly or calculates duration when omitted.

Common calculator response fields:

```json
{
  "clientid": "...", "odgurl": "...", "deeplinkurl": "...", "comprate": "$0.00",
  "riskassessment": {}, "adjustedduration": {}, "projectedcosts": {},
  "adjustedsummaryguidelines": {}, "icdcodes": [],
  "fnolcodes": { "bodypart": { "code": "...", "name": "..." }, "natureofinjury": { "code": "...", "name": "..." } },
  "procsummary": { "cptcodes": [], "icdcodes": [] },
  "cfactors": {}, "alertdesc": { "red": "...", "yellow": "..." }, "notes": []
}
```

`riskassessment` and `adjustedduration` are Comorbidity-oriented. `projectedcosts` and optional `notes` are Reserve-oriented. Most detailed fields are conditional on `fulloutput=Y`.

## Source limitations

The PHP model code defines field names and output nesting above. Exact values and some calculator inner structures are data-dependent; a payload/response capture is required to lock byte-level XML serialization and every conditional field variation.
