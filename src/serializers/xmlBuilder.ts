import { XMLBuilder } from 'fast-xml-parser';

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  suppressEmptyNode: true,
  format: false,
});

/**
 * Keys that must be emitted with their exact casing in XML output.
 * Without this, deepLowercaseKeys would produce e.g. "primaryrtwpath" which
 * does not match the legacy PHP contract field "primaryRTWpath".
 */
const PRESERVE_CASE_KEYS = new Set(['primaryRTWpath']);

/**
 * Recursively lowercases all object keys. Array items and primitives pass
 * through unchanged. Applied to both XML and JSON legacy output so that
 * upstream camelCase field names never leak into the legacy contract.
 * Keys listed in PRESERVE_CASE_KEYS are emitted verbatim.
 */
export function deepLowercaseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepLowercaseKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[PRESERVE_CASE_KEYS.has(k) ? k : k.toLowerCase()] = deepLowercaseKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * Serializes a legacy response model into XML.
 * The root element is always `<root>`.
 *
 * Rules:
 * - Array values → repeated sibling elements with the same tag name.
 * - null values → self-closing tags (e.g. `<days1/>`).
 * - undefined values → omitted (conditional fields).
 * - Nested objects → nested XML elements.
 * - `rescount` and `clientid` are expected to already be present in the model
 *   at the correct positions; callers control insertion order by object key order.
 */
export function buildLegacyXml(model: Record<string, unknown>): string {
  const doc = { root: stripUndefined(deepLowercaseKeys(model) as Record<string, unknown>) };
  const xml: string = builder.build(doc);
  return `<?xml version="1.0" encoding="utf-8"?>${xml}`;
}

/**
 * Recursively removes undefined values and converts null → '' so that
 * fast-xml-parser emits self-closing tags for null fields (e.g. `<days1/>`).
 */
function stripUndefined(obj: unknown): unknown {
  if (obj === undefined) return undefined;
  if (obj === null) return '';
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefined(v);
      }
    }
    return out;
  }
  return obj;
}
