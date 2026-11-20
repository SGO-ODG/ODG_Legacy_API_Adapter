import { Router, Request, Response, NextFunction } from 'express';
import { legacyAuthMiddleware } from '../middleware/legacyAuth';
import { usageLoggerMiddleware } from '../middleware/usageLogger';
import { formatSelectorMiddleware, getLegacyFormat } from '../middleware/formatSelector';
import { sendLegacyResponse, sendLegacyError } from '../serializers/legacyResponse';
import { LegacyError, ERRORS } from '../errors/legacyErrors';
import { UpstreamError } from '../upstream/odgClient';
import {
  handleComorbidity,
  handleReserve,
  buildCalcModel,
} from '../transformers/calculator';

/** Returns true when the ODG API error body describes an invalid-format/XML error. */
function isInvalidFormatBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const values = Object.values(body as Record<string, unknown>);
  return values.some(
    (v) => typeof v === 'string' && v.includes('Invalid web service request format.'),
  );
}

const router = Router();

router.use(formatSelectorMiddleware);

// ─── Comorbidity Calculator ───────────────────────────────────────────────────

router.post(
  ['/comorbidity', '/comorbidity/format/json'],
  legacyAuthMiddleware('comorbidity'),
  usageLoggerMiddleware(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const format = getLegacyFormat(res);
      const raw: Buffer | string = req.body ?? '';
      const result = await handleComorbidity(raw, format);
      const model = buildCalcModel(result);
      sendLegacyResponse(res, model, format);
    } catch (err) {
      if (err instanceof LegacyError) {
        const payload = err.payload.body.error === 'Invalid web service request format.'
          ? ERRORS.INVALID_XML()
          : err.payload;
        sendLegacyError(res, payload);
        return;
      }
      if (err instanceof UpstreamError) {
        const payload =
          isInvalidFormatBody(err.upstreamBody)
            ? ERRORS.INVALID_XML()
            : ERRORS.MISSING_DIAGNOSIS();
        sendLegacyError(res, payload);
        return;
      }
      next(err);
    }
  },
);

router.get('/comorbidity', (_req, res) =>
  sendLegacyError(res, ERRORS.UNKNOWN_METHOD()),
);

// ─── Reserve Calculator ───────────────────────────────────────────────────────

router.post(
  ['/reserve', '/reserve/format/json'],
  legacyAuthMiddleware('reserve'),
  usageLoggerMiddleware(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const format = getLegacyFormat(res);
      const raw: Buffer | string = req.body ?? '';
      const result = await handleReserve(raw, format);
      const model = buildCalcModel(result);
      sendLegacyResponse(res, model, format);
    } catch (err) {
      if (err instanceof LegacyError) {
        const payload = err.payload.body.error === 'Invalid web service request format.'
          ? ERRORS.INVALID_XML()
          : err.payload;
        sendLegacyError(res, payload);
        return;
      }
      if (err instanceof UpstreamError) {
        const payload =
          isInvalidFormatBody(err.upstreamBody)
            ? ERRORS.INVALID_XML()
            : ERRORS.MISSING_DIAGNOSIS();
        sendLegacyError(res, payload);
        return;
      }
      next(err);
    }
  },
);

router.get('/reserve', (_req, res) =>
  sendLegacyError(res, ERRORS.UNKNOWN_METHOD()),
);

export default router;
