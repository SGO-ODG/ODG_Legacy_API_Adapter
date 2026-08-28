import { getDb } from './sqlite';

/**
 * Minimal DB query abstraction that decouples execution from SQL strings.
 *
 * Both `better-sqlite3` (SQLite) and `mssql` (Azure SQL) accept named
 * parameters using `@name` placeholders in SQL strings.  Switching drivers
 * therefore only requires swapping the `DbRunner` implementation — the SQL
 * strings in `companymaster.ts` and `companywebservice.ts` stay unchanged.
 *
 * `params` keys must match the `@name` placeholders in the SQL string.
 * Returns `undefined` when no row matches (mirrors `better-sqlite3` `.get()`).
 */
export interface DbRunner {
  queryOne<T>(sql: string, params: Record<string, unknown>): T | undefined;
}

/**
 * Production implementation backed by the `better-sqlite3` singleton.
 * Uses named-param syntax (`@key`) natively supported by `better-sqlite3`.
 */
export class SqliteRunner implements DbRunner {
  queryOne<T>(sql: string, params: Record<string, unknown>): T | undefined {
    return getDb().prepare<Record<string, unknown>, T>(sql).get(params);
  }
}

/** Singleton used by production code. Tests may supply their own instance. */
export const defaultRunner: DbRunner = new SqliteRunner();
