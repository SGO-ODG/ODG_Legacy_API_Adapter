import { buildLegacyXml } from '../../../src/serializers/xmlBuilder';
import { appendLegacyMeta } from '../../../src/serializers/legacyResponse';

describe('buildLegacyXml', () => {
  it('wraps model in <root> element', () => {
    const xml = buildLegacyXml({ ndcCode: '12345-6789' });
    expect(xml).toContain('<root>');
    expect(xml).toContain('<ndcCode>12345-6789</ndcCode>');
    expect(xml).toContain('</root>');
  });

  it('includes XML declaration', () => {
    const xml = buildLegacyXml({ foo: 'bar' });
    expect(xml).toMatch(/^<\?xml version="1\.0"/);
  });

  it('omits undefined values', () => {
    const xml = buildLegacyXml({ a: 'present', b: undefined });
    expect(xml).toContain('<a>');
    expect(xml).not.toContain('<b>');
  });

  it('handles nested objects', () => {
    const xml = buildLegacyXml({ icd: { code: 'M54.5', name: 'Back pain' } });
    expect(xml).toContain('<code>M54.5</code>');
    expect(xml).toContain('<name>Back pain</name>');
  });
});

describe('appendLegacyMeta', () => {
  it('appends rescount', () => {
    const model = appendLegacyMeta({ ndcCode: '12345-6789' }, 1);
    expect(model.rescount).toBe(1);
  });

  it('appends clientid when provided', () => {
    const model = appendLegacyMeta({ ndcCode: '12345-6789' }, 1, 'claim-123');
    expect(model.clientid).toBe('claim-123');
    expect(model.rescount).toBe(1);
  });

  it('does not append clientid when absent', () => {
    const model = appendLegacyMeta({ ndcCode: '12345-6789' }, 1);
    expect(model).not.toHaveProperty('clientid');
  });
});
