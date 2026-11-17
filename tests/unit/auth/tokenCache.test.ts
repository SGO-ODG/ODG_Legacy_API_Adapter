import { getToken, invalidateToken, _clearCacheForTest } from '../../../src/auth/tokenCache';
import * as tokenClient from '../../../src/auth/tokenClient';

jest.mock('../../../src/auth/tokenClient');
jest.mock('../../../src/config/env', () => ({
  getEnv: () => ({
    OAUTH_TOKEN_URL: 'https://auth.example.com/token',
    ODG_API_CLIENT_ID: 'client-id',
    ODG_API_CLIENT_SECRET: 'secret',
    OAUTH_AUDIENCE: '',
    OAUTH_SCOPES: '',
    OAUTH_TOKEN_EXPIRY_SKEW_SECONDS: 60,
  }),
  isDebugEnabled: () => false,
}));

const mockFetchToken = tokenClient.fetchToken as jest.MockedFunction<typeof tokenClient.fetchToken>;

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

    const result = await getToken();
    expect(result).toBe(tok.accessToken);
    expect(mockFetchToken).toHaveBeenCalledTimes(1);
    expect(mockFetchToken).toHaveBeenCalledWith('client-id', 'secret');
  });

  it('returns cached token without fetching again', async () => {
    const tok = makeToken(3600);
    mockFetchToken.mockResolvedValue(tok);

    await getToken();
    const result = await getToken();
    expect(result).toBe(tok.accessToken);
    expect(mockFetchToken).toHaveBeenCalledTimes(1);
  });

  it('refreshes after invalidation', async () => {
    const tok1 = makeToken(3600);
    const tok2 = makeToken(3600);
    mockFetchToken.mockResolvedValueOnce(tok1).mockResolvedValueOnce(tok2);

    await getToken();
    invalidateToken();
    const result = await getToken();
    expect(result).toBe(tok2.accessToken);
    expect(mockFetchToken).toHaveBeenCalledTimes(2);
  });

  it('single-flight: concurrent calls share one fetch', async () => {
    let resolveToken!: (v: tokenClient.TokenResponse) => void;
    const pending = new Promise<tokenClient.TokenResponse>((res) => { resolveToken = res; });
    mockFetchToken.mockReturnValue(pending);

    const [r1, r2] = await Promise.all([
      getToken(),
      getToken(),
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

    await getToken();
    invalidateToken();
    const result = await getToken();
    expect(result).toBe(tok2.accessToken);
    expect(mockFetchToken).toHaveBeenCalledTimes(2);
  });
});
