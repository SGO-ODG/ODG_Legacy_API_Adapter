import request from 'supertest';
import { createApp } from '../../src/app';
import * as companymaster from '../../src/db/companymaster';
import * as companywebservice from '../../src/db/companywebservice';
import * as serviceRegistry from '../../src/config/serviceRegistry';
import * as odgClient from '../../src/upstream/odgClient';

jest.mock('../../src/db/companymaster');
jest.mock('../../src/db/companywebservice');
jest.mock('../../src/config/serviceRegistry');
jest.mock('../../src/upstream/odgClient');
jest.mock('../../src/auth/tokenCache', () => ({
  getToken: jest.fn().mockResolvedValue('mock-token'),
  invalidateToken: jest.fn(),
  _clearCacheForTest: jest.fn(),
}));

const mockFindByKey = companymaster.findByKey as jest.MockedFunction<typeof companymaster.findByKey>;
const mockFindSub = companywebservice.findSubscription as jest.MockedFunction<typeof companywebservice.findSubscription>;
const mockLookup = serviceRegistry.lookupServiceCode as jest.MockedFunction<typeof serviceRegistry.lookupServiceCode>;
const mockOdgGet = odgClient.odgGet as jest.MockedFunction<typeof odgClient.odgGet>;

const VALID_COMPANY: companymaster.CompanyRow = {
  companyCode: 'ACME', companyName: 'Acme', webserviceKey: 'valid-key', disabled: 'N',
};
const VALID_SUB: companywebservice.SubscriptionRow = {
  id: 1, companyCode: 'ACME', webserviceCode: 'BPGUIDE',
  subscriptionStartDate: '2020-01-01', subscriptionEndDate: '2099-12-31', outputMode: 'F',
};

const SAMPLE_GUIDELINE = {
  code: 'M54.5',
  description: 'Low back pain',
  bestPracticeGuidelines: [
    { pathway: 'Conservative', minDays: 1, maxDays: 7, jobClass: 'Light' },
  ],
  activityModifiers: [
    { jobType: 'Sedentary', jobModification: 'No lifting' },
  ],
  physicalTherapyVisits: [
    { pathway: 'PT Path', visits: 6, weeks: 4 },
  ],
  chiropractorVisits: [
    { pathway: 'Chiro Path', visits: 4, weeks: 3 },
  ],
};

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockReturnValue('BPGUIDE');
  mockFindByKey.mockResolvedValue(VALID_COMPANY);
  mockFindSub.mockResolvedValue(VALID_SUB);
});

describe('BP Guide auth errors', () => {
  it('returns 403 when no key', async () => {
    const res = await request(app).get('/restws/bpguide?icd=M54.5');
    expect(res.status).toBe(403);
  });

  it('returns 403 NOT_SUBSCRIBED', async () => {
    mockFindSub.mockResolvedValue(undefined);
    const res = await request(app)
      .get('/restws/bpguide?icd=M54.5')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(403);
  });
});

describe('BP Guide request validation', () => {
  it('returns 400 when neither icd nor bp+noi supplied', async () => {
    const res = await request(app)
      .get('/restws/bpguide')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(400);
    expect(res.text).toContain('<error>Invalid web service request format.</error>');
  });

  it('returns 405 for POST', async () => {
    const res = await request(app)
      .post('/restws/bpguide')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(405);
  });
});

describe('BP Guide successful responses', () => {
  it('returns 200 XML with legacy field names for ICD input', async () => {
    mockOdgGet.mockResolvedValue([SAMPLE_GUIDELINE]);
    const res = await request(app)
      .get('/restws/bpguide?icd=M54.5')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/xml/);
    expect(res.text).toContain('<icdcode>M54.5</icdcode>');
    expect(res.text).toContain('<name>Low back pain</name>');
    expect(res.text).toContain('<primaryRTWpath>Conservative</primaryRTWpath>');
    expect(res.text).toContain('<days1>1</days1>');
    expect(res.text).toContain('<days>7</days>');
    expect(res.text).not.toContain('<rescount>');
  });

  it('returns legacy activitymod, pt, chiro fields', async () => {
    mockOdgGet.mockResolvedValue([SAMPLE_GUIDELINE]);
    const res = await request(app)
      .get('/restws/bpguide?icd=M54.5')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.text).toContain('<jobtype>Sedentary</jobtype>');
    expect(res.text).toContain('<jobmodification>No lifting</jobmodification>');
    expect(res.text).toContain('<primarypath>PT Path</primarypath>');
  });

  it('returns 200 JSON for /format/json', async () => {
    mockOdgGet.mockResolvedValue([SAMPLE_GUIDELINE]);
    const res = await request(app)
      .get('/restws/bpguide/format/json?icd=M54.5')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/json/);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].icdcode).toBe('M54.5');
  });

  it('echoes clientid and rescount in XML when clientid provided', async () => {
    mockOdgGet.mockResolvedValue([SAMPLE_GUIDELINE]);
    const res = await request(app)
      .get('/restws/bpguide?icd=M54.5&clientid=c1')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.text).toContain('<clientid>c1</clientid>');
    expect(res.text).toContain('<rescount>1</rescount>');
  });

  it('echoes clientid and rescount in JSON when clientid provided (query param)', async () => {
    mockOdgGet.mockResolvedValue([SAMPLE_GUIDELINE]);
    const res = await request(app)
      .get('/restws/bpguide/format/json?icd=M54.5&clientid=c1')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/json/);
    expect(res.body.clientid).toBe('c1');
    expect(res.body.rescount).toBe(1);
    expect(res.body['0'].icdcode).toBe('M54.5');
  });

  it('detects JSON format when /format/json appears mid-path (CI style)', async () => {
    mockOdgGet.mockResolvedValue([{ ...SAMPLE_GUIDELINE, code: 'S33.5' }]);
    const res = await request(app)
      .get('/restws/bpguide/icd/S33.5/format/json/clientid/odg_integration')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/json/);
    expect(res.body.clientid).toBe('odg_integration');
    expect(res.body.rescount).toBe(1);
    expect(res.body['0'].icdcode).toBe('S33.5');
  });

  it('accepts multiple ICDs (tilde-separated) and returns array', async () => {
    const g2 = { ...SAMPLE_GUIDELINE, code: 'M54.50', description: 'LBP variant' };
    mockOdgGet.mockResolvedValue([SAMPLE_GUIDELINE, g2]);
    const res = await request(app)
      .get('/restws/bpguide?icd=M54.5~M54.50')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.status).toBe(200);
  });

  it('returns 200 with empty sections when record has no guide data', async () => {
    mockOdgGet.mockResolvedValue([{ code: 'M54.5', description: 'LBP' }]);
    const res = await request(app)
      .get('/restws/bpguide?icd=M54.5')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<icdcode>M54.5</icdcode>');
    expect(res.text).toContain('<bp/>');
  });

  it('returns 404 when upstream returns empty array', async () => {
    mockOdgGet.mockResolvedValue([]);
    const res = await request(app)
      .get('/restws/bpguide?icd=M54.5')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(404);
  });

  it('maps upstream error to legacy error', async () => {
    mockOdgGet.mockRejectedValue(new odgClient.UpstreamError(503, 'down'));
    const res = await request(app)
      .get('/restws/bpguide?icd=M54.5')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('down');
  });
});
