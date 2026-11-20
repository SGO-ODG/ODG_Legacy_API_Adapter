import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  InternalAxiosRequestConfig,
} from 'axios';
import { getEnv, isDebugEnabled, getPayloadDumpRowLimit } from '../config/env';
import { getToken, invalidateToken } from '../auth/tokenCache';

// Extend Axios config to carry retry metadata
interface OdgRequestConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

/** Internal error representing an upstream failure. Never exposed to callers as-is. */
export class UpstreamError extends Error {
  constructor(
    public readonly statusCode: number | undefined,
    message: string,
    public readonly upstreamBody?: unknown,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

let _client: AxiosInstance | undefined;

function buildClient(): AxiosInstance {
  const env = getEnv();

  const instance = axios.create({
    baseURL: env.ODG_API_BASE_URL,
    timeout: 30_000,
    headers: {
      'X-ApiVersion': env.ODG_API_VERSION,
      Accept: 'application/json',
    },
    // Serialize arrays as repeated params without brackets: icd10=A&icd10=B
    // Axios default produces icd10[]=A&icd10[]=B which ODG API does not accept.
    paramsSerializer: (params: Record<string, unknown>) => {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
          }
        } else if (value !== undefined && value !== null) {
          parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        }
      }
      return parts.join('&');
    },
  });

  // Request interceptor: inject shared Bearer token, then log final headers when debug is on
  instance.interceptors.request.use(async (config: OdgRequestConfig) => {
    const token = await getToken();
    config.headers = config.headers ?? {};
    config.headers['Authorization'] = `Bearer ${token}`;
    if (isDebugEnabled()) {
      // Flatten AxiosHeaders to a plain object for readable logging
      const raw = config.headers?.toJSON?.() ?? { ...config.headers };
      const display: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        display[k] = k.toLowerCase() === 'authorization'
          ? `Bearer ${String(v).slice(7, 15)}...[masked]`
          : v;
      }
      console.log(`[ODG HEADERS] ${JSON.stringify(display)}`);
    }
    return config;
  });

  // Response interceptor: handle 401 with one retry using a fresh token
  instance.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config as OdgRequestConfig | undefined;
      if (error.response?.status === 401 && !config?._retry) {
        config!._retry = true;
        invalidateToken();
        const token = await getToken();
        config!.headers['Authorization'] = `Bearer ${token}`;
        return instance.request(config!);
      }

      // Log the raw ODG error response body before wrapping
      if (isDebugEnabled() && error.response) {
        console.log(
          `[ODG ERR] ${error.response.status} ${config?.url ?? ''}: ${JSON.stringify(error.response.data)}`,
        );
      }

      // Wrap all upstream errors so callers never see raw Axios errors
      const status: number | undefined = error.response?.status;
      const body: unknown = error.response?.data;
      const msg = status
        ? `Upstream returned HTTP ${status}`
        : `Upstream request failed: ${error.message}`;
      throw new UpstreamError(status, msg, body);
    },
  );

  return instance;
}

export function getOdgClient(): AxiosInstance {
  if (!_client) _client = buildClient();
  return _client;
}

/** For tests only. */
export function _resetClientForTest(): void {
  _client = undefined;
}

/**
 * Makes a GET request to ODG API v1.2 using the shared OAuth token.
 * @param path     e.g. '/formulary/ndc/12345-6789'
 * @param params   Query string parameters.
 */
export async function odgGet<T>(
  path: string,
  params?: Record<string, string | string[] | number | boolean | undefined>,
): Promise<T> {
  const debug = isDebugEnabled();
  const client = getOdgClient();
  if (debug) {
    const fullUrl = client.getUri({ url: path, params });
    console.log(`[ODG REQ] GET ${fullUrl}`);
  }
  try {
    const response = await client.get<T>(path, { params } as AxiosRequestConfig);
    if (debug) {
      const lines = JSON.stringify(response.data, null, 2).split('\n');
      const limit = getPayloadDumpRowLimit();
      const truncated = lines.length > limit ? lines.slice(0, limit).join('\n') + `\n... [truncated at ${limit} lines]` : lines.join('\n');
      console.log(`[ODG RES] ${response.status} ${path}\n${truncated}`);
    }
    return response.data;
  } catch (err) {
    if (debug) {
      console.log(`[ODG ERR] GET ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  }
}

/**
 * Makes a POST request to ODG API v1.2 using the shared OAuth token.
 */
export async function odgPost<T>(
  path: string,
  body: unknown,
): Promise<T> {
  const debug = isDebugEnabled();
  const client = getOdgClient();
  if (debug) {
    const fullUrl = client.getUri({ url: path });
    console.log(`[ODG REQ] POST ${fullUrl}\n${JSON.stringify(body, null, 2)}`);
  }
  try {
    const response = await client.post<T>(path, body);
    if (debug) {
      const lines = JSON.stringify(response.data, null, 2).split('\n');
      const limit = getPayloadDumpRowLimit();
      const truncated = lines.length > limit ? lines.slice(0, limit).join('\n') + `\n... [truncated at ${limit} lines]` : lines.join('\n');
      console.log(`[ODG RES] ${response.status} ${path}\n${truncated}`);
    }
    return response.data;
  } catch (err) {
    if (debug) {
      console.log(`[ODG ERR] POST ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  }
}
