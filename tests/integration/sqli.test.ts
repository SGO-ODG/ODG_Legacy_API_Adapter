/**
 * SQL injection resistance tests.
 *
 * PostgreSQL parameterized queries ($1, $2, ...) pass user input as typed
 * values to the server — never as executable SQL text.  These tests verify
 * that:
 *   1. The SQL string never contains the caller-supplied input.
 *   2. The input is forwarded unchanged as a positional parameter value.
 *   3. Malicious payloads return undefined (no auth bypass) at both the
 *      function level and the HTTP layer.
 */

import { findByKey } from '../../src/db/companymaster';
import { findSubscription } from '../../src/db/companywebservice';
import { DbRunner } from '../../src/db/queryRunner';
import { CompanyRow } from '../../src/db/companymaster';
import { SubscriptionRow } from '../../src/db/companywebservice';
import request from 'supertest';
import { createApp } from '../../src/app';
import * as companymaster from '../../src/db/companymaster';
import * as companywebservice from '../../src/db/companywebservice';

// ─── Capturing test runner ────────────────────────────────────────────────────

/**
 * DbRunner that records what SQL and params were passed and returns a
 * configured result.  Never executes SQL — proves injection cannot occur
 * because user input only ever appears in the params array, never in the
 * SQL string.
 */
class CapturingRunner implements DbRunner {
  capturedSql = '';
  capturedParams: unknown[] = [];
  private result: object | undefined;

  constructor(result?: object) {
    this.result = result;
  }

  async queryOne<T extends object>(sql: string, params: unknown[]): Promise<T | undefined> {
    this.capturedSql = sql;
    this.capturedParams = [...params];
    return this.result as T | undefined;
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

const VALID_COMPANY: CompanyRow = {
  companyCode: 'ACME', companyName: 'Acme Corp', webserviceKey: 'valid-key', disabled: 'N',
};

const VALID_SUB: SubscriptionRow = {
  id: 1, companyCode: 'ACME', webserviceCode: 'NDCADVISOR',
  subscriptionStartDate: '2020-01-01', subscriptionEndDate: '2099-12-31', outputMode: 'F',
};

// ─── findByKey — param isolation tests ───────────────────────────────────────

describe('findByKey() — SQL injection resistance', () => {
  it.each(KEY_PAYLOADS)(
    'payload never appears in SQL string: %s',
    async (payload) => {
      const runner = new CapturingRunner(undefined);
      await findByKey(payload, runner);
      expect(runner.capturedSql).not.toContain(payload);
      expect(runner.capturedParams).toContain(payload);
    },
  );

  it('passes key as positional $1 parameter, not embedded in SQL', async () => {
    const runner = new CapturingRunner(VALID_COMPANY);
    await findByKey('valid-key', runner);
    expect(runner.capturedParams[0]).toBe('valid-key');
    expect(runner.capturedSql).toContain('$1');
    expect(runner.capturedSql).not.toContain('valid-key');
  });
});

// ─── findSubscription — param isolation tests ─────────────────────────────────

describe('findSubscription() — SQL injection resistance', () => {
  it.each(COMPANY_CODE_PAYLOADS)(
    'injected companyCode never appears in SQL: %s / %s',
    async (companyCode, webserviceCode) => {
      const runner = new CapturingRunner(undefined);
      await findSubscription(companyCode, webserviceCode, runner);
      expect(runner.capturedSql).not.toContain(companyCode);
      expect(runner.capturedParams).toContain(companyCode);
    },
  );

  it.each(WEBSERVICE_CODE_PAYLOADS)(
    'injected webserviceCode never appears in SQL: %s / %s',
    async (companyCode, webserviceCode) => {
      const runner = new CapturingRunner(undefined);
      await findSubscription(companyCode, webserviceCode, runner);
      expect(runner.capturedSql).not.toContain(webserviceCode);
      expect(runner.capturedParams).toContain(webserviceCode);
    },
  );

  it('passes params as positional $1/$2, not embedded in SQL', async () => {
    const runner = new CapturingRunner(VALID_SUB);
    await findSubscription('ACME', 'NDCADVISOR', runner);
    expect(runner.capturedParams[0]).toBe('ACME');
    expect(runner.capturedParams[1]).toBe('NDCADVISOR');
    expect(runner.capturedSql).toContain('$1');
    expect(runner.capturedSql).toContain('$2');
  });
});

// ─── HTTP layer — X-ODG-KEY injection via supertest ──────────────────────────

describe('HTTP X-ODG-KEY header — SQL injection must return 403, never bypass auth', () => {
  const app = createApp();

  beforeAll(() => {
    jest
      .spyOn(companymaster, 'findByKey')
      .mockImplementation(async (key: string) => {
        // Only 'valid-key' authenticates; every injection payload returns undefined.
        return key === 'valid-key' ? VALID_COMPANY : undefined;
      });

    jest
      .spyOn(companywebservice, 'findSubscription')
      .mockResolvedValue(VALID_SUB);
  });

  afterAll(() => {
    jest.restoreAllMocks();
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
