import { Request, Response, NextFunction } from 'express';
import { insertUsageLog } from '../db/webserviceusage';
import { isUsageLoggingEnabled, isDebugEnabled } from '../config/env';

/**
 * Express middleware that writes one row to webserviceusage after each
 * authenticated legacy request completes.
 *
 * Must be placed AFTER legacyAuthMiddleware so that req.legacy is populated.
 * Uses res.on('finish') to capture the final HTTP status code, then inserts
 * the record asynchronously (fire-and-forget — errors are logged to stderr).
 *
 * Only active when USAGE_LOGGING_ENABLED=Y in .env.
 */
export function usageLoggerMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isUsageLoggingEnabled()) {
      next();
      return;
    }

    // Capture wall-clock start time for server response time measurement.
    const requestStartMs = Date.now();

    // Snapshot request fields now — they may be mutated or unavailable later.
    const isPost = req.method === 'POST';
    const rawBody: string | null = (() => {
      if (!isPost) return null;
      if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
      if (typeof req.body === 'string') return req.body;
      return null;
    })();
    const queryParameters: string | null = isPost ? null : (req.originalUrl ?? null);
    const clientId: string | null =
      typeof req.query.clientid === 'string' ? req.query.clientid : null;
    const contentType: string | null = req.headers['content-type'] ?? null;
    const acceptHeader: string | null = req.headers['accept'] ?? null;
    const rawIp = req.ip ?? req.socket?.remoteAddress ?? '';
    const clientHost: string =
      rawIp === '::1' ? '127.0.0.1' : rawIp.replace(/^::ffff:/, '');

    res.on('finish', () => {
      const legacy = req.legacy;
      if (!legacy) {
        console.warn('[USAGE LOG] Skipping — req.legacy not set (auth did not complete)');
        return;
      }

      const resContentType = res.getHeader('content-type');
      const effectiveAccept =
        typeof resContentType === 'string' && resContentType.includes('json')
          ? 'application/json'
          : 'application/xml';

      const serverResponseTime = Date.now() - requestStartMs;

      const entry = {
        companyCode:        legacy.company.companyCode,
        webserviceCode:     legacy.webserviceCode,
        clientHost,
        requestBody:        rawBody,
        queryParameters,
        clientId,
        resultCode:         String(res.statusCode),
        contentType,
        acceptHeader:       effectiveAccept,
        serverResponseTime,
      };

      if (isDebugEnabled()) {
        console.log(`[USAGE LOG] Inserting: company=${entry.companyCode} service=${entry.webserviceCode} status=${entry.resultCode}`);
      }

      insertUsageLog(entry)
        .then(() => {
          if (isDebugEnabled()) console.log('[USAGE LOG] Insert OK');
        })
        .catch((err: Error) => {
          console.error('[USAGE LOG ERROR]', err.message);
        });
    });

    next();
  };
}
