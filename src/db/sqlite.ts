import Database from 'better-sqlite3';
import { getEnv } from '../config/env';
import path from 'path';

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (_db) return _db;

  const env = getEnv();
  const dbPath = path.resolve(env.SQLITE_DATABASE_PATH);

  _db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });

  return _db;
}

/** For use in tests only — resets the singleton so a new path can be injected. */
export function _resetDbForTest(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
