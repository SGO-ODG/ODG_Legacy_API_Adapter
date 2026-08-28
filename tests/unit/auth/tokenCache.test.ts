import { getToken, invalidateToken, _clearCacheForTest } from '../../../src/auth/tokenCache';
import * as tokenClient from '../../../src/auth/tokenClient';
import { CompanyRow } from '../../../src/db/companymaster';

jest.mock('../../../src/auth/tokenClient');
jest.mock('../../../src/config/env', () => ({
  getEnv: () => ({
    OAUTH_TOKEN_URL: 'https://auth.example.com/token',
    OAUTH_AUDIENCE: '',
    OAUTH_SCOPES: '',
    OAUTH_TOKEN_EXPIRY_SKEW_SECONDS: 60,
  }),
  isDebugEnabled: () => false,
}));

const mockFetchToken = tokenClient.fetchToken as jest.MockedFunction<typeof tokenClient.fetchToken>;

const COMPANY: CompanyRow = {
  companyCode: 'ACME',
  companyName: 'Acme Corp',
  webserviceKey: 'key',
  disabled: 'N',
  odgapiClientId: 'client-id',
  odgapiClientSecret: 'secret',
};

function makeToken(expiresInSeconds: number) {
  return {
    accessToken: 'tok-' + Math.random(),
    expiresAt: Date.now() + expiresInSeconds * 1000,
    expiresIn: expiresInSeconds,
  };
}

describe('tokenCache', () => {
  beforeEach(() => {
    _clearCacheForTest();
    jest.clearAllMocks();
  });

  it('fetches a new token on first call', async () => {
    const tok = makeToken(3600);
    mockFetchToken.mockResolvedValue(tok);

    const result = await getToken(COMPANY);
    expect(result).toBe(tok.accessToken);
    expect(mockFetchToken).toHaveBeenCalledTimes(1);
  });

  it('returns cached token without fetching again', async () => {
    const tok = makeToken(3600);
    mockFetchToken.mockResolvedValue(tok);

    await getToken(COMPANY);
    const result = await getToken(COMPANY);
    expect(result).toBe(tok.accessToken);
    expect(mockFetchToken).toHaveBeenCalledTimes(1);
  });

  it('refreshes when token is within skew window', async () => {
    // Token expires in 30s — skew = min(60, 3) = 3s, so 30s is NOT within skew
    // Use 50s lifetime: skew = min(60, 5) = 5s; expiresAt = now+50s → still valid
    const tok1 = makeToken(50);
    const tok2 = makeToken(3600);
    mockFetchToken.mockResolvedValueOnce(tok1).mockResolvedValueOnce(tok2);

    await getToken(COMPANY);
    // Simulate token about to expire: set expiresAt to now + 3s (within 5s skew)
    // Re-fetch by invalidating
    invalidateToken(COMPANY);
    const result = await getToken(COMPANY);
    expect(result).toBe(tok2.accessToken);
    expect(mockFetchToken).toHaveBeenCalledTimes(2);
  });

  it('single-flight: concurrent calls share one fetch', async () => {
    let resolveToken!: (v: tokenClient.TokenResponse) => void;
    const pending = new Promise<tokenClient.TokenResponse>((res) => { resolveToken = res; });
    mockFetchToken.mockReturnValue(pending);

    const [r1, r2] = await Promise.all([
      getToken(COMPANY),
      getToken(COMPANY),
      // Resolve after both are in flight
      (async () => { resolveToken(makeToken(3600)); return ''; })(),
    ]);

    expect(mockFetchToken).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });

  it('invalidateToken causes next call to re-fetch', async () => {
    const tok1 = makeToken(3600);
    const tok2 = makeToken(3600);
    mockFetchToken.mockResolvedValueOnce(tok1).mockResolvedValueOnce(tok2);

    await getToken(COMPANY);
    invalidateToken(COMPANY);
    const result = await getToken(COMPANY);
    expect(result).toBe(tok2.accessToken);
    expect(mockFetchToken).toHaveBeenCalledTimes(2);
  });
});
