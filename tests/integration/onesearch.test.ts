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
  disabled: 'N', odgapiClientId: 'cid', odgapiClientSecret: 'sec',
};
const VALID_SUB: companywebservice.SubscriptionRow = {
  id: 1, companyCode: 'ACME', webserviceCode: 'ONESEARCH',
  subscriptionStartDate: '2020-01-01', subscriptionEndDate: '2099-12-31', outputMode: 'F',
};

const VALID_XML = `<request>
  <text>back pain</text>
  <database><icd9>Y</icd9><icd10>Y</icd10><cpt>Y</cpt><ndc>Y</ndc><proct>Y</proct></database>
  <clientid>claim-1</clientid>
</request>`;

const SAMPLE_SEARCH_RESPONSE = {
  resultSets: [
    { section: 'icd10search',   resultCount: 1, results: [{ code: 'M54.5', name: 'Low back pain' }] },
    { section: 'formularyndc',  resultCount: 1, results: [{ code: '12345-6789', name: 'Drug', brand: 'Brand' }] },
    { section: 'treatment',     resultCount: 1, results: [{ name: 'Topic', chapter: 'Ch1' }] },
  ],
};

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockReturnValue('ONESEARCH');
  mockFindByKey.mockReturnValue(VALID_COMPANY);
  mockFindSub.mockReturnValue(VALID_SUB);
});

describe('One Search auth errors', () => {
  it('returns 403 when no key', async () => {
    const res = await request(app)
      .post('/restws/onesearch')
      .type('application/xml')
      .send(VALID_XML);
    expect(res.status).toBe(403);
  });

  it('returns 405 for GET', async () => {
    const res = await request(app)
      .get('/restws/onesearch')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(405);
  });
});

describe('One Search request validation', () => {
  it('returns 400 INVALID_XML for bad XML', async () => {
    const res = await request(app)
      .post('/restws/onesearch')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send('<unclosed');
    expect(res.status).toBe(400);
    expect(res.text).toContain('<error>Invalid XML, unable to load...</error>');
  });

  it('returns 400 INVALID_FORMAT for empty body', async () => {
    const res = await request(app)
      .post('/restws/onesearch')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send('');
    expect(res.status).toBe(400);
  });

  it('returns 404 for missing text element', async () => {
    const res = await request(app)
      .post('/restws/onesearch')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send('<request><database><icd9>Y</icd9></database></request>');
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/XML element/);
  });

  it('returns 404 when text is too short (1 char)', async () => {
    const xml = '<request><text>a</text><database><icd9>Y</icd9></database></request>';
    const res = await request(app)
      .post('/restws/onesearch')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(xml);
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/Minimum 2 characters/);
  });

  it('returns 404 when no database flag is Y', async () => {
    const xml = '<request><text>back pain</text><database><icd9>N</icd9></database></request>';
    const res = await request(app)
      .post('/restws/onesearch')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(xml);
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/database element/);
  });

  it('returns 404 when database element missing entirely', async () => {
    const xml = '<request><text>back pain</text></request>';
    const res = await request(app)
      .post('/restws/onesearch')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(xml);
    expect(res.status).toBe(404);
  });
});

describe('One Search successful responses', () => {
  it('returns 200 XML with <item> wrappers and correct type names', async () => {
    mockOdgGet.mockResolvedValue(SAMPLE_SEARCH_RESPONSE);
    const res = await request(app)
      .post('/restws/onesearch')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(VALID_XML);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/xml/);
    // Results wrapped as <item> elements (legacy PHP numeric-array XML format)
    expect(res.text).toContain('<item>');
    expect(res.text).not.toContain('<onesearch>');
    // Legacy type names mapped correctly
    expect(res.text).toContain('<type>ICD10</type>');
    expect(res.text).toContain('<type>NDC</type>');
    expect(res.text).toContain('<type>PROCT</type>');
    // rescount and clientid present when clientid supplied
    expect(res.text).toContain('<rescount>3</rescount>');
    expect(res.text).toContain('<clientid>claim-1</clientid>');
  });

  it('XML has no rescount when clientid omitted', async () => {
    mockOdgGet.mockResolvedValue(SAMPLE_SEARCH_RESPONSE);
    const xmlNoClient = `<request>
      <text>back pain</text>
      <database><icd9>Y</icd9><icd10>Y</icd10><cpt>Y</cpt><ndc>Y</ndc><proct>Y</proct></database>
    </request>`;
    const res = await request(app)
      .post('/restws/onesearch')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(xmlNoClient);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<rescount>');
    expect(res.text).not.toContain('<clientid>');
  });

  it('returns 200 JSON array (no clientid) for /format/json', async () => {
    mockOdgGet.mockResolvedValue({
      resultSets: [{ section: 'icd10search', resultCount: 1, results: [{ code: 'M54.5', name: 'LBP' }] }],
    });
    const xmlNoClient = `<request>
      <text>back pain</text>
      <database><icd10>Y</icd10></database>
    </request>`;
    const res = await request(app)
      .post('/restws/onesearch/format/json')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(xmlNoClient);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/json/);
    // No clientid → plain array
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ type: 'ICD10', code: 'M54.5', name: 'LBP' });
  });

  it('returns 200 JSON object (with clientid) for /format/json', async () => {
    mockOdgGet.mockResolvedValue({
      resultSets: [{ section: 'icd10search', resultCount: 1, results: [{ code: 'M54.5', name: 'LBP' }] }],
    });
    const res = await request(app)
      .post('/restws/onesearch/format/json')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(VALID_XML);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/json/);
    // With clientid → object with numeric string keys + rescount + clientid
    expect(res.body['0']).toMatchObject({ type: 'ICD10', code: 'M54.5', name: 'LBP' });
    expect(res.body.rescount).toBe(1);
    expect(res.body.clientid).toBe('claim-1');
  });

  it('echoes clientid', async () => {
    mockOdgGet.mockResolvedValue({
      resultSets: [{ section: 'icd10search', resultCount: 1, results: [{ code: 'M54.5', name: 'LBP' }] }],
    });
    const res = await request(app)
      .post('/restws/onesearch')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(VALID_XML);
    expect(res.text).toContain('<clientid>claim-1</clientid>');
  });

  it('returns 404 when no results', async () => {
    mockOdgGet.mockResolvedValue({ resultSets: [] });
    const res = await request(app)
      .post('/restws/onesearch')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(VALID_XML);
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/No record found/);
  });

  it('maps upstream error to legacy error', async () => {
    mockOdgGet.mockRejectedValue(new odgClient.UpstreamError(500, 'fail'));
    const res = await request(app)
      .post('/restws/onesearch')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(VALID_XML);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('fail');
  });
});
