import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { findByKey, CompanyRow } from '../db/companymaster';
import { findSubscription, SubscriptionRow } from '../db/companywebservice';
import { lookupServiceCode } from '../config/serviceRegistry';
import { LegacyError, ERRORS } from '../errors/legacyErrors';
import { sendLegacyError } from '../serializers/legacyResponse';
import { isDebugEnabled } from '../config/env';

/** Validates the X-ODG-KEY header value: must be a non-empty string after trimming. */
const odgKeySchema = z.string().trim().min(1);

export interface LegacyContext {
  company: CompanyRow;
  subscription: SubscriptionRow;
  /** webserviceCode resolved from the URL, e.g. 'NDCADVISOR' */
  webserviceCode: string;
}

// Augment Express Request to carry legacy context
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      legacy?: LegacyContext;
    }
  }
}

/**
 * Parses today's date as a YYYY-MM-DD string for inclusive subscription
 * comparisons without time-zone issues.
 */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Builds a Date from a stored YYYY-MM-DD string (local midnight, no TZ shift).
 */
function parseStoredDate(d: string): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day);
}

/**
 * Express middleware that runs full legacy auth + subscription validation
 * before any route handler executes.
 *
 * @param serviceSegment  The URL segment that identifies the legacy service,
 *                        e.g. 'ndcadvisor'. Pass this from the route layer.
 */
export function legacyAuthMiddleware(serviceSegment: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      // 1. Read and validate X-ODG-KEY header
      const rawKey = req.headers['x-odg-key'];
      if (!rawKey || typeof rawKey !== 'string') {
        throw new LegacyError(ERRORS.INVALID_KEY());
      }
      const keyResult = odgKeySchema.safeParse(rawKey);
      if (!keyResult.success) {
        throw new LegacyError(ERRORS.INVALID_KEY());
      }

      // 2. Look up company (keyResult.data is already trimmed by the schema)
      const company = findByKey(keyResult.data);
      if (!company) {
        throw new LegacyError(ERRORS.INVALID_KEY());
      }

      // 3. Check disabled flag
      if (company.disabled === 'Y') {
        throw new LegacyError(ERRORS.ACCOUNT_DISABLED());
      }

      // 4. Resolve webserviceCode from registry
      const wsCode = lookupServiceCode(serviceSegment);
      if (!wsCode) {
        throw new LegacyError(ERRORS.SERVICE_NOT_EXIST());
      }

      // 5. Look up subscription
      const subscription = findSubscription(company.companyCode, wsCode);
      if (!subscription) {
        throw new LegacyError(ERRORS.NOT_SUBSCRIBED());
      }

      // 6. Validate inclusive subscription dates
      const today = todayStr();

      if (today < subscription.subscriptionStartDate) {
        const startDate = parseStoredDate(subscription.subscriptionStartDate);
        throw new LegacyError(ERRORS.SUB_NOT_STARTED(startDate));
      }

      if (today > subscription.subscriptionEndDate) {
        const endDate = parseStoredDate(subscription.subscriptionEndDate);
        throw new LegacyError(ERRORS.SUB_EXPIRED(endDate));
      }

      // 7. Attach context for downstream handlers
      req.legacy = { company, subscription, webserviceCode: wsCode };
      if (isDebugEnabled()) {
        console.log(`[LEGACY AUTH OK] company=${company.companyCode} service=${wsCode}`);
      }
      next();
    } catch (err) {
      if (err instanceof LegacyError) {
        sendLegacyError(res, err.payload);
        return;
      }
      next(err);
    }
  };
}
