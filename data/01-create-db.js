/**
 * 01-create-db.js
 * Creates the SQLite database file and both required tables.
 * Safe to re-run — uses CREATE TABLE IF NOT EXISTS.
 *
 * Usage: node data/01-create-db.js
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, 'legacy-subscriptions.sqlite');

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS companymaster (
    companyCode         VARCHAR(20)  PRIMARY KEY,
    companyName         VARCHAR(50),
    webserviceKey       VARCHAR(50)  UNIQUE NOT NULL,
    disabled            CHAR(1)      NOT NULL DEFAULT 'N',
    accountManagerEmail VARCHAR(80),
    salesManagerEmail   VARCHAR(80),
    odgapiClientId      VARCHAR(50),
    odgapiClientSecret  VARCHAR(150)
  );

  CREATE TABLE IF NOT EXISTS companywebservice (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    companyCode           VARCHAR(20) NOT NULL,
    webserviceCode        VARCHAR(20) NOT NULL,
    subscriptionStartDate DATE,
    subscriptionEndDate   DATE,
    outputMode            VARCHAR(1)  NOT NULL DEFAULT 'S'
  );
`);

db.close();
console.log('Database created:', DB_PATH);
