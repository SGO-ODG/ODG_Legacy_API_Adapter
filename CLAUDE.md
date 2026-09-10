# New Express Legacy API Compatibility Adapter

## Purpose and scope

Build a **new** Node.js/Express application that lets existing customers continue calling selected legacy CodeIgniter REST APIs while the adapter calls ODG API v1.2 using OAuth client credentials behind the scenes.

- The PHP CodeIgniter application is live production reference code. Treat all PHP files as **read-only**.
- Do not add new functionality to PHP, migrate data, change PHP routes, or modify its database schema.
- The Express source lives in a different Git repository. Configure its local `LEGACY_PHP_REFERENCE_ROOT` to this checkout: `C:\Saurabh\MyApps\Apache24\odgci_3.1.11`. This path is a development/test reference only and must never be a runtime dependency or deployment requirement.
- This adapter is temporary: it supports only already subscribed legacy customers until they finish their migration to the new ODG APIs.
- Do not implement customer provisioning, subscription provisioning, or a maintenance mode.
- No new customer should be configured for legacy APIs.

Read these documents before changing adapter behavior:

- `legacy-api-express-adapter-plan.md` — approved compatibility plan.
- `legacy-php-api-contract.md` — source-derived legacy input/output contract.
- `legacy-to-odg-v12-mapping-review.md` — draft legacy-to-ODG v1.2 mapping; all `TODO / confirm` entries require product/API-owner confirmation before implementation.

When the written contract does not settle an edge case, inspect the read-only PHP sources under `LEGACY_PHP_REFERENCE_ROOT` in this order:

- `application/controllers/Restws.php` — legacy REST routes, query parameters, XML POST parsing, validations, endpoint errors.
- `application/controllers/Calculator.php` — calculator XML input, defaults, validation, and conditional response fields.
- `application/libraries/RestController.php` and `application/language/english/rest_controller_lang.php` — shared authentication, routing, format, HTTP-status, and exact error-message behavior.
- `application/models/Odgws_model.php` and `application/models/Calculator_model.php` — legacy response shape, field names, grouping, sorting, and data-dependent behavior.
- `application/config/rest.php` — enabled REST settings and legacy key configuration.

## Supported and excluded APIs

Implement these legacy customer-facing routes with the same public path, HTTP method, inputs, status codes, and output format:

| Legacy route | Method | New ODG v1.2 target |
|---|---:|---|
| `/restws/ndcadvisor` | GET | `/formulary/ndc`, `/formulary/ndc/{ndcCode}`, `/formulary/pbs`, or `/formulary/pbs/{pbsCode}` |
| `/restws/ndcdownload` | GET | paged `/formulary/ndc` |
| `/restws/uradvisor` | GET | `/tao/icds`; confirm `/tao/procedures` and `/tao/fnol` branches |
| `/restws/bpguide` | GET | `/guidelines` |
| `/restws/onesearch` | POST XML | `/search` |
| `/calculator/comorbidity` | POST XML | `/calculator` |
| `/calculator/reserve` | POST XML | `/calculator` |

Explicitly end of life: `POST /restws/procsum` and `GET /restws/sumguide`. Do not approximate them with `/search` or `/guidelines`; retain PHP routing only for the agreed retirement period, then use the approved EOL gateway behavior.

Do not treat bundled `api/Key` and `api/Example` controllers as customer migration scope unless scope is explicitly expanded.

## Legacy compatibility requirements

- Require the `X-ODG-KEY` legacy header. Customers do not send OAuth tokens.
- Preserve legacy paths, methods, query names, XML body element names/casing, date formatting, field casing, array/singleton behavior, echoed `clientid`, and `rescount` behavior. Every legacy POST request body is XML. Responses are XML by default; return JSON only when the legacy path ends exactly in `/format/json` (for example `/restws/uradvisor/format/json`). Do not use `Accept`, content negotiation, or other format selectors to choose JSON.
- Call upstream ODG APIs with `Authorization: Bearer <token>`, `X-ApiVersion: 1.2`, and JSON response format. Transform upstream JSON into the complete legacy response model first, then serialize that model as the exact legacy XML or JSON contract. Never proxy, rename only, or format-convert an ODG response directly: preserve legacy root/wrapper elements, field names/casing, nesting, array-versus-singleton behavior, omitted conditional fields, ordering where XML requires it, date/number/currency formatting, and legacy error envelopes.
- Do not expose upstream URLs, OAuth errors/tokens, upstream status/body, client secrets, or new-only fields to customers.
- Keep upstream transformation logic separate by operation: parse legacy request -> validate legacy semantics -> build upstream request -> call ODG -> transform upstream response -> serialize legacy response.
- Use a static service/route registry for recognized migrated legacy services. The old `webservicemaster` table is unavailable.

## Available database data only

The adapter may access **only** these two validation tables. During initial development, they are stored in the local read-only SQLite database.

### `companymaster`

```text
companyCode varchar(20) PK
companyName varchar(50)
webserviceKey varchar(50)
disabled char(1)
accountManagerEmail varchar(80)
salesManagerEmail varchar(80)
odgapiClientId varchar(50)
odgapiClientSecret varchar(150)
```

Use it to look up `webserviceKey`, reject `disabled = 'Y'`, obtain the validated company code, and select that company's OAuth client ID/secret. Never log or return the key or secret.

### `companywebservice`

```text
id int AI PK
companyCode varchar(20)
webserviceCode varchar(20)
subscriptionStartDate date
subscriptionEndDate date
outputMode varchar(1)
```

Use it to validate the requested legacy service subscription, enforce the inclusive subscription dates, and supply subscription `outputMode` (notably UR Advisor full vs streamlined output).

`webservicemaster` and `webserviceusage` are unavailable. Do not query them or create replacement database tables. Do not create local API-call audit or usage records. Database access is read-only; ODG API logs are the audit source.

## Initial local development configuration

- For initial adapter development, connect to a local SQLite database containing only the two allowed tables. Use the existing PHP code only as a read-only behavioral reference; do not copy, print, commit, or expose its database credentials.
- When creating the separate Express repository, add a committed `.env.example` and an ignored local `.env`. Do not create a real `.env` in this PHP reference repository.
- Open the SQLite database in read-only mode and query only `companymaster` and `companywebservice`. Do not implement insert, update, delete, DDL, or any access to other tables.
- Keep the OAuth token endpoint, audience, scopes, and actual customer client secrets in local secrets/deployment configuration. The `.env.example` contains placeholders only.

```dotenv
# Local development only — copy to .env in the Express repository and replace placeholders.
NODE_ENV=development
PORT=3000

# Read-only SQLite database containing only companymaster and companywebservice.
SQLITE_DATABASE_PATH=./data/legacy-subscriptions.sqlite
SQLITE_READ_ONLY=true

# New ODG API
ODG_API_BASE_URL=https://api.odgbymcg.com
ODG_API_VERSION=1.2
OAUTH_TOKEN_URL=<oauth_token_endpoint>
OAUTH_AUDIENCE=<audience_if_required>
OAUTH_SCOPES=<space_delimited_scopes_if_required>
OAUTH_TOKEN_EXPIRY_SKEW_SECONDS=60

# Development-only PHP contract reference; never required in production.
LEGACY_PHP_REFERENCE_ROOT=C:\Saurabh\MyApps\Apache24\odgci_3.1.11
```

## Exact legacy error handling

Run legacy validation before requesting an upstream token or calling ODG. Return the original status and exact `error` message:

| Condition | HTTP | Body |
|---|---:|---|
| Missing/unknown `X-ODG-KEY` | 403 | `{ "error": "Invalid web service key." }` |
| `companymaster.disabled = 'Y'` | 403 | `{ "error": "Your account is disabled." }` |
| Requested service absent from static registry | 403 | `{ "error": "Invalid, requested web service does not exist." }` |
| No `companywebservice` record | 403 | `{ "error": "You are not subscribed for requested web service." }` |
| Before `subscriptionStartDate` | 403 | `{ "error": "Your subscription will start from MM/DD/YYYY." }` |
| After `subscriptionEndDate` | 403 | `{ "error": "Your subscription is expired on MM/DD/YYYY." }` |
| Unsupported method for a valid legacy resource | 405 | `{ "error": "Unknown method" }` |

The previous PHP maintenance response (`Web service is down for maintenance.`) is not reproduced because this bridge has no maintenance mode. Preserve endpoint-specific validation/status/body from the legacy contract, including `Invalid web service request format.`, `Invalid XML, unable to load...`, and endpoint-specific 404 no-result text. Map OAuth, network, timeout, and upstream errors to approved legacy errors; never pass them through.

## Per-customer OAuth token reuse

- Obtain a client-credentials token only after legacy key/subscription validation, using that company's `odgapiClientId` and `odgapiClientSecret`.
- Do **not** obtain a token for every customer request.
- Cache by a non-secret key that includes `companyCode`, token URL, client-ID identifier, audience, and scopes.
- Store bearer token and calculated expiry only; never log token values or secrets.
- Respect the OAuth `expires_in` value (for example 3600 or 7200 seconds). Refresh shortly before expiry using a bounded safety skew, such as `min(60 seconds, 10% of lifetime)`.
- Use a single-flight/in-flight-promise mechanism per cache key so concurrent requests share one refresh.
- On upstream 401, invalidate that company's cache entry, obtain one new token, and retry the original upstream request once only.
- Use a secure shared cache when running multiple Express instances; in-memory caching is sufficient only for one instance.

## Important mapping rules and known gaps

- NDC Advisor: normalize numeric input to `NNNNN-NNNN`; direct NDC uses `/formulary/ndc/{ndcCode}`, lists/keyword use `/formulary/ndc`, and `country=AU` uses PBS endpoints. `GE`, `status` (US) and `drugClass`, `odgGenericName`, `odgGenericEquiv`, `odgStatus` (AU PBS) are not available in the ODG v1.2 response — returned as null pending confirmation.
- NDC Download: fetch all `/formulary/ndc` pages (`pageSize=100`) and return the unpaginated legacy record array. Confirm upstream maximum pageSize and ordering guarantee.
- UR Advisor: ICD-driven → `/tao/icds`; `icd=9|10` reverse lookup → `/tao/procedures?resulttype=1` (ICD9) or `resulttype=2` (ICD10); FNOL-only → `/tao/fnol/{bp}/{noi}` (full TAO data returned directly, no secondary call). ICD requests with no results fall back to FNOL when `bp`/`noi` are present. Subscription `outputMode=F` → `FullOutput=1`. AU uses `proc` key.
- Best Practice Guide: map ICD-9/ICD-10 arrays to `/guidelines` (split by ICD family: letter-prefix = ICD-10); FNOL resolves via `/tao/fnol` → `data.icds[]`. Field mappings confirmed: `bestPracticeGuidelines[].{pathway,minDays,maxDays}`, `activityModifiers[].{jobType,jobModification}`, `physicalTherapyVisits[]/chiropractorVisits[].{pathway,visits,weeks}`.
- One Search: map XML `text` to `/search?query=...`; confirmed `type` values: `icd9search`, `icd10search`, `procedurescpt`, `formularyndc`, `treatment`. Result items by section: CPT → `procedureCode`, ICD → `icdCode`, PROCT → `primaryChapter`.
- Comorbidity Calculator: `requestedoutput=RasAndRtw`. Returns `riskassessment` + `adjustedduration` (omitted when `medicalonly`) + `adjustedsummaryguidelines`. No `projectedcosts`.
- Reserve Calculator: `requestedoutput=RasRtwCosts`. Always returns `projectedcosts` (bp/cp95/cp100 with indemnity/medical/expense/total as currency). Returns `adjustedduration` only when `fulloutput=Y`. No `adjustedsummaryguidelines`.
- Both Calculators: `jobclass` 1–5 → upstream integer `jobClass`; NCCI codes (any other value) padded to 4 digits → upstream string `ncci`. AU FNOL uses `toocsCodes`. `cfactors` with `applied=0` filtered from response. `preexisting` → `preExisting`. Both `odgurl` and `deeplinkurl` map to `odgByMcgLinks.duration`. `cfactors` surgery trigger selection: codes without a decimal are treated as CPT (preferred group); codes with a decimal are treated as ICD procedure (fallback group); only the last code in the preferred group is returned as the trigger. `icdcodes` FNOL deduplication (fulloutput only): when the request contains explicit ICD codes AND FNOL codes, return only the explicitly submitted ICD codes (not FNOL-resolved ones); when the request is FNOL-only (no explicit ICDs), omit `icdcodes` entirely even when `fulloutput=Y`.
- Response serialization: all legacy response keys are deep-lowercased except `primaryRTWpath` which preserves its mixed case. `null` values are serialized as empty strings (`""`) in both XML and JSON output — they are never emitted as the literal string `"null"`. Fields set to `undefined` are stripped from the output entirely. Upstream array query parameters are sent in repeated-key format without brackets (`icd10=A&icd10=B`, not `icd10[]=A&icd10[]=B`).

## Testing and delivery

- Add contract tests for every supported route covering valid requests, invalid key, disabled account, unsubscribed customer, future/expired subscription, unsupported method, malformed XML, invalid request format, no results, and upstream failures.
- In the new Express repository, test configuration validation using `.env.example`-compatible placeholders; never commit a populated `.env` or any PHP/production credentials.
- Compare legacy PHP and adapter results manually for status, `Content-Type`, error text, XML element names/order, JSON field casing, singleton/array behavior, date/number formatting, `clientid`, and `rescount`; test both the default route (XML) and the same route with `/format/json` (JSON).
- Do not create local API-call audit or usage logs. Database access is read-only; ODG API logs are the audit source. Never log keys, secrets, bearer tokens, raw XML, or upstream payloads containing customer data.
- Keep PHP live and authoritative during the parallel-hostname phase; do not cut traffic over without parity sign-off and a gateway route-back path.

## Test input file conventions

Every test case in a comparison CSV must appear **twice** — once for XML output and once for JSON output — using the same request body/params:

- **XML row**: use the base `url_path` (e.g. `/calculator/comorbidity`, `/restws/bpguide?icd=724.2`)
- **JSON row**: append or insert `/format/json` and name it `<test_name>_json`
  - Query-string URLs: insert before `?` → `/restws/bpguide/format/json?icd=724.2`
  - Path-style URLs: append at end → `/restws/bpguide/icd/724.2/format/json`
  - POST XML endpoints: change base path → `/calculator/comorbidity/format/json`
  - Error / no-result cases must also have JSON variants — the error response format differs between XML and JSON and both must be verified

Place the XML row first, the `_json` companion row immediately after it. Do not add sparse JSON-only rows for a subset of scenarios — every scenario needs both.
