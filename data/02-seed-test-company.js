/**
 * 02-seed-test-company.js
 * Inserts (or updates) a test company and its full service subscriptions.
 *
 * Edit the COMPANY block below before running.
 * The webserviceKey matches the key pre-filled in the api-tester HTML pages.
 *
 * Reads connection settings from .env (PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD, PG_SSL).
 *
 * Usage: node data/02-seed-test-company.js
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Client } = require('pg');

// ─── Edit these values ────────────────────────────────────────────────────────

const COMPANY = {
  companyCode:  'ODG',
  companyName:  'ODGByMCG',
  webserviceKey: 'e3cf1a3d593197bd7d2aa91afc1f9ffd5add2cd5',
  disabled:     'N',
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

const client = new Client({
  host:     process.env.PG_HOST,
  port:     Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE,
  user:     process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl:      process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

(async () => {
  await client.connect();
  console.log(`Connected to PostgreSQL: ${process.env.PG_HOST}/${process.env.PG_DATABASE}`);

  // Upsert company — insert or update on conflict
  await client.query(
    `INSERT INTO companymaster (companyCode, companyName, webserviceKey, disabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (companyCode) DO UPDATE SET
       companyName   = EXCLUDED.companyName,
       webserviceKey = EXCLUDED.webserviceKey,
       disabled      = EXCLUDED.disabled`,
    [COMPANY.companyCode, COMPANY.companyName, COMPANY.webserviceKey, COMPANY.disabled],
  );
  console.log('Upserted company:', COMPANY.companyCode, '-', COMPANY.companyName);

  // Remove existing subscriptions for this company then re-insert
  await client.query('DELETE FROM companywebservice WHERE companyCode = $1', [COMPANY.companyCode]);

  for (const sub of SUBSCRIPTIONS) {
    await client.query(
      `INSERT INTO companywebservice
         (companyCode, webserviceCode, subscriptionStartDate, subscriptionEndDate, outputMode)
       VALUES ($1, $2, $3, $4, $5)`,
      [COMPANY.companyCode, sub.webserviceCode, SUBSCRIPTION_START, SUBSCRIPTION_END, sub.outputMode],
    );
    console.log('  Subscribed:', sub.webserviceCode, `(outputMode=${sub.outputMode})`);
  }

  await client.end();
  console.log('Done.');
})().catch((err) => {
  console.error('Error:', err.message);
  client.end();
  process.exit(1);
});
