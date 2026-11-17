import {
  tildeList,
  padFnol,
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


describe('padFnol', () => {
  it('pads single digit', () => {
    expect(padFnol('5')).toBe('05');
  });
  it('leaves two-digit code unchanged', () => {
    expect(padFnol('12')).toBe('12');
  });
});


describe('formatCurrency', () => {
  it('formats with dollar sign and 2 decimals', () => {
    expect(formatCurrency(800)).toBe('$800.00');
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });
});
