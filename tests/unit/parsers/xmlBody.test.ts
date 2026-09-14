import { parseXmlBody, xmlRootKey, xmlStr, xmlStrArray } from '../../../src/parsers/xmlBody';
import { LegacyError } from '../../../src/errors/legacyErrors';

describe('parseXmlBody', () => {
  it('parses valid XML', () => {
    const xml = '<request><text>back pain</text></request>';
    const result = parseXmlBody(xml);
    expect(result).toHaveProperty('request');
  });

  it('parses XML with <?xml version="1.0" encoding="UTF-8"?> declaration', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><onsearch><text>pain</text></onsearch>';
    const result = parseXmlBody(xml);
    // Declaration must not appear as a key; root element must be the only key
    expect(xmlRootKey(result)).toBe('onsearch');
    expect(xmlStr(result, 'onsearch', 'text')).toBe('pain');
  });

  it('parses XML with <?xml version="1.0"?> declaration (no encoding)', () => {
    const xml = '<?xml version="1.0"?><onesearch><text>C2</text></onesearch>';
    const result = parseXmlBody(xml);
    expect(xmlRootKey(result)).toBe('onesearch');
    expect(xmlStr(result, 'onesearch', 'text')).toBe('C2');
  });

  it('throws LegacyError for invalid XML', () => {
    expect(() => parseXmlBody('<unclosed')).toThrow(LegacyError);
  });

  it('throws LegacyError for empty body', () => {
    expect(() => parseXmlBody('')).toThrow(LegacyError);
  });

  it('throws LegacyError for whitespace-only body', () => {
    expect(() => parseXmlBody('   ')).toThrow(LegacyError);
  });
});

describe('xmlStr', () => {
  it('reads a nested string value', () => {
    const xml = '<request><text>hello</text></request>';
    const obj = parseXmlBody(xml);
    expect(xmlStr(obj, 'request', 'text')).toBe('hello');
  });

  it('returns undefined for missing path', () => {
    const obj = parseXmlBody('<request></request>');
    expect(xmlStr(obj, 'request', 'missing')).toBeUndefined();
  });
});

describe('xmlStrArray', () => {
  it('reads array of codes', () => {
    const xml = '<request><icdcodes><code>M54.5</code><code>M54.50</code></icdcodes></request>';
    const obj = parseXmlBody(xml);
    const codes = xmlStrArray(obj, 'request', 'icdcodes', 'code');
    expect(codes).toEqual(['M54.5', 'M54.50']);
  });

  it('returns [] for missing path', () => {
    const obj = parseXmlBody('<request></request>');
    expect(xmlStrArray(obj, 'request', 'missing', 'code')).toEqual([]);
  });
});
