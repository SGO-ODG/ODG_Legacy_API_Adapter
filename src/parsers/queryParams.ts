/**
 * Normalizes a legacy ICD code that may be submitted without a decimal point.
 *
 * Legacy clients may omit the decimal separator, e.g. "73556" instead of
 * "735.56", or "A4545" instead of "A45.45".  The ODG API requires the standard
 * ICD format with a decimal inserted after the 3rd character.
 *
 * Rules:
 *  - Already contains a decimal  → returned unchanged
 *  - Length ≤ 3 characters       → returned unchanged (root code, no subtype)
 *  - Otherwise                   → decimal inserted after position 3
 *
 * @example normalizeIcdCode('73556')  → '735.56'
 * @example normalizeIcdCode('A4545')  → 'A45.45'
 * @example normalizeIcdCode('735.56') → '735.56'  (unchanged)
 * @example normalizeIcdCode('M54')    → 'M54'      (unchanged)
 */
export function normalizeIcdCode(code: string): string {
  const trimmed = code.trim();
  if (trimmed.includes('.') || trimmed.length <= 3) return trimmed;
  return `${trimmed.slice(0, 3)}.${trimmed.slice(3)}`;
}

/**
 * Splits a tilde-separated legacy parameter value into an array of trimmed,
 * non-empty strings.
 *
 * @example tildeList('12345-6789~98765-4321') → ['12345-6789', '98765-4321']
 */
export function tildeList(val: string | undefined): string[] {
  if (!val) return [];
  return val
    .split('~')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Normalizes a US NDC code to `NNNNN-NNNN` format.
 * Strips non-numeric characters, left-pads to 9 digits, then inserts a dash
 * after the 5th digit.
 *
 * Returns an empty string if the result would not be 9 digits.
 */
export function normalizeNdc(code: string): string {
  const digits = code.replace(/\D/g, '');
  const padded = digits.padStart(9, '0');
  if (padded.length !== 9) return '';
  return `${padded.slice(0, 5)}-${padded.slice(5)}`;
}

/**
 * Formats a procsummary NDC code to `NNNNN-NNNN` format, matching legacy PHP logic.
 * Step 1: strip all non-digit characters.
 * Step 2: if the result is exactly 9 or 11 digits, format as NNNNN-NNNN (first 9 digits).
 * Step 3: otherwise return the stripped digits string as-is.
 */
export function formatNdcProcCode(code: string): string {
  const digits = code.replace(/\D/g, '');
  if (digits.length === 9 || digits.length === 11) {
    return `${digits.slice(0, 5)}-${digits.slice(5, 9)}`;
  }
  return digits;
}

/**
 * Returns true if a string consists entirely of digits (after trimming).
 */
export function isNumeric(val: string): boolean {
  return /^\d+$/.test(val.trim());
}

/**
 * Left-pads an FNOL body-part or nature-of-injury code to 2 digits.
 *
 * @example padFnol('5') → '05'
 */
export function padFnol(code: string): string {
  return String(code).padStart(2, '0');
}

/**
 * Formats a Date object as `MM/DD/YYYY` (legacy date format).
 */
export function formatLegacyDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Parses an ISO 8601 date string (e.g. `2026-01-15T00:00:00Z` or `2026-01-15`)
 * and returns it formatted as `MM/DD/YYYY`.
 *
 * Extracts the date portion directly from the string to avoid UTC→local
 * timezone conversions shifting the day.  Returns the original string on
 * parse failure.
 */
export function isoToLegacyDate(iso: string): string {
  if (!iso) return iso;
  // Match YYYY-MM-DD at the start of the string
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return iso;
  const [, yyyy, mm, dd] = match;
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Parses a CodeIgniter REST-style path suffix into a key-value params map.
 * Segments after the endpoint name are paired as key/value tokens.
 * The `format` key is skipped — it is a presentation concern handled separately.
 *
 * @example
 *   parseCiPathSegments('/icd/S33.5~M54.0/clientid/ABC')
 *   // → { icd: 'S33.5~M54.0', clientid: 'ABC' }
 */
export function parseCiPathSegments(suffix: string): Record<string, string> {
  const tokens = suffix.split('/').filter((s) => s.length > 0);
  const result: Record<string, string> = {};
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const key = tokens[i];
    const value = tokens[i + 1];
    if (key !== 'format') {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Formats a numeric value as a US currency string: `$1,234.56`.
 */
export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
