/**
 * 03-verify-db.js
 * Prints all companies and their subscriptions from the database.
 * Read-only — safe to run at any time.
 *
 * Reads connection settings from .env (PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD, PG_SSL).
 *
 * Usage: node data/03-verify-db.js
 */

'use strict';

require('dotenv').config();
const { Client } = require('pg');

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
  console.log(`Connected to PostgreSQL: ${process.env.PG_HOST}/${process.env.PG_DATABASE}\n`);

  const { rows: companies } = await client.query(`
    SELECT companyCode, companyName, disabled,
           SUBSTRING(webserviceKey, 1, 8) || '...' AS keyPreview
    FROM   companymaster
    ORDER  BY companyCode
  `);

  if (companies.length === 0) {
    console.log('No companies found. Run 02-seed-test-company.js first.');
    await client.end();
    return;
  }

  for (const co of companies) {
    console.log(`Company: ${co.companycode} — ${co.companyname}`);
    console.log(`  disabled     : ${co.disabled}`);
    console.log(`  key (preview): ${co.keypreview}`);

    const { rows: subs } = await client.query(
      `SELECT webserviceCode, subscriptionStartDate, subscriptionEndDate, outputMode
       FROM   companywebservice
       WHERE  companyCode = $1
       ORDER  BY webserviceCode`,
      [co.companycode],
    );

    if (subs.length === 0) {
      console.log('  subscriptions: (none)');
    } else {
      console.log('  subscriptions:');
      for (const s of subs) {
        const start = s.subscriptionstartdate instanceof Date
          ? s.subscriptionstartdate.toISOString().slice(0, 10)
          : s.subscriptionstartdate;
        const end = s.subscriptionenddate instanceof Date
          ? s.subscriptionenddate.toISOString().slice(0, 10)
          : s.subscriptionenddate;
        console.log(`    ${s.webservicecode.padEnd(14)} ${start} → ${end}  outputMode=${s.outputmode}`);
      }
    }
    console.log();
  }

  await client.end();
})().catch((err) => {
  console.error('Error:', err.message);
  client.end();
  process.exit(1);
});
