import { Request, Response, NextFunction } from 'express';
import { legacyAuthMiddleware } from '../../../src/middleware/legacyAuth';
import * as companymaster from '../../../src/db/companymaster';
import * as companywebservice from '../../../src/db/companywebservice';
import * as serviceRegistry from '../../../src/config/serviceRegistry';

jest.mock('../../../src/db/companymaster');
jest.mock('../../../src/db/companywebservice');
jest.mock('../../../src/config/serviceRegistry');

const mockFindByKey = companymaster.findByKey as jest.MockedFunction<typeof companymaster.findByKey>;
const mockFindSub = companywebservice.findSubscription as jest.MockedFunction<typeof companywebservice.findSubscription>;
const mockLookup = serviceRegistry.lookupServiceCode as jest.MockedFunction<typeof serviceRegistry.lookupServiceCode>;

function makeReqRes(key?: string) {
  const req = { headers: key ? { 'x-odg-key': key } : {} } as unknown as Request;
  const send = jest.fn();
  const type = jest.fn().mockReturnValue({ send });
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json, type, send });
  const res = { status, locals: { legacyFormat: 'xml' } } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next, json, status, send };
}

/** Extracts the error message from an XML error body like `<root><error>MSG</error></root>`. */
function parseXmlError(xml: string): string {
  const m = xml.match(/<error>([\s\S]*?)<\/error>/);
  return m ? m[1] : '';
}

const ACTIVE_COMPANY: companymaster.CompanyRow = {
  companyCode: 'ACME',
  companyName: 'Acme Corp',
  webserviceKey: 'valid-key',
  disabled: 'N',
  odgapiClientId: 'client-id',
  odgapiClientSecret: 'secret',
};

const ACTIVE_SUB: companywebservice.SubscriptionRow = {
  id: 1,
  companyCode: 'ACME',
  webserviceCode: 'NDCADVISOR',
  subscriptionStartDate: '2020-01-01',
  subscriptionEndDate: '2099-12-31',
  outputMode: 'F',
};

describe('legacyAuthMiddleware', () => {
  const mw = legacyAuthMiddleware('ndcadvisor');

  beforeEach(() => {
    jest.clearAllMocks();
    mockLookup.mockReturnValue('NDCADVISOR');
  });

  it('returns 403 INVALID_KEY when header is missing', () => {
    const { req, res, next, status, send } = makeReqRes();
    mw(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(parseXmlError(send.mock.calls[0][0])).toBe('Invalid web service key.');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 INVALID_KEY when key not found in DB', () => {
    mockFindByKey.mockReturnValue(undefined);
    const { req, res, next, status, send } = makeReqRes('bad-key');
    mw(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(parseXmlError(send.mock.calls[0][0])).toBe('Invalid web service key.');
  });

  it('returns 403 ACCOUNT_DISABLED when company is disabled', () => {
    mockFindByKey.mockReturnValue({ ...ACTIVE_COMPANY, disabled: 'Y' });
    const { req, res, next, status, send } = makeReqRes('valid-key');
    mw(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(parseXmlError(send.mock.calls[0][0])).toBe('Your account is disabled.');
  });

  it('returns 403 SERVICE_NOT_EXIST when service not in registry', () => {
    mockFindByKey.mockReturnValue(ACTIVE_COMPANY);
    mockLookup.mockReturnValue(undefined);
    const { req, res, next, status, send } = makeReqRes('valid-key');
    mw(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(parseXmlError(send.mock.calls[0][0])).toBe('Invalid, requested web service does not exist.');
  });

  it('returns 403 NOT_SUBSCRIBED when subscription missing', () => {
    mockFindByKey.mockReturnValue(ACTIVE_COMPANY);
    mockFindSub.mockReturnValue(undefined);
    const { req, res, next, status, send } = makeReqRes('valid-key');
    mw(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(parseXmlError(send.mock.calls[0][0])).toBe('You are not subscribed for requested web service.');
  });

  it('returns 403 SUB_NOT_STARTED when subscription in future', () => {
    mockFindByKey.mockReturnValue(ACTIVE_COMPANY);
    mockFindSub.mockReturnValue({ ...ACTIVE_SUB, subscriptionStartDate: '2099-01-01' });
    const { req, res, next, status, send } = makeReqRes('valid-key');
    mw(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(parseXmlError(send.mock.calls[0][0])).toMatch(/Your subscription will start from/);
  });

  it('returns 403 SUB_EXPIRED when subscription is past', () => {
    mockFindByKey.mockReturnValue(ACTIVE_COMPANY);
    mockFindSub.mockReturnValue({ ...ACTIVE_SUB, subscriptionEndDate: '2000-01-01' });
    const { req, res, next, status, send } = makeReqRes('valid-key');
    mw(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(parseXmlError(send.mock.calls[0][0])).toMatch(/Your subscription is expired on/);
  });

  it('calls next() and attaches context when valid', () => {
    mockFindByKey.mockReturnValue(ACTIVE_COMPANY);
    mockFindSub.mockReturnValue(ACTIVE_SUB);
    const { req, res, next } = makeReqRes('valid-key');
    mw(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.legacy?.company.companyCode).toBe('ACME');
    expect(req.legacy?.webserviceCode).toBe('NDCADVISOR');
  });
});
