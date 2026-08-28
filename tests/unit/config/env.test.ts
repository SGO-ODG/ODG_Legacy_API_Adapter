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
    delete process.env.SQLITE_DATABASE_PATH;
    delete process.env.ODG_API_BASE_URL;
    delete process.env.OAUTH_TOKEN_URL;
    expect(() => validateEnv()).toThrow('Environment validation failed');
  });

  it('returns parsed env when all required vars are set', () => {
    process.env.SQLITE_DATABASE_PATH = './data/test.sqlite';
    process.env.ODG_API_BASE_URL = 'https://api.odgbymcg.com';
    process.env.OAUTH_TOKEN_URL = 'https://auth.example.com/token';
    const env = validateEnv();
    expect(env.SQLITE_DATABASE_PATH).toBe('./data/test.sqlite');
    expect(env.PORT).toBe(3000);
    expect(env.SQLITE_READ_ONLY).toBe(true);
  });
});
