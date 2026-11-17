import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Runtime environment — controls behaviour such as error detail and logging verbosity.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // TCP port the Express server listens on.
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // PostgreSQL connection settings for companymaster and companywebservice tables.
  PG_HOST: z.string().min(1),
  PG_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PG_DATABASE: z.string().min(1),
  PG_USER: z.string().min(1),
  PG_PASSWORD: z.string().min(1),
  // When true the pg Pool uses SSL (rejectUnauthorized: false). Set for managed cloud databases.
  PG_SSL: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .default('false'),

  // Base URL of the ODG API v1.2 (e.g. https://api.odgbymcg.com).
  ODG_API_BASE_URL: z.string().url(),
  // Sent as the X-ApiVersion header on every upstream request.
  ODG_API_VERSION: z.string().default('1.2'),
  // OAuth 2.0 token endpoint used to obtain per-company client-credentials tokens.
  OAUTH_TOKEN_URL: z.string().url(),
  // OAuth grant type — always client_credentials for machine-to-machine auth.
  OAUTH_GRANT_TYPE: z.string().default('client_credentials'),
  // Optional OAuth audience claim sent in the token request body (omit if not required by the auth server).
  OAUTH_AUDIENCE: z.string().optional(),
  // Optional space-delimited OAuth scopes sent in the token request body (omit if not required).
  OAUTH_SCOPES: z.string().optional(),
  // Seconds before a cached token's actual expiry at which it is proactively refreshed,
  // preventing requests from using a token that expires mid-flight.
  OAUTH_TOKEN_EXPIRY_SKEW_SECONDS: z.coerce.number().int().min(0).default(60),

  // Absolute path to the read-only PHP CodeIgniter reference checkout — used during development
  // to inspect legacy contract behaviour. Never required at runtime in production.
  LEGACY_PHP_REFERENCE_ROOT: z.string().optional(),

  // Set to Y to log incoming legacy request URLs, outgoing ODG API URLs, and response bodies.
  // Development only — never enable in production; responses may contain medical data.
  ODG_DEBUG_PAYLOADS: z.enum(['Y', 'N']).default('N'),
  // Maximum number of lines printed per response payload when ODG_DEBUG_PAYLOADS=Y.
  // Prevents console flooding for large bulk responses (e.g. NDC download).
  PAYLOAD_DUMP_ROW_LIMIT: z.coerce.number().int().min(1).default(100),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const messages = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${messages}`);
  }
  _env = result.data;
  return _env;
}

export function getEnv(): Env {
  if (!_env) {
    return validateEnv();
  }
  return _env;
}

export function isDebugEnabled(): boolean {
  return getEnv().ODG_DEBUG_PAYLOADS === 'Y';
}

export function getPayloadDumpRowLimit(): number {
  return getEnv().PAYLOAD_DUMP_ROW_LIMIT;
}
