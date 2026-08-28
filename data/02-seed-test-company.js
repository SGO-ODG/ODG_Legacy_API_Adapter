/**
 * 02-seed-test-company.js
 * Inserts (or replaces) a test company and its full service subscriptions.
 *
 * Edit the COMPANY block below before running.
 * The webserviceKey matches the key pre-filled in the api-tester HTML pages.
 *
 * Usage: node data/02-seed-test-company.js
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, 'legacy-subscriptions.sqlite');

// ─── Edit these values ────────────────────────────────────────────────────────

const COMPANY = {
  companyCode:        'ODG',
  companyName:        'ODGByMCG',
  webserviceKey:      'e3cf1a3d593197bd7d2aa91afc1f9ffd5add2cd5',
  disabled:           'N',
  odgapiClientId:     'odg_integration',
  odgapiClientSecret: 'F66F5117-7BA9-475A-B16B-F6BDB70A9D8D',
};

// All 7 supported legacy services; outputMode 'F' = full output
const SUBSCRIPTIONS = [
  { webserviceCode: 'NDCADVISOR',  outputMode: 'F' },
  { webserviceCode: 'NDCDOWNLOAD', outputMode: 'F' },
  { webserviceCode: 'URADVISOR',   outputMode: 'F' },
  { webserviceCode: 'BPGUIDE',     outputMode: 'F' },
  { webserviceCode: 'ONESEARCH',   outputMode: 'F' },
  { webserviceCode: 'COMORBIDITY', outputMode: 'F' },
  { webserviceCode: 'RESERVE',     outputMode: 'F' },
];

const SUBSCRIPTION_START = '2026-01-01';
const SUBSCRIPTION_END   = '2030-12-31';

// ─────────────────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);

db.prepare(`
  INSERT OR REPLACE INTO companymaster
    (companyCode, companyName, webserviceKey, disabled, odgapiClientId, odgapiClientSecret)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(
  COMPANY.companyCode,
  COMPANY.companyName,
  COMPANY.webserviceKey,
  COMPANY.disabled,
  COMPANY.odgapiClientId,
  COMPANY.odgapiClientSecret,
);
console.log('Upserted company:', COMPANY.companyCode, '-', COMPANY.companyName);

// Remove existing subscriptions for this company then re-insert
db.prepare('DELETE FROM companywebservice WHERE companyCode = ?').run(COMPANY.companyCode);

const insertSub = db.prepare(`
  INSERT INTO companywebservice
    (companyCode, webserviceCode, subscriptionStartDate, subscriptionEndDate, outputMode)
  VALUES (?, ?, ?, ?, ?)
`);

for (const sub of SUBSCRIPTIONS) {
  insertSub.run(COMPANY.companyCode, sub.webserviceCode, SUBSCRIPTION_START, SUBSCRIPTION_END, sub.outputMode);
  console.log('  Subscribed:', sub.webserviceCode, `(outputMode=${sub.outputMode})`);
}

db.close();
console.log('Done.');
