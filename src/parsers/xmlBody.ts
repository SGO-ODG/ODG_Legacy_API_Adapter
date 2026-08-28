import { XMLParser } from 'fast-xml-parser';
import { LegacyError, ERRORS } from '../errors/legacyErrors';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  // Keep all tag values as strings so leading zeros (e.g. "01.24") are preserved.
  parseTagValue: false,
  // Do NOT force isArray on container elements — that wraps them in an extra
  // array and breaks path traversal. xmlStrArray handles both string and array.
});

/**
 * Parses a raw XML POST body string into a plain JS object.
 * Throws a LegacyError with INVALID_XML payload if parsing fails.
 *
 * @param raw  The raw request body (Buffer or string).
 */
export function parseXmlBody(raw: Buffer | string): Record<string, unknown> {
  const text: string = Buffer.isBuffer(raw) ? raw.toString('utf-8') : (typeof raw === 'string' ? raw : '');

  if (!text || text.trim().length === 0) {
    throw new LegacyError(ERRORS.INVALID_FORMAT());
  }

  try {
    const result = parser.parse(text) as Record<string, unknown>;
    return result;
  } catch {
    throw new LegacyError(ERRORS.INVALID_XML());
  }
}

/**
 * Returns the root element key of a parsed XML object.
 * Allows transformers to accept any root element name (e.g. <request>,
 * <cbcalc>, <reservecalc>, <onesearch>) without hardcoding it.
 */
export function xmlRootKey(parsed: Record<string, unknown>): string {
  return Object.keys(parsed)[0] ?? '';
}

/**
 * Safely reads a nested string value from a parsed XML object.
 * Returns undefined when the path does not exist.
 */
export function xmlStr(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = obj;
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  if (cur == null) return undefined;
  return String(cur);
}

/**
 * Safely reads a nested array of strings from a parsed XML object.
 * Returns [] when the path does not exist.
 */
export function xmlStrArray(
  obj: Record<string, unknown>,
  ...keys: string[]
): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = obj;
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object') return [];
    cur = cur[key];
  }
  if (!Array.isArray(cur)) {
    if (cur != null) return [String(cur)];
    return [];
  }
  return cur.map(String).filter((s: string) => s.trim().length > 0);
}
