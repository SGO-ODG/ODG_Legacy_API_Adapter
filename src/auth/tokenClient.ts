import axios from 'axios';
import { getEnv, isDebugEnabled } from '../config/env';

export interface TokenResponse {
  accessToken: string;
  /** Unix timestamp (ms) after which the token must be refreshed. */
  expiresAt: number;
  /** Lifetime in seconds as reported by the OAuth server. */
  expiresIn: number;
}

/**
 * Fetches a client-credentials OAuth token for the given client.
 * Never logs the clientSecret or returned accessToken.
 */
export async function fetchToken(
  clientId: string,
  clientSecret: string,
): Promise<TokenResponse> {
  const env = getEnv();

  const params = new URLSearchParams();
  params.set('grant_type', env.OAUTH_GRANT_TYPE);
  params.set('client_id', clientId);
  params.set('client_secret', clientSecret);
  // Only include optional fields when they contain real values (not un-replaced placeholders)
  if (env.OAUTH_AUDIENCE && !env.OAUTH_AUDIENCE.startsWith('<')) params.set('audience', env.OAUTH_AUDIENCE);
  if (env.OAUTH_SCOPES && !env.OAUTH_SCOPES.startsWith('<')) params.set('scope', env.OAUTH_SCOPES);

  const debug = isDebugEnabled();
  if (debug) {
    const masked = clientSecret.length > 8
      ? `${clientSecret.slice(0, 4)}....${clientSecret.slice(-4)}`
      : '********';
    const audience = params.get('audience') ?? '(none)';
    const scope = params.get('scope') ?? '(none)';
    console.log(`[TOKEN REQ] POST ${env.OAUTH_TOKEN_URL} grant_type:${env.OAUTH_GRANT_TYPE} client_id:${clientId} secret:${masked} audience:${audience} scope:${scope}`);
  }

  let response: Awaited<ReturnType<typeof axios.post<{ access_token: string; expires_in: number }>>>;
  try {
    response = await axios.post<{ access_token: string; expires_in: number }>(
      env.OAUTH_TOKEN_URL,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
  } catch (err) {
    if (debug) {
      const status = (err as { response?: { status?: number } }).response?.status;
      console.log(`[TOKEN ERR] ${status ?? 'no-response'}: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  }

  if (debug) {
    console.log(`[TOKEN RES] ${response.status} expires_in:${response.data.expires_in}s`);
  }

  const { access_token, expires_in } = response.data;
  const expiresAt = Date.now() + expires_in * 1000;

  return { accessToken: access_token, expiresAt, expiresIn: expires_in };
}
