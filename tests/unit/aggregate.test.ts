// Unit tests of the status rules (src/scanner/aggregate.ts, DESIGN.md §4).
import { describe, expect, it } from 'vitest';
import { scanStatus, uniqueErrors } from '../../src/scanner/aggregate.ts';
import { ERROR_CODES, type ScanError } from '../../src/shared/types.ts';

describe('scanStatus', () => {
  it('no secret, everything checked → clean', () => {
    expect(scanStatus(0, [])).toBe('clean');
  });

  it('a secret → secrets, whatever else went wrong', () => {
    expect(scanStatus(1, [])).toBe('secrets');
    expect(scanStatus(3, [{ code: 'TEXT_TRUNCATED' }, { code: 'API_TIMEOUT' }])).toBe('secrets');
  });

  it('truncated text with no secret is never clean → error (partial scan)', () => {
    expect(scanStatus(0, [{ code: 'TEXT_TRUNCATED' }])).toBe('error');
  });

  it.each(ERROR_CODES)('no secret + %s → error (that text was not checked)', (code) => {
    expect(scanStatus(0, [{ code }])).toBe('error');
  });
});

describe('uniqueErrors', () => {
  it('keeps each code once, in the order first seen (the first detail wins)', () => {
    const errors: ScanError[] = [
      { code: 'API_TIMEOUT' },
      { code: 'TEXT_TRUNCATED' },
      { code: 'API_HTTP_ERROR', detail: '503' },
      { code: 'API_TIMEOUT' },
      { code: 'API_HTTP_ERROR', detail: '502' },
    ];
    expect(uniqueErrors(errors)).toEqual([{ code: 'API_TIMEOUT' }, { code: 'TEXT_TRUNCATED' }, { code: 'API_HTTP_ERROR', detail: '503' }]);
  });

  it('no errors → none', () => {
    expect(uniqueErrors([])).toEqual([]);
  });
});
