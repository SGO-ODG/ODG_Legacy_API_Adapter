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
  companyCode: 'ACME', companyName: 'Acme', webserviceKey: 'valid-key',
};
const FULL_SUB: companywebservice.SubscriptionRow = {
  id: 1, companyCode: 'ACME', webserviceCode: 'URADVISOR',
  subscriptionStartDate: '2020-01-01', subscriptionEndDate: '2099-12-31', outputMode: 'F',
};
const STREAMLINED_SUB = { ...FULL_SUB, outputMode: 'S' };

const SAMPLE_TAO_ITEM = {
  code: '99213', name: 'Office visit',
  incidenceRate: 1.2, procedureFrequency: 2.3,
  visit25: 1, visit50: 2, visit75: 3,
  visitMean: 2.1, costMean: 100.0,
  odgCAA: 1, paymentFlag: 'Green', costPerVisit: 50.0,
  procedureType: 'Medical', averageLostDays: 3.0,
  medianLostDays: 2.0, percentNeverReturn: 0.1,
  percentZeroDays: 0.2, taoIndex: 1.0,
};

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockReturnValue('URADVISOR');
  mockFindByKey.mockResolvedValue(VALID_COMPANY);
  mockFindSub.mockResolvedValue(FULL_SUB);
});

describe('UR Advisor auth errors', () => {
  it('returns 403 when no key', async () => {
    const res = await request(app).get('/restws/uradvisor?icd=M54.5&cpt=99213');
    expect(res.status).toBe(403);
  });

  it('returns 403 NOT_SUBSCRIBED', async () => {
    mockFindSub.mockResolvedValue(undefined);
    const res = await request(app)
      .get('/restws/uradvisor?icd=M54.5&cpt=99213')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(403);
    expect(res.text).toContain('<error>You are not subscribed for requested web service.</error>');
  });
});

describe('UR Advisor request validation', () => {
  it('returns 400 INVALID_FORMAT when neither icd nor FNOL supplied', async () => {
    const res = await request(app)
      .get('/restws/uradvisor')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(400);
    expect(res.text).toContain('<error>Invalid web service request format.</error>');
  });

  it('returns 400 INVALID_FORMAT for icd=9 without cpt', async () => {
    const res = await request(app)
      .get('/restws/uradvisor?icd=9')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(400);
  });

  it('returns 405 for POST method', async () => {
    const res = await request(app)
      .post('/restws/uradvisor')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(405);
  });
});

describe('UR Advisor successful responses', () => {
  it('returns 200 XML for ICD+CPT request', async () => {
    mockOdgGet.mockResolvedValue({ items: [SAMPLE_TAO_ITEM] });
    const res = await request(app)
      .get('/restws/uradvisor?icd=M54.5&cpt=99213')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/xml/);
    // Legacy lowercase field names
    expect(res.text).toContain('<incidencerate>1.2</incidencerate>');
    expect(res.text).toContain('<paymentflag>Green</paymentflag>');
    expect(res.text).toContain('<odgcaa>1</odgcaa>');
  });

  it('includes full output fields when subscription outputMode=F', async () => {
    mockOdgGet.mockResolvedValue({ items: [SAMPLE_TAO_ITEM] });
    const res = await request(app)
      .get('/restws/uradvisor?icd=M54.5&cpt=99213')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<avglostdays>');
    expect(res.text).toContain('<taoindex>');
    expect(res.text).toContain('<proctype>');
  });

  it('excludes full output fields when subscription outputMode=S', async () => {
    mockFindSub.mockResolvedValue(STREAMLINED_SUB);
    mockOdgGet.mockResolvedValue({ items: [SAMPLE_TAO_ITEM] });
    const res = await request(app)
      .get('/restws/uradvisor?icd=M54.5&cpt=99213')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<avglostdays>');
    expect(res.text).not.toContain('<taoindex>');
  });

  it('returns 200 JSON for /format/json', async () => {
    mockOdgGet.mockResolvedValue({ items: [SAMPLE_TAO_ITEM] });
    const res = await request(app)
      .get('/restws/uradvisor/format/json?icd=M54.5&cpt=99213')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/json/);
  });

  it('echoes clientid', async () => {
    mockOdgGet.mockResolvedValue({ items: [SAMPLE_TAO_ITEM] });
    const res = await request(app)
      .get('/restws/uradvisor?icd=M54.5&cpt=99213&clientid=claim-1')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.text).toContain('<clientid>claim-1</clientid>');
  });

  it('returns 404 when no results', async () => {
    mockOdgGet.mockResolvedValue({ items: [] });
    const res = await request(app)
      .get('/restws/uradvisor?icd=M54.5&cpt=99213')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/No record found/);
  });

  it('maps upstream error to legacy error', async () => {
    mockOdgGet.mockRejectedValue(new odgClient.UpstreamError(503, 'down'));
    const res = await request(app)
      .get('/restws/uradvisor?icd=M54.5&cpt=99213')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('down');
  });
});
