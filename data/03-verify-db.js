/**
 * 03-verify-db.js
 * Prints all companies and their subscriptions from the database.
 * Read-only — safe to run at any time.
 *
 * Usage: node data/03-verify-db.js
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, 'legacy-subscriptions.sqlite');

const db = new Database(DB_PATH, { readonly: true });

const companies = db.prepare(`
  SELECT companyCode, companyName, disabled,
         SUBSTR(webserviceKey, 1, 8) || '...' AS keyPreview,
         odgapiClientId
  FROM   companymaster
  ORDER  BY companyCode
`).all();

if (companies.length === 0) {
  console.log('No companies found. Run 02-seed-test-company.js first.');
  db.close();
  process.exit(0);
}

for (const co of companies) {
  console.log(`\nCompany: ${co.companyCode} — ${co.companyName}`);
  console.log(`  disabled    : ${co.disabled}`);
  console.log(`  key (preview): ${co.keyPreview}`);
  console.log(`  clientId    : ${co.odgapiClientId}`);

  const subs = db.prepare(`
    SELECT webserviceCode, subscriptionStartDate, subscriptionEndDate, outputMode
    FROM   companywebservice
    WHERE  companyCode = ?
    ORDER  BY webserviceCode
  `).all(co.companyCode);

  if (subs.length === 0) {
    console.log('  subscriptions: (none)');
  } else {
    console.log('  subscriptions:');
    for (const s of subs) {
      console.log(`    ${s.webserviceCode.padEnd(14)} ${s.subscriptionStartDate} → ${s.subscriptionEndDate}  outputMode=${s.outputMode}`);
    }
  }
}

db.close();
