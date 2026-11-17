import { Pool } from 'pg';
import { getEnv } from '../config/env';

let _pool: Pool | undefined;

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
