import { CompanyRow } from '../db/companymaster';
import { fetchToken, TokenResponse } from './tokenClient';
import { getEnv, isDebugEnabled } from '../config/env';

interface CacheEntry {
  accessToken: string;
  expiresAt: number;
  expiresIn: number;
}

/** In-memory cache: cacheKey → CacheEntry */
const cache = new Map<string, CacheEntry>();

/** In-flight promises for single-flight coordination */
const inFlight = new Map<string, Promise<TokenResponse>>();

/**
 * Builds a non-secret cache key that identifies the token configuration.
 * Uses companyCode + tokenUrl + clientId + audience + scopes.
 * clientSecret is intentionally excluded.
 */
function buildCacheKey(company: CompanyRow): string {
  const env = getEnv();
  return [
    company.companyCode,
    env.OAUTH_TOKEN_URL,
    company.odgapiClientId,
    env.OAUTH_AUDIENCE ?? '',
    env.OAUTH_SCOPES ?? '',
  ].join('::');
}

/**
 * Returns the number of seconds before actual expiry to treat the token as
 * expired. Bounded to min(60, 10% of lifetime).
 */
function skewSeconds(expiresIn: number): number {
  const env = getEnv();
  const configured = env.OAUTH_TOKEN_EXPIRY_SKEW_SECONDS;
  return Math.min(configured, Math.floor(expiresIn * 0.1));
}

/** Returns a valid bearer token for the company, refreshing if needed. */
export async function getToken(company: CompanyRow): Promise<string> {
  const key = buildCacheKey(company);
  const entry = cache.get(key);

  if (entry) {
    const skew = skewSeconds(entry.expiresIn) * 1000;
    if (Date.now() < entry.expiresAt - skew) {
      if (isDebugEnabled()) {
        const ttl = Math.round((entry.expiresAt - skew - Date.now()) / 1000);
        console.log(`[TOKEN CACHE] HIT company:${company.companyCode} ttl:${ttl}s`);
      }
      return entry.accessToken;
    }
    if (isDebugEnabled()) {
      console.log(`[TOKEN CACHE] EXPIRED company:${company.companyCode} — refreshing`);
    }
  } else if (isDebugEnabled()) {
    console.log(`[TOKEN CACHE] MISS company:${company.companyCode} — fetching new token`);
  }

  return refreshToken(company, key);
}

/** Invalidates a cached token (called on upstream 401). */
export function invalidateToken(company: CompanyRow): void {
  const key = buildCacheKey(company);
  cache.delete(key);
}

async function refreshToken(company: CompanyRow, key: string): Promise<string> {
  // Single-flight: if a refresh is already in progress for this key, await it
  const existing = inFlight.get(key);
  if (existing) {
    const result = await existing;
    return result.accessToken;
  }

  const promise = fetchToken(company.odgapiClientId, company.odgapiClientSecret);
  inFlight.set(key, promise);

  try {
    const token = await promise;
    cache.set(key, {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      expiresIn: token.expiresIn,
    });
    return token.accessToken;
  } finally {
    inFlight.delete(key);
  }
}

/** For tests only — clears the entire cache. */
export function _clearCacheForTest(): void {
  cache.clear();
  inFlight.clear();
}
