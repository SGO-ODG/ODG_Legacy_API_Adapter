import { Router, Request, Response, NextFunction } from 'express';
import { legacyAuthMiddleware } from '../middleware/legacyAuth';
import { formatSelectorMiddleware, getLegacyFormat } from '../middleware/formatSelector';
import { sendLegacyResponse, sendLegacyError } from '../serializers/legacyResponse';
import { LegacyError, ERRORS } from '../errors/legacyErrors';
import {
  parseUraParams,
  handleUrAdvisor,
  buildUraModel,
} from '../transformers/urAdvisor';
import {
  parseBpGuideParams,
  handleBpGuide,
  buildBpGuideModel,
} from '../transformers/bpGuide';
import { parseCiPathSegments } from '../parsers/queryParams';
import {
  parseOneSearchBody,
  handleOneSearch,
  buildOneSearchXmlModel,
  buildOneSearchJsonBody,
} from '../transformers/oneSearch';
import { UpstreamError } from '../upstream/odgClient';
import { isDebugEnabled } from '../config/env';
import { usageLoggerMiddleware } from '../middleware/usageLogger';

const router = Router();

// Apply format selector to all restws routes
router.use(formatSelectorMiddleware);

// ─── UR Advisor ───────────────────────────────────────────────────────────────

router.get(
  '/uradvisor*',
  legacyAuthMiddleware('uradvisor'),
  usageLoggerMiddleware(),
  async (req: Request, res: Response, next: NextFunction) => {
    let ctx: ReturnType<typeof parseUraParams> | undefined;
    try {
      const format = req.path.includes('/format/json') ? 'json' : getLegacyFormat(res);
      // Parse CodeIgniter-style path segments (e.g. /icd/S33.5/clientid/ABC)
      const suffix = req.path.slice('/uradvisor'.length);
      const pathParams = parseCiPathSegments(suffix);
      const merged: Record<string, string | string[] | undefined> = {
        ...pathParams,
        ...(req.query as Record<string, string | string[] | undefined>),
      };
      ctx = parseUraParams(merged, req.legacy!.subscription);
      const result = await handleUrAdvisor(ctx);

      if (format === 'json') {
        const jsonRecords = result.records.map((rec) =>
          rec.cptInfo
            ? { cpt: rec.cptInfo, icd: rec.icdStats ?? [] }
            : rec.proc
              ? { icd: rec.icd, proc: rec.proc }
              : { icd: rec.icd, cpt: rec.cpt ?? [] },
        );
        if (result.clientid) {
          const obj: Record<string, unknown> = {};
          jsonRecords.forEach((rec, i) => { obj[String(i)] = rec; });
          obj.rescount = result.records.length;
          obj.clientid = result.clientid;
          res.status(200).json(obj);
        } else {
          res.status(200).json(jsonRecords);
        }
        return;
      }

      const model = buildUraModel(result);
      sendLegacyResponse(res, model, format);
    } catch (err) {
      if (err instanceof LegacyError) {
        sendLegacyError(res, err.payload);
        return;
      }
      if (err instanceof UpstreamError) {
        const isFnol = !!(ctx?.bp || ctx?.noi);
        if (isFnol && err.statusCode === 400) {
          sendLegacyError(res, ERRORS.INVALID_CODES());
          return;
        }
        sendLegacyError(res, ERRORS.NO_RESULTS('ICD/Treatment code'));
        return;
      }
      next(err);
    }
  },
);

router.post('/uradvisor*', (_req, res) =>
  sendLegacyError(res, ERRORS.UNKNOWN_METHOD()),
);

// ─── Best Practice Guide ──────────────────────────────────────────────────────

router.get(
  '/bpguide*',
  legacyAuthMiddleware('bpguide'),
  usageLoggerMiddleware(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // CI-style paths allow /format/json anywhere in the segment list, not just at
      // the end, so re-derive format from the raw path rather than relying on the
      // suffix-only formatSelectorMiddleware check.
      const format = req.path.includes('/format/json') ? 'json' : getLegacyFormat(res);
      // Parse CodeIgniter-style path segments (e.g. /icd/S33.5~M54.0/clientid/ABC)
      const suffix = req.path.slice('/bpguide'.length);
      const pathParams = parseCiPathSegments(suffix);
      // Query params take precedence over path params if both are present
      const merged: Record<string, string | string[] | undefined> = {
        ...pathParams,
        ...(req.query as Record<string, string | string[] | undefined>),
      };
      const ctx = parseBpGuideParams(merged);
      const result = await handleBpGuide(ctx);
      if (format === 'json') {
        if (result.clientid) {
          // PHP mixes numeric-indexed records with string keys rescount+clientid,
          // which JSON-encodes as an object with string numeric keys ("0","1",...).
          const obj: Record<string, unknown> = {};
          result.records.forEach((rec, i) => { obj[String(i)] = rec; });
          obj.rescount = result.records.length;
          obj.clientid = result.clientid;
          res.status(200).json(obj);
        } else {
          res.status(200).json(result.records);
        }
        return;
      }
      const model = buildBpGuideModel(result);
      sendLegacyResponse(res, model, format);
    } catch (err) {
      if (err instanceof LegacyError) {
        sendLegacyError(res, err.payload);
        return;
      }
      if (err instanceof UpstreamError) {
        sendLegacyError(res, ERRORS.NO_RESULTS('ICD code'));
        return;
      }
      next(err);
    }
  },
);

router.post('/bpguide*', (_req, res) =>
  sendLegacyError(res, ERRORS.UNKNOWN_METHOD()),
);

// ─── One Search ───────────────────────────────────────────────────────────────

router.post(
  ['/onesearch', '/onesearch/format/json'],
  legacyAuthMiddleware('onesearch'),
  usageLoggerMiddleware(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const format = getLegacyFormat(res);
      const raw: Buffer | string = req.body ?? '';
      if (isDebugEnabled()) {
        const bodyStr = Buffer.isBuffer(raw) ? raw.toString('utf-8') : typeof raw === 'string' ? raw : String(raw);
        console.log(`[LEGACY REQ PAYLOAD] content-type=${req.headers['content-type'] ?? 'none'}\n${bodyStr}`);
      }
      const ctx = parseOneSearchBody(raw);
      if (isDebugEnabled()) {
        console.log(`[LEGACY PARSED] text="${ctx.text}" types=${JSON.stringify(ctx.types)}`);
      }
      const result = await handleOneSearch(ctx);
      if (format === 'json') {
        res.status(200).json(buildOneSearchJsonBody(result));
      } else {
        sendLegacyResponse(res, buildOneSearchXmlModel(result), 'xml');
      }
    } catch (err) {
      if (err instanceof LegacyError) {
        if (isDebugEnabled()) {
          console.log(`[LEGACY ERR] onesearch: ${JSON.stringify(err.payload)}`);
        }
        sendLegacyError(res, err.payload);
        return;
      }
      if (err instanceof UpstreamError) {
        sendLegacyError(res, ERRORS.NO_RESULTS('search criteria'));
        return;
      }
      next(err);
    }
  },
);

router.get('/onesearch', (_req, res) =>
  sendLegacyError(res, ERRORS.UNKNOWN_METHOD()),
);

export default router;
