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
const VALID_SUB: companywebservice.SubscriptionRow = {
  id: 1, companyCode: 'ACME', webserviceCode: 'NDCADVISOR',
  subscriptionStartDate: '2020-01-01', subscriptionEndDate: '2099-12-31', outputMode: 'F',
};

const SAMPLE_NDC_INFO = {
  productNdc: '12345-6789',
  odgNdcCode: '12345-6789',
  strength: '10 mg',
  tradeName: 'TradeName',
  effectiveDate: '2026-01-15',
  proprietaryName: 'BrandName',
  nonProprietaryName: 'GenericName',
  pharmClasses: 'DrugClass',
  formularyInformation: [],
};

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockReturnValue('NDCADVISOR');
  mockFindByKey.mockResolvedValue(VALID_COMPANY);
  mockFindSub.mockResolvedValue(VALID_SUB);
});

// ─── Auth errors ─────────────────────────────────────────────────────────────

describe('NDC Advisor auth errors', () => {
  it('returns 403 INVALID_KEY when X-ODG-KEY is missing', async () => {
    const res = await request(app).get('/restws/ndcadvisor?ndc=12345-6789');
    expect(res.status).toBe(403);
    expect(res.text).toContain('<error>Invalid web service key.</error>');
  });

  it('returns 403 INVALID_KEY for unknown key', async () => {
    mockFindByKey.mockResolvedValue(undefined);
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=12345-6789')
      .set('X-ODG-KEY', 'bad-key');
    expect(res.status).toBe(403);
    expect(res.text).toContain('<error>Invalid web service key.</error>');
  });

  it('returns 403 ACCOUNT_DISABLED', async () => {
    mockFindByKey.mockResolvedValue({ ...VALID_COMPANY, disabled: 'Y' });
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=12345-6789')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(403);
    expect(res.text).toContain('<error>Your account is disabled.</error>');
  });

  it('returns 403 NOT_SUBSCRIBED', async () => {
    mockFindSub.mockResolvedValue(undefined);
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=12345-6789')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(403);
    expect(res.text).toContain('<error>You are not subscribed for requested web service.</error>');
  });

  it('returns 403 SUB_NOT_STARTED', async () => {
    mockFindSub.mockResolvedValue({ ...VALID_SUB, subscriptionStartDate: '2099-01-01' });
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=12345-6789')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/Your subscription will start from/);
  });

  it('returns 403 SUB_EXPIRED', async () => {
    mockFindSub.mockResolvedValue({ ...VALID_SUB, subscriptionEndDate: '2000-01-01' });
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=12345-6789')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/Your subscription is expired on/);
  });

  it('returns 405 for POST method', async () => {
    const res = await request(app)
      .post('/restws/ndcadvisor')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(405);
    expect(res.text).toContain('<error>Unknown method</error>');
  });
});

// ─── Request validation ───────────────────────────────────────────────────────

describe('NDC Advisor request validation', () => {
  it('returns 400 INVALID_FORMAT when ndc param is missing', async () => {
    const res = await request(app)
      .get('/restws/ndcadvisor')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(400);
    expect(res.text).toContain('<error>Invalid web service request format.</error>');
  });

  it('returns 400 INVALID_FORMAT for ndc=all', async () => {
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=all')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(400);
    expect(res.text).toContain('<error>Invalid web service request format.</error>');
  });
});

// ─── Successful responses ─────────────────────────────────────────────────────

describe('NDC Advisor successful responses', () => {
  it('returns 200 XML for single NDC match', async () => {
    mockOdgGet.mockResolvedValue({
      ndcInformation: [SAMPLE_NDC_INFO],
      totalRecords: 1,
    });
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=12345-6789')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/xml/);
    expect(res.text).toContain('<ndcCode>12345-6789</ndcCode>');
    expect(res.text).toContain('<brandName>BrandName</brandName>');
    expect(res.text).toContain('<rescount>1</rescount>');
  });

  it('returns 200 JSON when path ends with /format/json', async () => {
    mockOdgGet.mockResolvedValue({
      ndcInformation: [SAMPLE_NDC_INFO],
      totalRecords: 1,
    });
    const res = await request(app)
      .get('/restws/ndcadvisor/format/json?ndc=12345-6789')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/json/);
    expect(res.body.ndcCode).toBe('12345-6789');
    expect(res.body.rescount).toBe(1);
  });

  it('echoes clientid in response', async () => {
    mockOdgGet.mockResolvedValue({ ndcInformation: [SAMPLE_NDC_INFO], totalRecords: 1 });
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=12345-6789&clientid=claim-123')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<clientid>claim-123</clientid>');
  });

  it('returns array for multiple NDC matches', async () => {
    const ndc2 = { ...SAMPLE_NDC_INFO, odgNdcCode: '98765-4321', productNdc: '98765-4321' };
    mockOdgGet.mockResolvedValue({ ndcInformation: [SAMPLE_NDC_INFO, ndc2], totalRecords: 2 });
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=12345-6789~98765-4321')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<rescount>2</rescount>');
  });

  it('returns 200 XML for alphabetic keyword search', async () => {
    mockOdgGet.mockResolvedValue({ ndcInformation: [SAMPLE_NDC_INFO], totalRecords: 1 });
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=aspirin')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/xml/);
  });

  it('returns 200 XML for AU PBS single code', async () => {
    mockOdgGet.mockResolvedValue({
      pbsInformation: [{
        pbsCode: '1234A', brandName: 'PBSBrand', atcCode: 'A01',
        manufacCode: 'MFG', drugMpName: 'PBSDrug', amtMppPreferredTerm: 'Term',
      }],
      totalRecords: 1,
    });
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=1234A&country=AU')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<pbsCode>1234A</pbsCode>');
  });
});

// ─── No-result responses ──────────────────────────────────────────────────────

describe('NDC Advisor no-result responses', () => {
  it('returns 404 when no NDC records found', async () => {
    mockOdgGet.mockResolvedValue({ ndcInformation: [], totalRecords: 0 });
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=12345-6789')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/No record found/);
  });

  it('maps upstream error to legacy no-result error', async () => {
    mockOdgGet.mockRejectedValue(new odgClient.UpstreamError(500, 'Upstream down'));
    const res = await request(app)
      .get('/restws/ndcadvisor?ndc=12345-6789')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('Upstream');
  });
});
