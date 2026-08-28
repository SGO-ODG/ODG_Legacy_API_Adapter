import { parseXmlBody, xmlStr, xmlStrArray } from '../../../src/parsers/xmlBody';
import { LegacyError } from '../../../src/errors/legacyErrors';

describe('parseXmlBody', () => {
  it('parses valid XML', () => {
    const xml = '<request><text>back pain</text></request>';
    const result = parseXmlBody(xml);
    expect(result).toHaveProperty('request');
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
