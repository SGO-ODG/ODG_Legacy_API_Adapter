import { Pool } from 'pg';
import { getEnv } from '../config/env';

let _pool: Pool | undefined;

// Azure: PG_HOST = azurerm_postgresql_flexible_server.<name>.fqdn
//        PG_SSL must be true — Azure Database for PostgreSQL enforces SSL by default.
//        Recommended: deploy App Service with VNet integration and add a private endpoint
//        on the PostgreSQL Flexible Server to remove it from the public internet.
//        Pool sizing: set max connections to stay within the server's connection limit;
//        multiply by the number of App Service instances when scaled out.
export function getPool(): Pool {
  if (_pool) return _pool;

  const env = getEnv();

  _pool = new Pool({
    host: env.PG_HOST,
    port: env.PG_PORT,
    database: env.PG_DATABASE,
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    ssl: env.PG_SSL ? { rejectUnauthorized: false } : false,
  });

  return _pool;
}

/** For use in tests only — resets the singleton so a new pool can be injected. */
export async function _resetPoolForTest(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}
