import { Request, Response, NextFunction } from 'express';

export type LegacyFormat = 'xml' | 'json';

const FORMAT_SUFFIX = '/format/json';

/**
 * Detects whether the incoming path ends exactly with `/format/json`
 * and sets `res.locals.legacyFormat` to `'json'` or `'xml'` (default).
 *
 * This must run before any route handler that reads `res.locals.legacyFormat`.
 */
export function formatSelectorMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.path.endsWith(FORMAT_SUFFIX)) {
    res.locals.legacyFormat = 'json' as LegacyFormat;
  } else {
    res.locals.legacyFormat = 'xml' as LegacyFormat;
  }
  next();
}

/** Helper for route handlers to read the detected format. */
export function getLegacyFormat(res: Response): LegacyFormat {
  return (res.locals.legacyFormat as LegacyFormat) ?? 'xml';
}
