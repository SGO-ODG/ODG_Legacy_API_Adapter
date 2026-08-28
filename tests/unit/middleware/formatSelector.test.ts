import { Request, Response, NextFunction } from 'express';
import { formatSelectorMiddleware, getLegacyFormat } from '../../../src/middleware/formatSelector';

function makeReqRes(path: string) {
  const req = { path } as unknown as Request;
  const res = { locals: {} } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('formatSelectorMiddleware', () => {
  it('sets json for path ending with /format/json', () => {
    const { req, res, next } = makeReqRes('/restws/ndcadvisor/format/json');
    formatSelectorMiddleware(req, res, next);
    expect(getLegacyFormat(res)).toBe('json');
    expect(next).toHaveBeenCalled();
  });

  it('sets xml for plain path', () => {
    const { req, res, next } = makeReqRes('/restws/ndcadvisor');
    formatSelectorMiddleware(req, res, next);
    expect(getLegacyFormat(res)).toBe('xml');
  });

  it('does not match /format/jsonp as json', () => {
    const { req, res, next } = makeReqRes('/restws/ndcadvisor/format/jsonp');
    formatSelectorMiddleware(req, res, next);
    expect(getLegacyFormat(res)).toBe('xml');
  });
});
