# Express legacy API compatibility adapter

## Summary

Build a Node.js/Express service on a parallel hostname that exposes the existing CodeIgniter routes unchanged, validates `X-ODG-KEY` against the legacy subscription model (using local read-only SQLite during initial development), calls ODG API v1.2 using cached OAuth client-credentials tokens, and converts upstream responses into the current legacy wire format.

The Express project is maintained in a separate Git repository. Keep this PHP checkout at `C:\Saurabh\MyApps\Apache24\odgci_3.1.11` as a read-only development/reference checkout; configure it in the Express repository through `LEGACY_PHP_REFERENCE_ROOT`. Never require this path at runtime.

First release covers: NDC Advisor, NDC Download, UR Advisor, Best Practice Guide, One Search, Comorbidity Calculator, and Reserve Calculator. Procedure Summary and Summary Guide are end-of-life and are excluded from the Express compatibility layer.

## Implementation changes

- Preserve legacy route, HTTP method, XML POST payload, `X-ODG-KEY`, response status, and error body. Return XML for every legacy request by default; return JSON only when the path ends in `/format/json`. Do not select output from `Accept`, extensions, query parameters, or any other format negotiation.
- Implement legacy authorization using only `companymaster` and `companywebservice`: look up `webserviceKey`, reject `disabled=Y`, validate the requested service subscription and its start/end dates, and derive subscription `outputMode`. Use a static legacy-service registry for the supported migrated routes; do not depend on `webservicemaster`, implement a maintenance state, or write to `webserviceusage`.
- Implement a legacy error-response layer before every upstream call. It must preserve the `RestController` HTTP status, `error` property, and exact error text for key, service, subscription, method, request-format, XML-validation, and endpoint no-result failures; never expose OAuth or upstream error bodies.
- Add a database access layer with parameterized, read-only authentication/subscription queries only. Do not implement a usage-log writer or any database write path. Keep database and OAuth credentials solely in environment/secret configuration.
- For initial development, use a local SQLite database opened in read-only mode and containing only `companymaster` and `companywebservice`. When the Express repository is created, add a placeholder-only `.env.example` with `SQLITE_DATABASE_PATH` and ignore the populated `.env`; do not reuse or commit PHP database credentials.
- Add a per-customer OAuth client-credentials client configured through `OAUTH_TOKEN_URL`, audience, scopes, and upstream API version (`X-ApiVersion: 1.2`). After legacy validation, use the matching company `odgapiClientId` and `odgapiClientSecret`; cache one bearer token per customer/token audience/scope until shortly before the token response `expires_in` value (for example 3600 or 7200 seconds). Coalesce concurrent refreshes for the same cache key; invalidate and refresh once on an upstream 401, then retry once.
- Implement declarative request/response transformers:
  - `ndcadvisor` and `ndcdownload` -> `/formulary/ndc` or `/formulary/ndc/{ndcCode}`; use `/formulary/pbs` for the existing Australian/PBS behavior; page through NDC results for downloads.
  - `uradvisor` -> `/tao/icds`, carrying normalized ICD/procedure, country, flags, client ID, and subscription output mode.
  - `bpguide` -> `/guidelines`, translating legacy ICD or FNOL-derived ICD input and transforming its guideline data into the legacy Best Practice Guide response shape.
  - `onesearch` -> `/search`, translating the legacy XML database selections to the new search filters and restoring legacy result grouping.
  - `calculator/comorbidity` and `calculator/reserve` -> `POST /calculator`; parse legacy XML and translate its codes, procedure summary, FNOL fields, dates, claim factors, full-output flag, and client ID. Set the v1.2 `requestedoutput` enum to the combination that reproduces the respective legacy calculation.
- Transform every successful ODG response into the complete legacy response model before serialization; emit the exact existing legacy XML by default or the exact legacy JSON only for `/format/json`. Preserve legacy wrappers, field casing/names, nesting, array/singleton behavior, conditional field omission, XML ordering, date/number/currency formatting, and response errors. Normalize upstream failures, timeouts, malformed responses, and absent results into exact legacy error status/body semantics. Do not expose OAuth errors, upstream URLs, or new response fields to customers.
- Treat `/restws/procsum` and `/restws/sumguide` as explicitly end-of-life: do not implement or silently approximate them in Express. Keep their PHP routing only for the agreed retirement period, then return the approved legacy EOL response through the gateway. The adapter is temporary and supports only already subscribed legacy customers; it performs no customer or subscription provisioning.

## Validation and release

- Manually validate every supported endpoint, including the `/restws/bpguide` to `/guidelines` transformation, with representative valid, invalid, unauthorized, disabled, expired, unsubscribed, no-result, malformed-XML, and upstream-failure requests in XML, JSON, and CSV/output-format variants.
- Compare status, content type, XML element names/order, JSON key casing, arrays, dates/numbers, echoed `clientid`, and error text against the PHP API for each test request.
- Use `application/controllers/Restws.php`, `application/controllers/Calculator.php`, `application/libraries/RestController.php`, and the relevant models from the reference checkout to resolve contract details not captured by fixtures or the mapping review.
- Provide health/readiness checks for the two database tables, per-customer token acquisition, and upstream reachability; do not write local usage or audit records; database access is read-only and ODG API logs are the audit source.
- Deploy on the parallel hostname with PHP remaining authoritative. Move traffic only through explicit gateway/DNS configuration after manual parity sign-off, while retaining an immediate route-back to PHP.

## Assumptions

- The new API exposes a client-credentials token endpoint; its URL and credentials are delivered as deployment secrets.
- API v1.2 is the fixed upstream contract for this adapter.
- Only `companymaster` and `companywebservice` are available to the Node service; `webservicemaster` and `webserviceusage` are not.
- Legacy customers continue to use only `X-ODG-KEY`; no new customer OAuth requirement is introduced. OAuth client credentials are selected from the validated customer record.
