'use strict';

/**
 * generate-customer-test-inputs.js
 *
 * Connects to a MySQL database, calls the stored procedure
 * GetCustomerRequestData once per company code, and appends the results into
 * the matching per-endpoint test input CSV file consumed by the compare scripts.
 *
 * Usage:
 *   node api-tester/tests-scripts/generate-customer-test-inputs.js --endpoint <name>
 *
 * Options:
 *   --endpoint <name>   Required. Target endpoint to generate.
 *                       Accepted values: comorbidity | reserve | onesearch | uradvisor | bpguide
 *   --server <name>     Required. Server name passed as p_serverName to the stored procedure.
 *
 * Configuration:
 *   Edit COMPANY_CODES and SP_* constants below, then ensure the MySQL
 *   connection variables are set in your local .env file.
 *
 * Required .env variables:
 *   MYSQL_HOST       MySQL server hostname or IP
 *   MYSQL_PORT       MySQL server port (default 3306)
 *   MYSQL_USER       MySQL username
 *   MYSQL_PASSWORD   MySQL password
 *   MYSQL_DATABASE   MySQL database name
 *
 * The stored procedure returns two columns:
 *   companyCode   — used directly as test_name in the CSV
 *   requestData   — XML body (POST endpoints) or URL path (GET endpoints)
 *
 * Output CSVs (written to api-tester/tests-scripts/input/):
 *   legacy-customer-comorbidity-calculator-tests.csv  columns: test_name,url_path,xml_body
 *   legacy-customer-reserve-calculator-tests.csv      columns: test_name,url_path,xml_body
 *   legacy-customer-onesearch-tests.csv               columns: test_name,url_path,xml_body
 *   legacy-customer-uradvisor-tests.csv               columns: test_name,url_path
 *   legacy-customer-bpguide-tests.csv                 columns: test_name,url_path
 *
 * Dependencies: mysql2, dotenv (both in root node_modules)
 */

const path = require('path');
const fs   = require('fs');

// Load .env from project root (api-tester/tests-scripts → api-tester → project root)
const projectRoot = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(projectRoot, '.env') });

const mysql = require(path.join(projectRoot, 'node_modules', 'mysql2', 'promise'));

// ---------------------------------------------------------------------------
// ── Edit this section before running ────────────────────────────────────────
// ---------------------------------------------------------------------------

// Fixed stored procedure parameters — the same values are used for every company.
const SP_NUM_RECORDS    = 50;    // p_numberOfRecords
const SP_HTTP_STATUS    = null;  // p_httpStatusCode
const SP_NUM_DAYS       = 90;    // p_numberOfDays

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const VALID_ENDPOINTS = ['comorbidity', 'reserve', 'onesearch', 'uradvisor', 'bpguide'];
const POST_ENDPOINTS  = new Set(['comorbidity', 'reserve', 'onesearch']);

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

const targetEndpoint = (() => {
  const val = getArg('--endpoint');
  if (!val) {
    console.error(`ERROR: --endpoint is required. Accepted values: ${VALID_ENDPOINTS.join(', ')}`);
    process.exit(1);
  }
  if (!VALID_ENDPOINTS.includes(val)) {
    console.error(`ERROR: Unknown --endpoint value "${val}". Accepted values: ${VALID_ENDPOINTS.join(', ')}`);
    process.exit(1);
  }
  return val;
})();

const targetServer = (() => {
  const val = getArg('--server');
  if (!val) {
    console.error('ERROR: --server is required. Provide the server name to pass as p_serverName.');
    process.exit(1);
  }
  return val;
})();

// ---------------------------------------------------------------------------
// Output file paths and CSV metadata
// ---------------------------------------------------------------------------

const INPUT_DIR = path.join(__dirname, 'input');

const OUTPUT_FILES = {
  comorbidity : path.join(INPUT_DIR, 'legacy-customer-comorbidity-calculator-tests.csv'),
  reserve     : path.join(INPUT_DIR, 'legacy-customer-reserve-calculator-tests.csv'),
  onesearch   : path.join(INPUT_DIR, 'legacy-customer-onesearch-tests.csv'),
  uradvisor   : path.join(INPUT_DIR, 'legacy-customer-uradvisor-tests.csv'),
  bpguide     : path.join(INPUT_DIR, 'legacy-customer-bpguide-tests.csv'),
};

const CSV_HEADERS = {
  comorbidity : 'test_name,url_path,xml_body',
  reserve     : 'test_name,url_path,xml_body',
  onesearch   : 'test_name,url_path,xml_body',
  uradvisor   : 'test_name,url_path',
  bpguide     : 'test_name,url_path',
};

const FIXED_URL_PATH = {
  comorbidity : '/calculator/comorbidity',
  reserve     : '/calculator/reserve',
  onesearch   : '/restws/onesearch',
};

// ---------------------------------------------------------------------------
// CSV helpers — RFC 4180 compliant, always-quoted fields
// ---------------------------------------------------------------------------

function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return '"' + s.replace(/"/g, '""') + '"';
}

function csvLine(...fields) {
  return fields.map(csvField).join(',');
}

// ---------------------------------------------------------------------------
// Build a single CSV data row string for the target endpoint
// ---------------------------------------------------------------------------

function buildCsvRow(testName, requestData) {
  const trimmed = requestData.trim();

  if (POST_ENDPOINTS.has(targetEndpoint)) {
    return csvLine(testName, FIXED_URL_PATH[targetEndpoint], trimmed);
  }
  // GET endpoints (uradvisor, bpguide): requestData is the URL path
  return csvLine(testName, trimmed);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Validate MySQL env vars
  const missingEnv = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE']
    .filter(k => !process.env[k]);
  if (missingEnv.length > 0) {
    console.error(`ERROR: Missing required .env variable(s): ${missingEnv.join(', ')}`);
    console.error('       Copy .env.example to .env and fill in the MySQL section.');
    process.exit(1);
  }

  const httpMethod = POST_ENDPOINTS.has(targetEndpoint) ? 'POST' : 'GET';
  console.log(`Endpoint: ${targetEndpoint}  Server: ${targetServer}  HTTP method: ${httpMethod}`);

  let pool;
  try {
    pool = await mysql.createPool({
      host    : process.env.MYSQL_HOST,
      port    : parseInt(process.env.MYSQL_PORT || '3306', 10),
      user    : process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
    });
  } catch (err) {
    console.error(`ERROR: Could not create MySQL connection pool: ${err.message}`);
    process.exit(1);
  }

  // Fetch the list of company codes to process
  let companyCodes;
  try {
    const [rows] = await pool.execute(`
      SELECT DISTINCT companyCode
      FROM ODGDEMO_ARCHIVE
      WHERE webserviceCode = ?
        AND transactionTimestamp >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? DAY)
        AND transactionTimestamp <= CURRENT_TIMESTAMP
      ORDER BY companyCode
    `, [targetEndpoint.toUpperCase(), SP_NUM_DAYS]);
    companyCodes = rows.map(r => r.companyCode || r.COMPANYCODE);
  } catch (err) {
    console.error(`ERROR: Failed to fetch company codes: ${err.message}`);
    await pool.end();
    process.exit(1);
  }

  if (companyCodes.length === 0) {
    console.warn('WARN: No company codes found — nothing to do.');
    await pool.end();
    process.exit(0);
  }

  console.log(`Found ${companyCodes.length} company code(s) to process.`);

  const dataRows = [];

  for (const companyCode of companyCodes) {
    console.log(`Processing: ${companyCode}`);

    let rows;
    try {
      // mysql2 CALL returns [ [resultSet1Rows, ...], fields ]
      const [results] = await pool.execute(
        'CALL GetCustomerRequestData(?, ?, ?, ?, ?, ?, ?)',
        [
          companyCode,
          targetEndpoint,
          SP_NUM_RECORDS,
          targetServer,
          SP_HTTP_STATUS,
          SP_NUM_DAYS,
          httpMethod,
        ]
      );
      // results[0] is the first result set (the data rows)
      rows = Array.isArray(results[0]) ? results[0] : results;
    } catch (err) {
      console.error(`  ERROR calling SP for ${companyCode}: ${err.message} — skipping.`);
      continue;
    }

    if (!rows || rows.length === 0) {
      console.log(`  No rows returned.`);
      continue;
    }

    for (const row of rows) {
      const requestData = row.requestData || row.REQUESTDATA || '';
      const testName    = row.companyCode  || row.COMPANYCODE || '';
      dataRows.push(buildCsvRow(testName, requestData));
    }

    console.log(`  ${rows.length} row(s) collected.`);
  }

  await pool.end();

  // Write (append) to the target CSV
  const filePath  = OUTPUT_FILES[targetEndpoint];
  const fileExists = fs.existsSync(filePath);
  if (fileExists) {
    fs.appendFileSync(filePath, dataRows.join('\n') + (dataRows.length > 0 ? '\n' : ''), 'utf8');
    console.log(`\n${path.basename(filePath)}: appended ${dataRows.length} row(s)`);
  } else {
    const content = [CSV_HEADERS[targetEndpoint], ...dataRows].join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`\n${path.basename(filePath)}: created with ${dataRows.length} row(s)`);
  }

  console.log('Done.');
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
