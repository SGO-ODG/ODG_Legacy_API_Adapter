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
const mockOdgPost = odgClient.odgPost as jest.MockedFunction<typeof odgClient.odgPost>;

const VALID_COMPANY: companymaster.CompanyRow = {
  companyCode: 'ACME', companyName: 'Acme', webserviceKey: 'valid-key', disabled: 'N',
};

function makeSub(ws: string): companywebservice.SubscriptionRow {
  return {
    id: 1, companyCode: 'ACME', webserviceCode: ws,
    subscriptionStartDate: '2020-01-01', subscriptionEndDate: '2099-12-31', outputMode: 'F',
  };
}

const VALID_CALC_XML = `<request>
  <clientid>claim-1</clientid>
  <country>US</country><state>CA</state>
  <age>42</age><jds>50</jds><fulloutput>Y</fulloutput>
  <icdcodes><code>M54.5</code></icdcodes>
  <procsummary><cpt><code>99213</code></cpt></procsummary>
</request>`;

const SAMPLE_CALC_RESPONSE = {
  clientId: 'claim-1',
  riskAssessment: { score: 3, magnitude: 'Moderate' },
  adjustedDuration: { bestPractice: 14 },
  projectedCosts: { bestPractice: 2000 },
  adjustedSummaryGuidelines: {},
  compRate: 800,
  icdCodes: { codes: ['M54.5'] },
  cfactors: {},
  alertdesc: {},
};

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();
  mockFindByKey.mockResolvedValue(VALID_COMPANY);
});

// ─── Comorbidity ──────────────────────────────────────────────────────────────

describe('Comorbidity calculator auth errors', () => {
  beforeEach(() => {
    mockLookup.mockReturnValue('COMORBIDITY');
    mockFindSub.mockResolvedValue(makeSub('COMORBIDITY'));
  });

  it('returns 403 when no key', async () => {
    const res = await request(app)
      .post('/calculator/comorbidity')
      .type('application/xml')
      .send(VALID_CALC_XML);
    expect(res.status).toBe(403);
  });

  it('returns 405 for GET', async () => {
    const res = await request(app)
      .get('/calculator/comorbidity')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(405);
  });
});

describe('Comorbidity calculator request validation', () => {
  beforeEach(() => {
    mockLookup.mockReturnValue('COMORBIDITY');
    mockFindSub.mockResolvedValue(makeSub('COMORBIDITY'));
  });

  it('returns 400 INVALID_XML for bad XML', async () => {
    const res = await request(app)
      .post('/calculator/comorbidity')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send('<unclosed');
    expect(res.status).toBe(400);
    expect(res.text).toContain('<error>Invalid XML, unable to load...</error>');
  });

  it('returns 404 when no diagnosis or procedure supplied', async () => {
    const xml = '<request><country>US</country></request>';
    const res = await request(app)
      .post('/calculator/comorbidity')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(xml);
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/Diagnosis.*ICD.*Procedure.*CPT/i);
  });
});

describe('Comorbidity calculator successful responses', () => {
  beforeEach(() => {
    mockLookup.mockReturnValue('COMORBIDITY');
    mockFindSub.mockResolvedValue(makeSub('COMORBIDITY'));
  });

  it('returns 200 XML with legacy field names', async () => {
    mockOdgPost.mockResolvedValue(SAMPLE_CALC_RESPONSE);
    const res = await request(app)
      .post('/calculator/comorbidity')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(VALID_CALC_XML);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/xml/);
    expect(res.text).toContain('<clientid>claim-1</clientid>');
    expect(res.text).toContain('<riskassessment>');
    expect(res.text).toContain('<adjustedduration>');
    expect(res.text).toContain('<comprate>$800.00</comprate>');
  });

  it('returns 200 JSON for /format/json', async () => {
    mockOdgPost.mockResolvedValue(SAMPLE_CALC_RESPONSE);
    const res = await request(app)
      .post('/calculator/comorbidity/format/json')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(VALID_CALC_XML);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/json/);
    expect(res.body.clientid).toBe('claim-1');
    expect(res.body.comprate).toBe('$800.00');
  });

  it('maps upstream error to legacy error without exposing details', async () => {
    mockOdgPost.mockRejectedValue(new odgClient.UpstreamError(500, 'internal'));
    const res = await request(app)
      .post('/calculator/comorbidity')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(VALID_CALC_XML);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('internal');
  });
});

// ─── Reserve ──────────────────────────────────────────────────────────────────

describe('Reserve calculator successful responses', () => {
  beforeEach(() => {
    mockLookup.mockReturnValue('RESERVE');
    mockFindSub.mockResolvedValue(makeSub('RESERVE'));
  });

  it('returns 200 XML with projectedcosts', async () => {
    mockOdgPost.mockResolvedValue({ ...SAMPLE_CALC_RESPONSE, notes: ['Note 1'] });
    const res = await request(app)
      .post('/calculator/reserve')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(VALID_CALC_XML);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<projectedcosts>');
  });

  it('returns 404 for missing diagnosis', async () => {
    const xml = '<request><state>CA</state></request>';
    const res = await request(app)
      .post('/calculator/reserve')
      .set('X-ODG-KEY', 'valid-key')
      .type('application/xml')
      .send(xml);
    expect(res.status).toBe(404);
  });

  it('returns 405 for GET', async () => {
    const res = await request(app)
      .get('/calculator/reserve')
      .set('X-ODG-KEY', 'valid-key');
    expect(res.status).toBe(405);
  });
});

// ─── parseCalcXml unit tests ──────────────────────────────────────────────────

describe('parseCalcXml', () => {
  const { parseCalcXml } = require('../../src/transformers/calculator');

  it('parses icdcodes and sets fulloutput=1 for Y', () => {
    const input = parseCalcXml(VALID_CALC_XML);
    expect(input.icdCodes).toEqual(['M54.5']);
    expect(input.fulloutput).toBe(1);
    expect(input.procSummary?.cpt).toEqual(['99213']);
    expect(input.clientid).toBe('claim-1');
  });

  it('sets fulloutput=0 when not Y', () => {
    const xml = `<request><icdcodes><code>M54.5</code></icdcodes><fulloutput>N</fulloutput></request>`;
    const input = parseCalcXml(xml);
    expect(input.fulloutput).toBe(0);
  });

  it('deduplicates repeated codes', () => {
    const xml = `<request><icdcodes><code>M54.5</code><code>M54.5</code></icdcodes></request>`;
    const input = parseCalcXml(xml);
    expect(input.icdCodes).toEqual(['M54.5']);
  });

  it('pads FNOL codes to 2 digits', () => {
    const xml = `<request><icdcodes><code>M54.5</code></icdcodes><bpcode>5</bpcode><noicode>3</noicode></request>`;
    const input = parseCalcXml(xml);
    expect(input.fnolCodes?.[0].bpcode).toBe('05');
    expect(input.fnolCodes?.[0].noicode).toBe('03');
  });

  it('maps preexisting → preExisting in cfactors', () => {
    const xml = `<request><icdcodes><code>M54.5</code></icdcodes>
      <cfactors><preexisting>1</preexisting><depression>0</depression></cfactors></request>`;
    const input = parseCalcXml(xml);
    expect(input.cfactors?.preExisting).toBe(1);
    expect(input.cfactors?.depression).toBe(0);
  });
});
