/*******************************************************************
* Stored Procedure To Get Given Customer Legacy API Sample Data

/*
  Procedure: GetCustomerRequestData

  Description:
    Returns up to N unique request records for one customer.

  Parameters:
    p_companyCode
      Customer code matched against companymaster.companyCode.

    p_searchKeyword
      Keyword searched within odgws_debug.uri.

    p_numberOfRecords
      Maximum number of records to return.

    p_serverName
      Server name used in the generated companyCode.
      Example: ODGDEMO or ODGWEBSVCS.

    p_httpStatusCode
      Optional response-code filter.
      Pass NULL to include all response codes.

    p_numberOfDays
      Number of previous days to search.
      Pass NULL to use the default of 90 days.

    p_httpMethod
      GET:
        Returns unique od.uri values.

      POST:
        Returns unique od.params values.

  Notes:
    - od.time contains a Unix timestamp in seconds.
    - No ORDER BY is used to improve performance.
    - For POST requests, params is selected from the same record
      used for uniqueness.
    - The MySQL session time zone is used for date calculations.
*/

CREATE PROCEDURE GetCustomerRequestData (
    IN p_companyCode VARCHAR(255),
    IN p_searchKeyword VARCHAR(255),
    IN p_numberOfRecords INT,
    IN p_serverName VARCHAR(255),
    IN p_httpStatusCode INT,
    IN p_numberOfDays INT,
    IN p_httpMethod VARCHAR(10)
)
SQL SECURITY INVOKER
BEGIN
    DECLARE v_numberOfDays INT DEFAULT 90;
    DECLARE v_startEpoch BIGINT;
    DECLARE v_endEpoch BIGINT;
    DECLARE v_httpMethod VARCHAR(10);

    -- Use 90 days when p_numberOfDays is NULL
    SET v_numberOfDays = COALESCE(p_numberOfDays, 90);

    -- Normalize the HTTP method
    SET v_httpMethod = UPPER(p_httpMethod);

    -- Validate the HTTP method
    IF v_httpMethod NOT IN ('GET', 'POST') THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'p_httpMethod must be GET or POST';
    END IF;

    -- Calculate the beginning of the search period as Unix time
    SET v_startEpoch = UNIX_TIMESTAMP(
        DATE_SUB(CURDATE(), INTERVAL v_numberOfDays DAY)
    );

    -- Include records through the end of the current day
    SET v_endEpoch = UNIX_TIMESTAMP(
        DATE_ADD(CURDATE(), INTERVAL 1 DAY)
    );

    /*
      For GET:
        Uniqueness is based on od.uri.

      For POST:
        Uniqueness is based on od.params.

      ROW_NUMBER() keeps uri and params from the same database record.
    */
    WITH request_records AS (
        SELECT
            od.uri,
            od.params,

            ROW_NUMBER() OVER (
                PARTITION BY
                    CASE
                        WHEN v_httpMethod = 'GET' THEN od.uri
                        WHEN v_httpMethod = 'POST' THEN od.params
                    END
            ) AS unique_row_number

        FROM odgws_debug od

        INNER JOIN companymaster cm
            ON cm.webserviceKey = od.api_key

        WHERE cm.companyCode = p_companyCode

          -- Search for the keyword in the URI
          AND od.uri LIKE CONCAT('%', p_searchKeyword, '%')

          -- Apply the response-code filter only when provided
          AND (
              p_httpStatusCode IS NULL
              OR od.response_code = p_httpStatusCode
          )

          -- Filter using the Unix timestamp
          AND od.`time` >= v_startEpoch
          AND od.`time` < v_endEpoch

          -- POST records must contain params
          AND (
              v_httpMethod = 'GET'
              OR od.params IS NOT NULL
          )
    ),

    /*
      Keep one record for each unique URI or params value,
      then limit the number of returned records.
    */
    limited_records AS (
        SELECT
            uri,
            params
        FROM request_records
        WHERE unique_row_number = 1
        LIMIT p_numberOfRecords
    ),

    /*
      Generate sequential numbers for the test company code.
    */
    ranked_records AS (
        SELECT
            uri,
            params,
            ROW_NUMBER() OVER () AS sequential_number
        FROM limited_records
    )

    /*
      GET  returns the URI.

      POST returns the cleaned params value:
        - Removes the serialized prefix before the first <
        - Removes the serialized suffix after the last >
        - Removes whitespace between XML elements
        - Supports any XML root element name
    */
    SELECT
        CONCAT(
            p_companyCode,
            '-',
            p_serverName,
            '-TEST-',
            sequential_number
        ) AS companyCode,

        CASE
            WHEN v_httpMethod = 'GET' THEN uri

            WHEN v_httpMethod = 'POST' THEN
                REGEXP_REPLACE(
                    TRIM(
                        REGEXP_REPLACE(
                            REGEXP_REPLACE(
                                params,
                                '^[^<]*',
                                ''
                            ),
                            '[^>]*$',
                            ''
                        )
                    ),
                    '>[[:space:]]+<',
                    '><'
                )
        END AS requestData

    FROM ranked_records;
END

/**********************************************************************************/
-- GET BPGUIDE CUSTOMER RECORDS (Maximum 50 Records By Customer in Last 90 Days)
CALL GetCustomerRequestData('EmpireLife', 'bpguide', 50, 'ODGDEMO', NULL, NULL, 'GET');
node generate-customer-test-inputs.js --endpoint bpguide --server ODGDEMO
node generate-customer-test-inputs.js --endpoint bpguide --server ODGWEBSVCS

-- GET URADVISOR (TAO) CUSTOMER RECORDS (Maximum 50 Records By Customer in Last 90 Days)
CALL GetCustomerRequestData('CGU', 'uradvisor', 50, 'ODGDEMO', NULL, NULL, 'GET');
node generate-customer-test-inputs.js --endpoint uradvisor --server ODGDEMO
node generate-customer-test-inputs.js --endpoint uradvisor --server ODGWEBSVCS

-- GET ONESEARCH CUSTOMER RECORDS (Maximum 50 Records By Customer in Last 90 Days)
CALL GetCustomerRequestData('EmpireLife', 'onesearch', 50, 'ODGDEMO', NULL, NULL, 'POST');
node generate-customer-test-inputs.js --endpoint onesearch --server ODGDEMO
node generate-customer-test-inputs.js --endpoint onesearch --server ODGWEBSVCS

-- GET COMORBIDITY CALCULATOR CUSTOMER RECORDS (Maximum 50 Records By Customer in Last 90 Days)
CALL GetCustomerRequestData('Averitt', 'comorbidity', 50, 'ODGDEMO', NULL, NULL, 'POST');
node generate-customer-test-inputs.js --endpoint comorbidity --server ODGDEMO
node generate-customer-test-inputs.js --endpoint comorbidity --server ODGWEBSVCS

-- GET RESERVE CALCULATOR CUSTOMER RECORDS (Maximum 50 Records By Customer in Last 90 Days)
CALL GetCustomerRequestData('Averitt', 'reserve', 50, 'ODGDEMO', NULL, NULL, 'POST');
node generate-customer-test-inputs.js --endpoint reserve --server ODGDEMO
node generate-customer-test-inputs.js --endpoint reserve --server ODGWEBSVCS
/**********************************************************************************/