import { getPool } from './postgres';

/**
 * Minimal async DB query abstraction that decouples execution from SQL strings.
 *
 * Uses PostgreSQL positional parameter syntax ($1, $2, ...).
 * `params` is an ordered array matching the $N placeholders in the SQL string.
 * Returns `undefined` when no row matches.
 */
export interface DbRunner {
  queryOne<T extends object>(sql: string, params: unknown[]): Promise<T | undefined>;
}

/**
 * Production implementation backed by the `pg` Pool singleton.
 */
export class PostgresRunner implements DbRunner {
  async queryOne<T extends object>(sql: string, params: unknown[]): Promise<T | undefined> {
    const result = await getPool().query<T>(sql, params);
    return result.rows[0];
  }
}

/** Singleton used by production code. Tests may supply their own instance. */
export const defaultRunner: DbRunner = new PostgresRunner();
