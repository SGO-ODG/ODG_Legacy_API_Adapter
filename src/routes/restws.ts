import { Router, Request, Response, NextFunction } from 'express';
import { legacyAuthMiddleware } from '../middleware/legacyAuth';
import { formatSelectorMiddleware, getLegacyFormat } from '../middleware/formatSelector';
import { sendLegacyResponse, sendLegacyError } from '../serializers/legacyResponse';
import { LegacyError, ERRORS } from '../errors/legacyErrors';
import {
  parseNdcAdvisorParams,
  handleNdcAdvisor,
  buildNdcAdvisorModel,
} from '../transformers/ndcAdvisor';
import {
  fetchAllNdcRecords,
  serializeNdcDownloadCsv,
} from '../transformers/ndcDownload';
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
import { appendLegacyMeta } from '../serializers/legacyResponse';
import { isDebugEnabled } from '../config/env';

const router = Router();

// Apply format selector to all restws routes
router.use(formatSelectorMiddleware);

// ─── NDC Advisor ──────────────────────────────────────────────────────────────

router.get(
  ['/ndcadvisor', '/ndcadvisor/format/json'],
  legacyAuthMiddleware('ndcadvisor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const format = getLegacyFormat(res);
      const ctx = parseNdcAdvisorParams(
        req.query as Record<string, string | string[] | undefined>,
      );
      const result = await handleNdcAdvisor(req.legacy!.company, ctx);
      const model = buildNdcAdvisorModel(result);
      sendLegacyResponse(res, model, format);
    } catch (err) {
      if (err instanceof LegacyError) {
        sendLegacyError(res, err.payload);
        return;
      }
      if (err instanceof UpstreamError) {
        // Never expose upstream details to the caller
        sendLegacyError(res, ERRORS.NO_RESULTS('NDC codes'));
        return;
      }
      next(err);
    }
  },
);

// 405 for unsupported methods on known resources
router.post('/ndcadvisor', (_req, res) =>
  sendLegacyError(res, ERRORS.UNKNOWN_METHOD()),
);

// ─── NDC Download ─────────────────────────────────────────────────────────────

router.get(
  ['/ndcdownload', '/ndcdownload/format/json'],
  legacyAuthMiddleware('ndcdownload'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const format = getLegacyFormat(res);
      const clientid =
        typeof req.query.clientid === 'string' ? req.query.clientid : undefined;

      // CSV requested if path ends in /format/csv — reject per legacy contract
      // (ndcdownload CSV is supported only via the plain path, not /format/csv suffix)
      // CSV detection: Accept header not used; check explicit query or path suffix
      const wantCsv = req.path.endsWith('/format/csv');
      if (wantCsv) {
        sendLegacyError(res, ERRORS.INVALID_FORMAT());
        return;
      }

      const records = await fetchAllNdcRecords(req.legacy!.company);

      if (records.length === 0) {
        sendLegacyError(res, ERRORS.NO_RESULTS('NDC codes'));
        return;
      }

      // CSV output: only when requested explicitly via legacy csv path
      if (format === 'xml' && req.path.endsWith('/format/csv')) {
        const csv = serializeNdcDownloadCsv(records);
        res.type('text/csv').send(csv);
        return;
      }

      // Build model — array of records, no single-record unwrap for bulk download
      const model: Record<string, unknown> = { ndc: records };
      const withMeta = appendLegacyMeta(model, records.length, clientid);
      sendLegacyResponse(res, withMeta, format);
    } catch (err) {
      if (err instanceof LegacyError) {
        sendLegacyError(res, err.payload);
        return;
      }
      if (err instanceof UpstreamError) {
        sendLegacyError(res, ERRORS.NO_RESULTS('NDC codes'));
        return;
      }
      next(err);
    }
  },
);

router.post('/ndcdownload', (_req, res) =>
  sendLegacyError(res, ERRORS.UNKNOWN_METHOD()),
);

// ─── UR Advisor ───────────────────────────────────────────────────────────────

router.get(
  '/uradvisor*',
  legacyAuthMiddleware('uradvisor'),
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
      const result = await handleUrAdvisor(req.legacy!.company, ctx);

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
      const result = await handleBpGuide(req.legacy!.company, ctx);
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
      const result = await handleOneSearch(req.legacy!.company, ctx);
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
