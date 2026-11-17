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
        sendLegacyError(res, err.payload);
        return;
      }
      if (err instanceof UpstreamError) {
        sendLegacyError(res, ERRORS.MISSING_DIAGNOSIS());
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
        sendLegacyError(res, err.payload);
        return;
      }
      if (err instanceof UpstreamError) {
        sendLegacyError(res, ERRORS.MISSING_DIAGNOSIS());
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
