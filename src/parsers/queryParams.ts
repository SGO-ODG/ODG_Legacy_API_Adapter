/**
 * Sanitizes and normalizes a legacy ICD code.
 *
 * Step 1 — Sanitize: strips any character that is not alphanumeric or a decimal
 * point. This removes spaces, control characters, and any other noise that
 * legacy clients may accidentally include (e.g. "M54.5 " or "724.2\n").
 *
 * Step 2 — Normalize decimal: legacy clients may omit the decimal separator,
 * e.g. "73556" instead of "735.56", or "A4545" instead of "A45.45". The ODG
 * API requires the standard ICD format with a decimal inserted after the 3rd
 * character.
 *
 * Rules (applied after sanitization):
 *  - Already contains a decimal  → returned unchanged
 *  - Length ≤ 3 characters       → returned unchanged (root code, no subtype)
 *  - Otherwise                   → decimal inserted after position 3
 *
 * Step 3 — Strip trailing dot: codes like "F32." or "847." have a dangling
 * decimal with no subtype. These are stripped to their root form before
 * the decimal-insertion check so that "F32." becomes "F32" (unchanged,
 * length ≤ 3 rule) and "847." becomes "847" (unchanged).
 *
 * @example normalizeIcdCode('73556')    → '735.56'
 * @example normalizeIcdCode('A4545')    → 'A45.45'
 * @example normalizeIcdCode('735.56')   → '735.56'  (unchanged)
 * @example normalizeIcdCode('M54')      → 'M54'      (unchanged)
 * @example normalizeIcdCode('M54.5 ')   → 'M54.5'   (trailing space stripped)
 * @example normalizeIcdCode('724.2\n')  → '724.2'   (control char stripped)
 * @example normalizeIcdCode('F32.')     → 'F32'      (trailing dot stripped)
 * @example normalizeIcdCode('847.')     → '847'      (trailing dot stripped)
 */
export function normalizeIcdCode(code: string): string {
  const sanitized = code.replace(/[^A-Za-z0-9.]/g, '').replace(/\.$/, '');
  if (sanitized.includes('.') || sanitized.length <= 3) return sanitized;
  return `${sanitized.slice(0, 3)}.${sanitized.slice(3)}`;
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
