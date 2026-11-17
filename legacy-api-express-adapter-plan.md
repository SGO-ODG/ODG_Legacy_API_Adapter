# Express legacy API compatibility adapter

## Summary

Build a Node.js/Express service on a parallel hostname that exposes the existing CodeIgniter routes unchanged, validates `X-ODG-KEY` against the legacy subscription model (PostgreSQL — companymaster, companywebservice, webserviceusage), calls ODG API v1.2 using cached OAuth client-credentials tokens, and converts upstream responses into the current legacy wire format.

The Express project is maintained in a separate Git repository. Keep this PHP checkout at `C:\Saurabh\MyApps\Apache24\odgci_3.1.11` as a read-only development/reference checkout; configure it in the Express repository through `LEGACY_PHP_REFERENCE_ROOT`. Never require this path at runtime.

Active routes: UR Advisor, Best Practice Guide, One Search, Comorbidity Calculator, and Reserve Calculator. NDC Advisor and NDC Download have been removed from scope. Procedure Summary and Summary Guide are end-of-life and are excluded from the Express compatibility layer.

## Implementation changes

- Preserve legacy route, HTTP method, XML POST payload, `X-ODG-KEY`, response status, and error body. Return XML for every legacy request by default; return JSON only when the path ends in `/format/json`. Do not select output from `Accept`, extensions, query parameters, or any other format negotiation.
- Implement legacy authorization using `companymaster` and `companywebservice`: look up `webserviceKey`, reject `disabled=Y`, validate the requested service subscription and its start/end dates, and derive subscription `outputMode`. Use a static legacy-service registry for the supported migrated routes; do not depend on `webservicemaster` or implement a maintenance state. `webserviceusage` is a write-only usage log table populated by the usage logger middleware (fire-and-forget, controlled by `USAGE_LOGGING_ENABLED`).
- Implement a legacy error-response layer before every upstream call. It must preserve the `RestController` HTTP status, `error` property, and exact error text for key, service, subscription, method, request-format, XML-validation, and endpoint no-result failures; never expose OAuth or upstream error bodies.
- Add a database access layer with parameterized, read-only authentication/subscription queries only. Do not implement a usage-log writer or any database write path. Keep database and OAuth credentials solely in environment/secret configuration.
- Connect to a PostgreSQL database using `PG_*` environment variables. Add a placeholder-only `.env.example` and ignore the populated `.env`; do not reuse or commit PHP database credentials. Run `data/01-create-db.js` once to create the three tables.
- Add a shared OAuth client-credentials client configured through `OAUTH_TOKEN_URL`, audience, scopes, and upstream API version (`X-ApiVersion: 1.2`). After legacy validation, use the shared `ODG_API_CLIENT_ID` and `ODG_API_CLIENT_SECRET` from environment configuration — credentials are not stored per-company in the database. Cache one bearer token (keyed on token URL, client ID, audience, scopes) until shortly before the `expires_in` value (for example 3600 or 7200 seconds). Coalesce concurrent refreshes for the same cache key; invalidate and refresh once on an upstream 401, then retry once.
- Implement declarative request/response transformers:
  - `uradvisor` -> `/tao/icds` (ICD-driven), `/tao/procedures` (icd=9|10 reverse lookup with `resulttype=1`/`2`), or `/tao/fnol/{bp}/{noi}` (FNOL-only). FNOL response (`items[].taoDataItems[]`) is used directly without a secondary `/tao/icds` call. ICD requests with no results fall back to FNOL when `bp`/`noi` are also provided. AU uses `proc` key; subscription `outputMode=F` maps to `FullOutput=1`.
  - `bpguide` -> `/guidelines`, translating legacy ICD or FNOL-derived ICD input and transforming its guideline data into the legacy Best Practice Guide response shape.
  - `onesearch` -> `GET /search?query=<text>&type=<types>&facets=false&country=US`. Confirmed type values: `icd9search`, `icd10search`, `procedurescpt`, `formularyndc`, `treatment`. Response `resultSets[].section` maps back to legacy `type` values. CPT items use `procedureCode`; ICD items use `icdCode`; PROCT items use `primaryChapter`.
  - `calculator/comorbidity` -> `POST /calculator` with `requestedoutput=RasAndRtw`. Returns `riskassessment`, `adjustedduration` (suppressed when `medicalonly` is set), `adjustedsummaryguidelines`. Does not return `projectedcosts`.
  - `calculator/reserve` -> `POST /calculator` with `requestedoutput=RasRtwCosts`. Always returns `projectedcosts` (bp/cp95/cp100 tiers with indemnity/medical/expense/total as currency). Returns `adjustedduration` only when `fulloutput=Y`. Does not return `adjustedsummaryguidelines`.
  - Both calculators: `jobclass` 1–5 maps to integer `jobClass`; any other value (NCCI) pads to 4 digits and maps to string `ncci`. AU FNOL uses `toocsCodes` instead of `fnolCodes`. `cfactors` with `applied=0` are filtered from the response. `preexisting` maps to `preExisting` upstream. Both `odgurl` and `deeplinkurl` map to `odgByMcgLinks.duration`.
- Transform every successful ODG response into the complete legacy response model before serialization; emit the exact existing legacy XML by default or the exact legacy JSON only for `/format/json`. Preserve legacy wrappers, field casing/names, nesting, array/singleton behavior, conditional field omission, XML ordering, date/number/currency formatting, and response errors. Normalize upstream failures, timeouts, malformed responses, and absent results into exact legacy error status/body semantics. Do not expose OAuth errors, upstream URLs, or new response fields to customers.
- Serialization pipeline (both XML and JSON): (1) deep-lowercase all output keys — exception: `primaryRTWpath` preserves its mixed case and must not be lowercased; (2) strip fields with value `undefined` entirely; (3) convert `null` values to empty strings (`""`) — never emit literal `"null"` or JSON `null` in legacy output. Upstream array query parameters must use repeated-key format without brackets (`icd10=A&icd10=B`, not `icd10[]=A`).
- Treat `/restws/procsum` and `/restws/sumguide` as explicitly end-of-life: do not implement or silently approximate them in Express. Keep their PHP routing only for the agreed retirement period, then return the approved legacy EOL response through the gateway. The adapter is temporary and supports only already subscribed legacy customers; it performs no customer or subscription provisioning.

## Validation and release

- Manually validate every supported endpoint, including the `/restws/bpguide` to `/guidelines` transformation, with representative valid, invalid, unauthorized, disabled, expired, unsubscribed, no-result, malformed-XML, and upstream-failure requests in XML, JSON, and CSV/output-format variants.
- Compare status, content type, XML element names/order, JSON key casing, arrays, dates/numbers, echoed `clientid`, and error text against the PHP API for each test request.
- Use `application/controllers/Restws.php`, `application/controllers/Calculator.php`, `application/libraries/RestController.php`, and the relevant models from the reference checkout to resolve contract details not captured by fixtures or the mapping review.
- Provide health/readiness checks for the database tables, token acquisition, and upstream reachability. Usage records are written to webserviceusage via usageLoggerMiddleware when `USAGE_LOGGING_ENABLED=Y`. ODG API logs are the primary audit source.
- Deploy on the parallel hostname with PHP remaining authoritative. Move traffic only through explicit gateway/DNS configuration after manual parity sign-off, while retaining an immediate route-back to PHP.

## Assumptions

- The new API exposes a client-credentials token endpoint; its URL and credentials are delivered as deployment secrets.
- API v1.2 is the fixed upstream contract for this adapter.
- `companymaster` and `companywebservice` are read-only validation tables; `webserviceusage` is a write-only usage log table; `webservicemaster` is not used.
- Legacy customers continue to use only `X-ODG-KEY`; no new customer OAuth requirement is introduced. OAuth client credentials (`ODG_API_CLIENT_ID` / `ODG_API_CLIENT_SECRET`) are shared across all companies and stored in environment configuration, not in the database.
