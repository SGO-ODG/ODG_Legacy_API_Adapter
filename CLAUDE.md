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

- NDC Advisor: normalize numeric input to `NNNNN-NNNN`; direct NDC uses `/formulary/ndc/{ndcCode}`, lists/keyword use `/formulary/ndc`, and `country=AU` uses PBS endpoints. Confirm mapping for legacy `GE`, `status`, and full-output `procsummary` before shipping.
- NDC Download: fetch all `/formulary/ndc` pages and return the unpaginated legacy record array. Confirm upstream page maximum and stable ordering.
- UR Advisor: map legacy ICD/CPT/procedure/country/flags/client ID/full mode into TAO inputs. Confirm `icd=9|10` ResultType values, FNOL branch semantics, and upstream parent/child grouping before shipping.
- Best Practice Guide: map ICD-9/ICD-10 arrays to `/guidelines`; resolve legacy FNOL to ICD first. Transform `code`, `description`, best-practice, activity, PT, and chiropractic collections back to legacy `icdcode`, `name`, `bp`, `activitymod`, `pt`, `chiro` fields. Confirm every nested field.
- One Search: map XML `text` to `/search?query=...`; derive `/search.type` from selected legacy databases. Confirm the allowed new `type` values, search-result item schema, and type-to-legacy mapping.
- Calculators: parse legacy XML and map ICD, procedure-summary, FNOL, claim, dates, and confounding-factor fields into `/calculator` JSON. Candidate `requestedoutput`: `RasAndRtw` for Comorbidity and `RasRtwCosts` for Reserve; confirm these values. Preserve legacy deep-link/ODG URL behavior outside the upstream response because v1.2 does not provide those fields.

## Testing and delivery

- Add contract tests for every supported route covering valid requests, invalid key, disabled account, unsubscribed customer, future/expired subscription, unsupported method, malformed XML, invalid request format, no results, and upstream failures.
- In the new Express repository, test configuration validation using `.env.example`-compatible placeholders; never commit a populated `.env` or any PHP/production credentials.
- Compare legacy PHP and adapter results manually for status, `Content-Type`, error text, XML element names/order, JSON field casing, singleton/array behavior, date/number formatting, `clientid`, and `rescount`; test both the default route (XML) and the same route with `/format/json` (JSON).
- Do not create local API-call audit or usage logs. Database access is read-only; ODG API logs are the audit source. Never log keys, secrets, bearer tokens, raw XML, or upstream payloads containing customer data.
- Keep PHP live and authoritative during the parallel-hostname phase; do not cut traffic over without parity sign-off and a gateway route-back path.
