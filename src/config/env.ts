// ─── AZURE DEPLOYMENT ────────────────────────────────────────────────────────
// Every variable in envSchema maps to an Azure App Service Application Setting.
// In Terraform, set them under:
//   resource "azurerm_linux_web_app" "<name>" {
//     app_settings = { PORT = "8080", NODE_ENV = "production", ... }
//   }
//
// Azure resources required for this application:
//   • azurerm_resource_group                    — logical container
//   • azurerm_service_plan                      — App Service Plan (B1+ for always-on)
//   • azurerm_linux_web_app                     — hosts the Node.js Express app
//   • azurerm_postgresql_flexible_server        — PostgreSQL 14+ (companymaster, companywebservice, webserviceusage)
//   • azurerm_postgresql_flexible_server_database — the target database (PG_DATABASE)
//   • azurerm_key_vault + azurerm_key_vault_secret — store PG_PASSWORD and ODG_API_CLIENT_SECRET
//   • azurerm_application_insights              — telemetry and monitoring (recommended)
//   • azurerm_virtual_network + private endpoints — private App↔DB connectivity (recommended)
//
// Key Vault secret references in app_settings use the syntax:
//   "@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>/)"
// ─────────────────────────────────────────────────────────────────────────────
import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Runtime environment — controls behaviour such as error detail and logging verbosity.
  // Azure app_settings: NODE_ENV = "production"
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // TCP port the Express server listens on.
  // Azure: App Service injects WEBSITES_PORT automatically (default 8080).
  // Terraform app_settings: PORT = "8080"
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // PostgreSQL connection settings for companymaster, companywebservice, and webserviceusage tables.
  // Azure resource: azurerm_postgresql_flexible_server
  // PG_HOST = azurerm_postgresql_flexible_server.<name>.fqdn
  PG_HOST: z.string().min(1),
  // Azure Flexible Server uses port 5432.
  PG_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  // Azure resource: azurerm_postgresql_flexible_server_database.<name>.name
  PG_DATABASE: z.string().min(1),
  // Azure resource: azurerm_postgresql_flexible_server.<name>.administrator_login
  PG_USER: z.string().min(1),
  // Store in Azure Key Vault. Terraform app_settings:
  //   PG_PASSWORD = "@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/pg-password/)"
  PG_PASSWORD: z.string().min(1),
  // Must be true for Azure Database for PostgreSQL — the server enforces SSL.
  // Terraform app_settings: PG_SSL = "true"
  PG_SSL: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .default('false'),

  // Client credentials for ODG API OAuth — shared across all companies.
  // Terraform app_settings: ODG_API_CLIENT_ID = "<value>"
  ODG_API_CLIENT_ID: z.string().min(1),
  // Store in Azure Key Vault. Terraform app_settings:
  //   ODG_API_CLIENT_SECRET = "@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/odg-api-client-secret/)"
  ODG_API_CLIENT_SECRET: z.string().min(1),

  // Base URL of the ODG API v1.2 (e.g. https://api.odgbymcg.com).
  // Terraform app_settings: ODG_API_BASE_URL = "https://api.odgbymcg.com"
  ODG_API_BASE_URL: z.string().url(),
  // Sent as the X-ApiVersion header on every upstream request.
  ODG_API_VERSION: z.string().default('1.2'),
  // OAuth 2.0 token endpoint used to obtain per-company client-credentials tokens.
  // Terraform app_settings: OAUTH_TOKEN_URL = "<endpoint>"
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

  // Absolute path to the read-only PHP CodeIgniter reference checkout — development only.
  // Never required at runtime in production. Omit entirely from Azure app_settings.
  LEGACY_PHP_REFERENCE_ROOT: z.string().optional(),

  // Set to Y to log incoming legacy request URLs, outgoing ODG API URLs, and response bodies.
  // MUST be N in production — responses may contain medical data.
  // Terraform app_settings: ODG_DEBUG_PAYLOADS = "N"
  ODG_DEBUG_PAYLOADS: z.enum(['Y', 'N']).default('N'),

  // When Y, every authenticated legacy request is written to the webserviceusage table.
  // Requires the webserviceusage table to exist (run data/01-create-db.js once post-deploy).
  // Terraform app_settings: USAGE_LOGGING_ENABLED = "Y"
  USAGE_LOGGING_ENABLED: z.enum(['Y', 'N']).default('N'),
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

export function isUsageLoggingEnabled(): boolean {
  return getEnv().USAGE_LOGGING_ENABLED === 'Y';
}

export function getPayloadDumpRowLimit(): number {
  return getEnv().PAYLOAD_DUMP_ROW_LIMIT;
}
