/**
 * 01-create-db.js
 * Creates the two required tables in the PostgreSQL database.
 * Safe to re-run — uses CREATE TABLE IF NOT EXISTS.
 *
 * Reads connection settings from .env (PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD, PG_SSL).
 *
 * Usage: node data/01-create-db.js
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
  console.log(`Connected to PostgreSQL: ${process.env.PG_HOST}/${process.env.PG_DATABASE}`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS companymaster (
      companyCode         VARCHAR(20)  NOT NULL,
      companyName         VARCHAR(50)  NOT NULL,
      webserviceKey       VARCHAR(50)  NOT NULL,
      disabled            CHAR(1)      NOT NULL DEFAULT 'N',
      accountManagerEmail VARCHAR(80),
      salesManagerEmail   VARCHAR(80),
      CONSTRAINT pk_companymaster PRIMARY KEY (companyCode),
      CONSTRAINT uq_companymaster_key UNIQUE (webserviceKey)
    )
  `);
  console.log('Table ready: companymaster');

  await client.query(`
    CREATE TABLE IF NOT EXISTS companywebservice (
      id                    SERIAL       NOT NULL,
      companyCode           VARCHAR(20)  NOT NULL,
      webserviceCode        VARCHAR(20)  NOT NULL,
      subscriptionStartDate DATE         NOT NULL,
      subscriptionEndDate   DATE         NOT NULL,
      outputMode            VARCHAR(1)   NOT NULL DEFAULT 'S',
      CONSTRAINT pk_companywebservice PRIMARY KEY (id),
      CONSTRAINT fk_companywebservice_company
        FOREIGN KEY (companyCode) REFERENCES companymaster (companyCode)
    )
  `);
  console.log('Table ready: companywebservice');

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_companywebservice_lookup
      ON companywebservice (companyCode, webserviceCode)
  `);
  console.log('Index ready: idx_companywebservice_lookup');

  await client.end();
  console.log('Done.');
})().catch((err) => {
  console.error('Error:', err.message);
  client.end();
  process.exit(1);
});
