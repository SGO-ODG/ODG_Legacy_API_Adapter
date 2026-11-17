/**
 * Global test setup — sets the minimum required environment variables so that
 * validateEnv() succeeds in all test files without a real database or ODG API.
 * Tests that need specific values override these in their own beforeEach/beforeAll.
 */
process.env.PG_HOST     = process.env.PG_HOST     ?? 'localhost';
process.env.PG_DATABASE = process.env.PG_DATABASE ?? 'odg_legacy_test';
process.env.PG_USER     = process.env.PG_USER     ?? 'test';
process.env.PG_PASSWORD = process.env.PG_PASSWORD ?? 'test';
process.env.ODG_API_BASE_URL = process.env.ODG_API_BASE_URL ?? 'https://api.odgbymcg.com';
process.env.OAUTH_TOKEN_URL  = process.env.OAUTH_TOKEN_URL  ?? 'https://auth.example.com/token';
