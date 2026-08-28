import { Response } from 'express';
import { buildLegacyXml, deepLowercaseKeys } from './xmlBuilder';
import { LegacyFormat, getLegacyFormat } from '../middleware/formatSelector';
import { LegacyErrorPayload } from '../errors/legacyErrors';

/**
 * Recursively converts null values to empty strings for JSON output.
 * Preserves non-null objects, arrays, and primitives unchanged.
 */
function nullToEmptyString(value: unknown): unknown {
  if (value === null) return '';
  if (Array.isArray(value)) return value.map(nullToEmptyString);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = nullToEmptyString(v);
    }
    return out;
  }
  return value;
}

/**
 * Sends a successful legacy response in the requested format.
 * XML is the default; JSON only when format === 'json'.
 */
export function sendLegacyResponse(
  res: Response,
  model: Record<string, unknown>,
  format: LegacyFormat,
  status = 200,
): void {
  if (format === 'json') {
    res.status(status).json(nullToEmptyString(deepLowercaseKeys(model)));
  } else {
    res
      .status(status)
      .type('application/xml')
      .send(buildLegacyXml(model));
  }
}

/**
 * Sends a legacy error response in the detected format.
 * XML format returns `<root><error>...</error></root>`;
 * JSON format returns `{ "error": "..." }`.
 */
export function sendLegacyError(
  res: Response,
  payload: LegacyErrorPayload,
): void {
  const format = getLegacyFormat(res);
  if (format === 'xml') {
    res
      .status(payload.status)
      .type('application/xml')
      .send(buildLegacyXml({ error: payload.body.error }));
  } else {
    res.status(payload.status).json(payload.body);
  }
}

/**
 * Appends `rescount` and optionally `clientid` to a model object.
 * Preserves insertion order so these appear last in XML output.
 */
export function appendLegacyMeta(
  model: Record<string, unknown>,
  rescount: number,
  clientid?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...model };
  if (clientid) out.clientid = clientid;
  out.rescount = rescount;
  return out;
}
