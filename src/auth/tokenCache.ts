import { fetchToken, TokenResponse } from './tokenClient';
import { getEnv, isDebugEnabled } from '../config/env';

interface CacheEntry {
  accessToken: string;
  expiresAt: number;
  expiresIn: number;
}

// In-memory token cache — works correctly for a single App Service instance.
// Azure: when the App Service Plan is scaled out to multiple instances, each instance
// maintains its own independent cache and obtains separate OAuth tokens. This is safe
// (no shared state corruption) but increases OAuth token requests under scale-out.
// For a scaled deployment, replace this with Azure Cache for Redis:
//   Terraform resource: azurerm_redis_cache
//   Replace Map reads/writes with ioredis get/set calls keyed on buildCacheKey().

/** In-memory cache: cacheKey → CacheEntry */
const cache = new Map<string, CacheEntry>();

/** In-flight promises for single-flight coordination */
const inFlight = new Map<string, Promise<TokenResponse>>();

/**
 * Builds a non-secret cache key from the shared OAuth configuration.
 * clientSecret is intentionally excluded.
 */
function buildCacheKey(): string {
  const env = getEnv();
  return [
    env.OAUTH_TOKEN_URL,
    env.ODG_API_CLIENT_ID,
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

/** Returns the shared bearer token, refreshing if near expiry. */
export async function getToken(): Promise<string> {
  const key = buildCacheKey();
  const entry = cache.get(key);

  if (entry) {
    const skew = skewSeconds(entry.expiresIn) * 1000;
    if (Date.now() < entry.expiresAt - skew) {
      if (isDebugEnabled()) {
        const ttl = Math.round((entry.expiresAt - skew - Date.now()) / 1000);
        console.log(`[TOKEN CACHE] HIT ttl:${ttl}s`);
      }
      return entry.accessToken;
    }
    if (isDebugEnabled()) {
      console.log(`[TOKEN CACHE] EXPIRED — refreshing`);
    }
  } else if (isDebugEnabled()) {
    console.log(`[TOKEN CACHE] MISS — fetching new token`);
  }

  return refreshToken(key);
}

/** Invalidates the cached shared token (called on upstream 401). */
export function invalidateToken(): void {
  const key = buildCacheKey();
  cache.delete(key);
}

async function refreshToken(key: string): Promise<string> {
  // Single-flight: if a refresh is already in progress, await it
  const existing = inFlight.get(key);
  if (existing) {
    const result = await existing;
    return result.accessToken;
  }

  const env = getEnv();
  const promise = fetchToken(env.ODG_API_CLIENT_ID, env.ODG_API_CLIENT_SECRET);
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
