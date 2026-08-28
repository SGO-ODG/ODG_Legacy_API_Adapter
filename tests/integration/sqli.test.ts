/**
 * SQL injection resistance tests — no DB mocking.
 *
 * Uses better-sqlite3 in-memory databases seeded with the real schema to prove
 * that named-parameter binding treats every payload as a literal string, never
 * as executable SQL.
 */

import Database from 'better-sqlite3';
import { findByKey } from '../../src/db/companymaster';
import { findSubscription } from '../../src/db/companywebservice';
import { DbRunner } from '../../src/db/queryRunner';
import request from 'supertest';
import { createApp } from '../../src/app';
import * as companymaster from '../../src/db/companymaster';
import * as companywebservice from '../../src/db/companywebservice';

// ─── In-memory test DB ────────────────────────────────────────────────────────

function buildTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE companymaster (
      companyCode        TEXT NOT NULL,
      companyName        TEXT NOT NULL,
      webserviceKey      TEXT NOT NULL,
      disabled           TEXT NOT NULL DEFAULT 'N',
      odgapiClientId     TEXT NOT NULL DEFAULT '',
      odgapiClientSecret TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE companywebservice (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      companyCode           TEXT    NOT NULL,
      webserviceCode        TEXT    NOT NULL,
      subscriptionStartDate TEXT    NOT NULL,
      subscriptionEndDate   TEXT    NOT NULL,
      outputMode            TEXT    NOT NULL DEFAULT 'F'
    );

    INSERT INTO companymaster VALUES
      ('ACME', 'Acme Corp', 'valid-key', 'N', 'cid', 'sec');

    INSERT INTO companywebservice
      (companyCode, webserviceCode, subscriptionStartDate, subscriptionEndDate, outputMode)
    VALUES
      ('ACME', 'NDCADVISOR', '2020-01-01', '2099-12-31', 'F');
  `);
  return db;
}

/** DbRunner backed by a specific better-sqlite3 instance (not the singleton). */
class TestRunner implements DbRunner {
  constructor(private readonly db: Database.Database) {}

  queryOne<T>(sql: string, params: Record<string, unknown>): T | undefined {
    return this.db.prepare<Record<string, unknown>, T>(sql).get(params);
  }
}

// ─── Classic SQLi payloads ────────────────────────────────────────────────────

const KEY_PAYLOADS = [
  "1' OR '1'='1",
  "'; DROP TABLE companymaster; --",
  "' UNION SELECT * FROM companymaster --",
  "valid-key' --",
  "' OR 1=1 --",
  "' OR 'x'='x",
  "1; SELECT * FROM companymaster WHERE '1'='1",
];

const COMPANY_CODE_PAYLOADS: [string, string][] = [
  ["1' OR '1'='1",                            'NDCADVISOR'],
  ["'; DROP TABLE companywebservice; --",      'NDCADVISOR'],
  ["' UNION SELECT * FROM companywebservice --", 'NDCADVISOR'],
  ["' OR 1=1 --",                              'NDCADVISOR'],
];

const WEBSERVICE_CODE_PAYLOADS: [string, string][] = [
  ['ACME', "1' OR '1'='1"],
  ['ACME', "'; DROP TABLE companywebservice; --"],
  ['ACME', "' UNION SELECT * FROM companywebservice --"],
  ['ACME', "' OR 1=1 --"],
];

// ─── findByKey — direct function tests ───────────────────────────────────────

describe('findByKey() — SQL injection resistance', () => {
  let runner: TestRunner;

  beforeAll(() => {
    runner = new TestRunner(buildTestDb());
  });

  it.each(KEY_PAYLOADS)(
    'returns undefined (no auth bypass) for payload: %s',
    (payload) => {
      const result = findByKey(payload, runner);
      expect(result).toBeUndefined();
    },
  );

  it('returns the correct row for a legitimate key', () => {
    const result = findByKey('valid-key', runner);
    expect(result).toBeDefined();
    expect(result!.companyCode).toBe('ACME');
    expect(result!.disabled).toBe('N');
  });

  it('companymaster table survives a DROP TABLE attempt in the key param', () => {
    // If the payload executed as SQL the table would be dropped and the next
    // query would throw. Instead it must succeed.
    findByKey("'; DROP TABLE companymaster; --", runner);
    const result = findByKey('valid-key', runner);
    expect(result).toBeDefined();
    expect(result!.companyCode).toBe('ACME');
  });
});

// ─── findSubscription — direct function tests ─────────────────────────────────

describe('findSubscription() — SQL injection resistance', () => {
  let runner: TestRunner;

  beforeAll(() => {
    runner = new TestRunner(buildTestDb());
  });

  it.each(COMPANY_CODE_PAYLOADS)(
    'returns undefined for injected companyCode: %s / %s',
    (companyCode, webserviceCode) => {
      const result = findSubscription(companyCode, webserviceCode, runner);
      expect(result).toBeUndefined();
    },
  );

  it.each(WEBSERVICE_CODE_PAYLOADS)(
    'returns undefined for injected webserviceCode: %s / %s',
    (companyCode, webserviceCode) => {
      const result = findSubscription(companyCode, webserviceCode, runner);
      expect(result).toBeUndefined();
    },
  );

  it('returns the correct row for legitimate params', () => {
    const result = findSubscription('ACME', 'NDCADVISOR', runner);
    expect(result).toBeDefined();
    expect(result!.companyCode).toBe('ACME');
    expect(result!.webserviceCode).toBe('NDCADVISOR');
  });

  it('companywebservice table survives a DROP TABLE attempt in webserviceCode param', () => {
    findSubscription('ACME', "'; DROP TABLE companywebservice; --", runner);
    const result = findSubscription('ACME', 'NDCADVISOR', runner);
    expect(result).toBeDefined();
  });
});

// ─── HTTP layer — X-ODG-KEY injection via supertest ──────────────────────────

describe('HTTP X-ODG-KEY header — SQL injection must return 403, never bypass auth', () => {
  const app = createApp();
  let testRunner: TestRunner;
  let spyFindByKey: jest.SpyInstance;
  let spyFindSubscription: jest.SpyInstance;

  beforeAll(() => {
    const db = buildTestDb();
    testRunner = new TestRunner(db);

    // Capture originals BEFORE installing the spy — in CommonJS the named
    // import and module.exports.findByKey are the same binding, so calling
    // `findByKey` inside the mock would recurse into the spy itself.
    const origFindByKey = companymaster.findByKey;
    const origFindSubscription = companywebservice.findSubscription;

    spyFindByKey = jest
      .spyOn(companymaster, 'findByKey')
      .mockImplementation((key: string) => origFindByKey(key, testRunner));

    spyFindSubscription = jest
      .spyOn(companywebservice, 'findSubscription')
      .mockImplementation((cc: string, ws: string) =>
        origFindSubscription(cc, ws, testRunner),
      );
  });

  afterAll(() => {
    spyFindByKey.mockRestore();
    spyFindSubscription.mockRestore();
  });

  it.each(KEY_PAYLOADS)(
    'returns 403 (not an auth bypass) when X-ODG-KEY contains: %s',
    async (payload) => {
      const res = await request(app)
        .get('/restws/ndcadvisor?ndc=12345-6789')
        .set('X-ODG-KEY', payload);
      expect(res.status).toBe(403);
      expect(res.text).toContain('<error>Invalid web service key.</error>');
    },
  );

  it('does NOT return 403 for a valid key (spy is wired correctly)', async () => {
    // Auth passes; the upstream ODG call will fail (not mocked here) producing
    // a non-403 status — anything other than 403 confirms auth was not blocked.
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=12345-6789')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).not.toBe(403);
  });
});
