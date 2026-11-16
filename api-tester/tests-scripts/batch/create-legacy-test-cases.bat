@echo off
REM GET ODGDEMO - CUSTOMER RECORDS (Maximum 50 Records By Customer in Last 90 Days)
:: node ../generate-customer-test-inputs.js --endpoint bpguide --server ODGDEMO
:: node ../generate-customer-test-inputs.js --endpoint uradvisor --server ODGDEMO
:: node ../generate-customer-test-inputs.js --endpoint onesearch --server ODGDEMO
:: node ../generate-customer-test-inputs.js --endpoint comorbidity --server ODGDEMO
:: node ../generate-customer-test-inputs.js --endpoint reserve --server ODGDEMO

REM GET ODGWEBSVCS - CUSTOMER RECORDS (Maximum 50 Records By Customer in Last 90 Days)
:: node ../generate-customer-test-inputs.js --endpoint bpguide --server ODGWEBSVCS
:: node ../generate-customer-test-inputs.js --endpoint uradvisor --server ODGWEBSVCS
::node ../generate-customer-test-inputs.js --endpoint onesearch --server ODGWEBSVCS
:;node ../generate-customer-test-inputs.js --endpoint comorbidity --server ODGWEBSVCS
:;node ../generate-customer-test-inputs.js --endpoint reserve --server ODGWEBSVCS