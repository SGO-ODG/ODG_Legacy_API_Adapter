import {
  tildeList,
  normalizeNdc,
  isNumeric,
  padFnol,
  isoToLegacyDate,
  formatCurrency,
} from '../../../src/parsers/queryParams';

describe('tildeList', () => {
  it('splits tilde-separated values', () => {
    expect(tildeList('12345-6789~98765-4321')).toEqual(['12345-6789', '98765-4321']);
  });
  it('trims whitespace', () => {
    expect(tildeList(' a ~ b ')).toEqual(['a', 'b']);
  });
  it('filters empty segments', () => {
    expect(tildeList('a~~b')).toEqual(['a', 'b']);
  });
  it('returns [] for undefined', () => {
    expect(tildeList(undefined)).toEqual([]);
  });
});

describe('normalizeNdc', () => {
  it('normalizes a standard NDC with dashes', () => {
    expect(normalizeNdc('12345-6789')).toBe('12345-6789');
  });
  it('normalizes a 9-digit numeric string', () => {
    expect(normalizeNdc('123456789')).toBe('12345-6789');
  });
  it('left-pads short codes', () => {
    expect(normalizeNdc('123')).toBe('00000-0123');
  });
  it('strips non-numeric chars then pads to 9 digits', () => {
    // '1234-5678' → strip dash → '12345678' (8 digits) → pad → '012345678' → '01234-5678'
    expect(normalizeNdc('1234-5678')).toBe('01234-5678');
  });
});

describe('isNumeric', () => {
  it('returns true for digit strings', () => {
    expect(isNumeric('12345')).toBe(true);
  });
  it('returns false for strings with letters', () => {
    expect(isNumeric('abc')).toBe(false);
    expect(isNumeric('12a45')).toBe(false);
  });
});

describe('padFnol', () => {
  it('pads single digit', () => {
    expect(padFnol('5')).toBe('05');
  });
  it('leaves two-digit code unchanged', () => {
    expect(padFnol('12')).toBe('12');
  });
});

describe('isoToLegacyDate', () => {
  it('converts ISO date to MM/DD/YYYY', () => {
    expect(isoToLegacyDate('2026-01-15T00:00:00Z')).toBe('01/15/2026');
  });
  it('returns original on invalid input', () => {
    expect(isoToLegacyDate('not-a-date')).toBe('not-a-date');
  });
});

describe('formatCurrency', () => {
  it('formats with dollar sign and 2 decimals', () => {
    expect(formatCurrency(800)).toBe('$800.00');
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });
});
