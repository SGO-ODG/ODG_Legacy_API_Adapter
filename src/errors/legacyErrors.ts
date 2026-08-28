/** Formats a Date as MM/DD/YYYY for legacy error messages. */
function fmtDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

export interface LegacyErrorPayload {
  status: number;
  body: { error: string };
}

export class LegacyError extends Error {
  constructor(public readonly payload: LegacyErrorPayload) {
    super(payload.body.error);
    this.name = 'LegacyError';
  }
}

// Auth / subscription errors (shared across all routes)
export const ERRORS = {
  INVALID_KEY: (): LegacyErrorPayload => ({
    status: 403,
    body: { error: 'Invalid web service key.' },
  }),
  ACCOUNT_DISABLED: (): LegacyErrorPayload => ({
    status: 403,
    body: { error: 'Your account is disabled.' },
  }),
  SERVICE_NOT_EXIST: (): LegacyErrorPayload => ({
    status: 403,
    body: { error: 'Invalid, requested web service does not exist.' },
  }),
  NOT_SUBSCRIBED: (): LegacyErrorPayload => ({
    status: 403,
    body: { error: 'You are not subscribed for requested web service.' },
  }),
  SUB_NOT_STARTED: (date: Date): LegacyErrorPayload => ({
    status: 403,
    body: { error: `Your subscription will start from ${fmtDate(date)}.` },
  }),
  SUB_EXPIRED: (date: Date): LegacyErrorPayload => ({
    status: 403,
    body: { error: `Your subscription is expired on ${fmtDate(date)}.` },
  }),
  UNKNOWN_METHOD: (): LegacyErrorPayload => ({
    status: 405,
    body: { error: 'Unknown method' },
  }),

  // Request / input errors
  INVALID_FORMAT: (): LegacyErrorPayload => ({
    status: 400,
    body: { error: 'Invalid web service request format.' },
  }),
  INVALID_XML: (): LegacyErrorPayload => ({
    status: 400,
    body: { error: 'Invalid XML, unable to load...' },
  }),
  INVALID_CODES: (): LegacyErrorPayload => ({
    status: 400,
    body: {
      error:
        'One or both of the codes you entered are invalid, please check the codes and try again.',
    },
  }),
  INVALID_FNOL: (): LegacyErrorPayload => ({
    status: 400,
    body: {
      error:
        'There is no valid ICD code that can be mapped to the provided BP-NOI codes combination. ' +
        'Please either update the codes or use an ICD code when one becomes available.',
    },
  }),

  // No-result errors (endpoint-specific messages are callers' responsibility)
  NO_RESULTS: (searchFor: string): LegacyErrorPayload => ({
    status: 404,
    body: { error: `No record found for given ${searchFor}.` },
  }),
  SEARCH_TEXT_TOO_SHORT: (): LegacyErrorPayload => ({
    status: 404,
    body: { error: 'Minimum 2 characters are required for search text.' },
  }),
  MISSING_XML_ELEMENTS: (): LegacyErrorPayload => ({
    status: 404,
    body: { error: 'One or more XML element values are required to process your request.' },
  }),
  MISSING_DIAGNOSIS: (): LegacyErrorPayload => ({
    status: 404,
    body: {
      error: 'One or more valid Diagnosis (ICD) or Procedure (CPT) code required to calculate.',
    },
  }),
};
