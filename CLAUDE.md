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

These are the 5 active legacy customer-facing routes implemented in the Express adapter:

| Legacy route | Method | New ODG v1.2 target |
|---|---:|---|
| `/restws/uradvisor` | GET | `/tao/icds`; confirm `/tao/procedures` and `/tao/fnol` branches |
| `/restws/bpguide` | GET | `/guidelines` |
| `/restws/onesearch` | POST XML | `/search` |
| `/calculator/comorbidity` | POST XML | `/calculator` |
| `/calculator/reserve` | POST XML | `/calculator` |

Removed from scope: `GET /restws/ndcadvisor` and `GET /restws/ndcdownload` — no longer implemented in Express; return SERVICE_NOT_EXIST (403) for any request.

Explicitly end of life: `POST /restws/procsum` and `GET /restws/sumguide`. Do not approximate them with `/search` or `/guidelines`; retain PHP routing only for the agreed retirement period, then use the approved EOL gateway behavior.

Do not treat bundled `api/Key` and `api/Example` controllers as customer migration scope unless scope is explicitly expanded.

## Legacy compatibility requirements

- Require the `X-ODG-KEY` legacy header. Customers do not send OAuth tokens.
- Preserve legacy paths, methods, query names, XML body element names/casing, date formatting, field casing, array/singleton behavior, echoed `clientid`, and `rescount` behavior. Every legacy POST request body is XML. Responses are XML by default; return JSON only when the legacy path ends exactly in `/format/json` (for example `/restws/uradvisor/format/json`). Do not use `Accept`, content negotiation, or other format selectors to choose JSON.
- Call upstream ODG APIs with `Authorization: Bearer <token>`, `X-ApiVersion: 1.2`, and JSON response format. Transform upstream JSON into the complete legacy response model first, then serialize that model as the exact legacy XML or JSON contract. Never proxy, rename only, or format-convert an ODG response directly: preserve legacy root/wrapper elements, field names/casing, nesting, array-versus-singleton behavior, omitted conditional fields, ordering where XML requires it, date/number/currency formatting, and legacy error envelopes.
- Do not expose upstream URLs, OAuth errors/tokens, upstream status/body, client secrets, or new-only fields to customers.
- Keep upstream transformation logic separate by operation: parse legacy request -> validate legacy semantics -> build upstream request -> call ODG -> transform upstream response -> serialize legacy response.
- Use a static service/route registry for recognized migrated legacy services. The old `webservicemaster` table is unavailable.

## Database

The adapter uses **PostgreSQL** (Azure Database for PostgreSQL Flexible Server in production). Run `node data/01-create-db.js` once to create the tables. Connection is configured via `PG_*` environment variables.

### `companymaster` (read-only)

```text
companyCode varchar(20) PK
companyName varchar(50)
webserviceKey varchar(50)
disabled char(1)
accountManagerEmail varchar(80)
salesManagerEmail varchar(80)
```

Use it to look up `webserviceKey`, reject `disabled = 'Y'`, and obtain the validated company code. Never log or return the key.

### `companywebservice` (read-only)

```text
id int AI PK
companyCode varchar(20)
webserviceCode varchar(20)
subscriptionStartDate date
subscriptionEndDate date
outputMode varchar(1)
```

Use it to validate the requested legacy service subscription, enforce the inclusive subscription dates, and supply subscription `outputMode` (notably UR Advisor full vs streamlined output).

### `webserviceusage` (write-only)

```text
id               serial PK
companyCode      varchar(20)
webserviceCode   varchar(20)
clientHost       varchar(45)
requestReceived  timestamptz DEFAULT CURRENT_TIMESTAMP
requestBody      text
queryParameters  text
clientId         varchar(30)
resultCode       varchar(5)
contentType      varchar(255)
acceptHeader     varchar(255)
serverResponseTime integer
```

One row is inserted after each authenticated legacy request completes (`usageLoggerMiddleware`). Controlled by `USAGE_LOGGING_ENABLED=Y` in `.env`. Fire-and-forget — errors are logged to stderr and never surface to the customer. `webservicemaster` is unavailable and is not used.

## Local development configuration

- Copy `.env.example` to `.env` and fill in real values. Never commit `.env`.
- Run `node data/01-create-db.js` to create tables, then `node data/02-seed-test-company.js` to seed a test company.
- ODG API credentials (`ODG_API_CLIENT_ID`, `ODG_API_CLIENT_SECRET`) are shared across all companies and live in `.env` only — they are **not** stored in the database.
- Use the existing PHP code only as a read-only behavioral reference; do not copy, print, commit, or expose its database credentials.

```dotenv
NODE_ENV=development
PORT=3000

PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=<pg-database>
PG_USER=<pg-user>
PG_PASSWORD=<pg-password>
PG_SSL=false

ODG_API_CLIENT_ID=<odg-api-client-id>
ODG_API_CLIENT_SECRET=<odg-api-client-secret>
ODG_API_BASE_URL=https://api.odgbymcg.com
ODG_API_VERSION=1.2
OAUTH_TOKEN_URL=<oauth_token_endpoint>
OAUTH_GRANT_TYPE=client_credentials
OAUTH_AUDIENCE=<audience_if_required>
OAUTH_SCOPES=<space_delimited_scopes_if_required>
OAUTH_TOKEN_EXPIRY_SKEW_SECONDS=60

ODG_DEBUG_PAYLOADS=N
USAGE_LOGGING_ENABLED=N

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

## OAuth token management

- ODG API credentials (`ODG_API_CLIENT_ID`, `ODG_API_CLIENT_SECRET`) are **single shared credentials** stored in `.env` — there are no per-company credentials.
- A token is obtained after legacy key/subscription validation and cached in memory (`src/auth/tokenCache.ts`).
- Do **not** obtain a token for every customer request.
- Cache key is built from `OAUTH_TOKEN_URL + ODG_API_CLIENT_ID + OAUTH_AUDIENCE + OAUTH_SCOPES` (non-secret).
- Store bearer token and calculated expiry only; never log token values or secrets.
- Respect the OAuth `expires_in` value. Refresh shortly before expiry using a bounded safety skew: `min(OAUTH_TOKEN_EXPIRY_SKEW_SECONDS, 10% of lifetime)`.
- Use a single-flight/in-flight-promise mechanism so concurrent requests share one refresh.
- On upstream 401, invalidate the cached token, obtain one new token, and retry the original request once only.
- In-memory cache works for a single App Service instance. For multi-instance scale-out, replace with Azure Cache for Redis.

## Important mapping rules and known gaps

- UR Advisor: ICD-driven → `/tao/icds`; `icd=9|10` reverse lookup → `/tao/procedures?resulttype=1` (ICD9) or `resulttype=2` (ICD10); FNOL-only → `/tao/fnol/{bp}/{noi}` (full TAO data returned directly, no secondary call). ICD requests with no results fall back to FNOL when `bp`/`noi` are present. Subscription `outputMode=F` → `FullOutput=1`. AU uses `proc` key.
- Best Practice Guide: map ICD-9/ICD-10 arrays to `/guidelines` (split by ICD family: letter-prefix = ICD-10); FNOL resolves via `/tao/fnol` → `data.icds[]`. Field mappings confirmed: `bestPracticeGuidelines[].{pathway,minDays,maxDays}`, `activityModifiers[].{jobType,jobModification}`, `physicalTherapyVisits[]/chiropractorVisits[].{pathway,visits,weeks}`.
- One Search: map XML `text` to `/search?query=...`; confirmed `type` values: `icd9search`, `icd10search`, `procedurescpt`, `formularyndc`, `treatment`. Result items by section: CPT → `procedureCode`, ICD → `icdCode`, PROCT → `primaryChapter`.
- Comorbidity Calculator: `requestedoutput=RasAndRtw`. Returns `riskassessment` + `adjustedduration` (omitted when `medicalonly`) + `adjustedsummaryguidelines`. No `projectedcosts`.
- Reserve Calculator: `requestedoutput=RasRtwCosts`. Always returns `projectedcosts` (bp/cp95/cp100 with indemnity/medical/expense/total as currency). Returns `adjustedduration` only when `fulloutput=Y`. No `adjustedsummaryguidelines`.
- Both Calculators: `jobclass` 1–5 → upstream integer `jobClass`; NCCI codes (any other value) padded to 4 digits → upstream string `ncci`. AU FNOL uses `toocsCodes`. `cfactors` with `applied=0` filtered from response. `preexisting` → `preExisting`. Both `odgurl` and `deeplinkurl` map to `odgByMcgLinks.duration`. `cfactors` surgery trigger selection: codes without a decimal are treated as CPT (preferred group); codes with a decimal are treated as ICD procedure (fallback group); only the last code in the preferred group is returned as the trigger. `icdcodes` FNOL deduplication (fulloutput only): when the request contains explicit ICD codes AND FNOL codes, return only the explicitly submitted ICD codes (not FNOL-resolved ones); when the request is FNOL-only (no explicit ICDs), omit `icdcodes` entirely even when `fulloutput=Y`.
- Response serialization: all legacy response keys are deep-lowercased except `primaryRTWpath` which preserves its mixed case. `null` values are serialized as empty strings (`""`) in both XML and JSON output — they are never emitted as the literal string `"null"`. Fields set to `undefined` are stripped from the output entirely. Upstream array query parameters are sent in repeated-key format without brackets (`icd10=A&icd10=B`, not `icd10[]=A&icd10[]=B`).

## Testing and delivery

- Add contract tests for every supported route covering valid requests, invalid key, disabled account, unsubscribed customer, future/expired subscription, unsupported method, malformed XML, invalid request format, no results, and upstream failures.
- Test configuration validation using `.env.example`-compatible placeholders; never commit a populated `.env` or any PHP/production credentials.
- Compare legacy PHP and adapter results manually for status, `Content-Type`, error text, XML element names/order, JSON field casing, singleton/array behavior, date/number formatting, `clientid`, and `rescount`; test both the default route (XML) and the same route with `/format/json` (JSON).
- Never log keys, secrets, bearer tokens, raw XML, or upstream payloads containing customer data. Set `ODG_DEBUG_PAYLOADS=N` in production.
- Keep PHP live and authoritative during the parallel-hostname phase; do not cut traffic over without parity sign-off and a gateway route-back path.

## Azure deployment

The application is deployed to Azure App Service via Terraform. Key resources:

| Terraform resource | Purpose |
|---|---|
| `azurerm_linux_web_app` | Node.js Express host — `app_command_line = "node dist/server.js"`, `health_check_path = "/health"` |
| `azurerm_service_plan` | B1+ for always-on |
| `azurerm_postgresql_flexible_server` | PostgreSQL 14+ — `PG_HOST = fqdn`, `PG_SSL = true` |
| `azurerm_key_vault_secret` | Stores `PG_PASSWORD` and `ODG_API_CLIENT_SECRET` |
| `azurerm_application_insights` | Telemetry and monitoring |
| `azurerm_virtual_network` + private endpoints | Private App↔DB connectivity (recommended) |

- All `.env` variables map to App Service Application Settings in Terraform (`app_settings { ... }`).
- `PG_PASSWORD` and `ODG_API_CLIENT_SECRET` must be Key Vault references, never plaintext in app settings.
- `LEGACY_PHP_REFERENCE_ROOT` and `MYSQL_*` variables must be **omitted** from Azure app settings entirely.
- Run `node data/01-create-db.js` once post-deploy (via `null_resource/local-exec`) to create the tables.

## Test input file conventions

Every test case in a comparison CSV must appear **twice** — once for XML output and once for JSON output — using the same request body/params:

- **XML row**: use the base `url_path` (e.g. `/calculator/comorbidity`, `/restws/bpguide?icd=724.2`)
- **JSON row**: append or insert `/format/json` and name it `<test_name>_json`
  - Query-string URLs: insert before `?` → `/restws/bpguide/format/json?icd=724.2`
  - Path-style URLs: append at end → `/restws/bpguide/icd/724.2/format/json`
  - POST XML endpoints: change base path → `/calculator/comorbidity/format/json`
  - Error / no-result cases must also have JSON variants — the error response format differs between XML and JSON and both must be verified

Place the XML row first, the `_json` companion row immediately after it. Do not add sparse JSON-only rows for a subset of scenarios — every scenario needs both.
