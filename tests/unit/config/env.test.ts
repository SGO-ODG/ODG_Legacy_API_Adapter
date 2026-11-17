import { validateEnv } from '../../../src/config/env';

describe('validateEnv', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
  });

  afterEach(() => {
    process.env = original;
  });

  it('throws when required vars are missing', () => {
    delete process.env.PG_HOST;
    delete process.env.PG_DATABASE;
    delete process.env.PG_USER;
    delete process.env.PG_PASSWORD;
    delete process.env.ODG_API_BASE_URL;
    delete process.env.OAUTH_TOKEN_URL;
    expect(() => validateEnv()).toThrow('Environment validation failed');
  });

  it('returns parsed env when all required vars are set', () => {
    process.env.PG_HOST = 'localhost';
    process.env.PG_DATABASE = 'odg_legacy';
    process.env.PG_USER = 'odg_user';
    process.env.PG_PASSWORD = 'secret';
    process.env.ODG_API_BASE_URL = 'https://api.odgbymcg.com';
    process.env.OAUTH_TOKEN_URL = 'https://auth.example.com/token';
    const env = validateEnv();
    expect(env.PG_HOST).toBe('localhost');
    expect(env.PG_PORT).toBe(5432);
    expect(env.PG_DATABASE).toBe('odg_legacy');
    expect(env.PG_SSL).toBe(false);
    expect(env.PORT).toBe(3000);
  });
});
