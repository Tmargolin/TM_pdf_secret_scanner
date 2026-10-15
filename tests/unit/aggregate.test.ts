// Unit tests of the status rules (src/scanner/aggregate.ts, DESIGN.md §4).
import { describe, expect, it } from 'vitest';
import { aggregateFindings, pagesOf, scanStatus, uniqueErrors } from '../../src/scanner/aggregate.ts';
import { joinPages } from '../../src/scanner/chunker.ts';
import type { RawFinding } from '../../src/scanner/parse.ts';
import { FULLY_MASKED, isMaskedValue } from '../../src/shared/messages.ts';
import { ERROR_CODES, type ScanError } from '../../src/shared/types.ts';
import { AWS_EXAMPLE_KEY } from '../helpers/fake-secrets.ts';

const aws = (entity: string | null = AWS_EXAMPLE_KEY): RawFinding => ({ entityType: 'AWS credentials', category: 'Access Tokens', entity });
const password = (entity = 'not-a-real-password'): RawFinding => ({ entityType: 'Password', category: 'Passwords', entity });

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

describe('pagesOf', () => {
  const paged = joinPages(['intro', `key ${AWS_EXAMPLE_KEY}`, 'nothing here', `again ${AWS_EXAMPLE_KEY} and ${AWS_EXAMPLE_KEY}`]);

  it('every page the value occurs on, sorted, each once', () => {
    expect(pagesOf(paged, AWS_EXAMPLE_KEY)).toEqual([2, 4]);
  });

  it('a value that is not in the text: no pages', () => {
    expect(pagesOf(paged, 'AKIA-NOT-IN-THE-TEXT')).toEqual([]);
  });

  it('a value at the very start of the first page', () => {
    expect(pagesOf(joinPages([`${AWS_EXAMPLE_KEY} first`]), AWS_EXAMPLE_KEY)).toEqual([1]);
  });
});

describe('aggregateFindings', () => {
  const paged = joinPages(['intro', `key ${AWS_EXAMPLE_KEY}`, 'nothing', `again ${AWS_EXAMPLE_KEY}; pass not-a-real-password`]);

  it('one finding per secret, with its pages and masked value', () => {
    expect(aggregateFindings([aws()], paged)).toEqual([
      { entityType: 'AWS credentials', category: 'Access Tokens', masked: 'AKIA…LE', pages: [2, 4] },
    ]);
  });

  it('the same secret reported by several chunks (overlap, split halves) is one finding', () => {
    expect(aggregateFindings([aws(), aws(), aws()], paged)).toHaveLength(1);
  });

  it('the same value under two entity types stays two findings', () => {
    const asToken: RawFinding = { entityType: 'Generic token', category: 'Access Tokens', entity: AWS_EXAMPLE_KEY };
    expect(aggregateFindings([aws(), asToken], paged).map((f) => f.entityType)).toEqual(['AWS credentials', 'Generic token']);
  });

  it('findings are in reading order (first occurrence), whatever order the API reported them in', () => {
    expect(aggregateFindings([password(), aws()], paged).map((f) => f.entityType)).toEqual(['AWS credentials', 'Password']);
  });

  it('a value the API reports but that is not in the text verbatim: kept, with no pages, after the located ones', () => {
    const findings = aggregateFindings([{ entityType: 'Token', category: 'x', entity: 'NOT-IN-TEXT-1234567' }, aws()], paged);
    expect(findings).toEqual([
      { entityType: 'AWS credentials', category: 'Access Tokens', masked: 'AKIA…LE', pages: [2, 4] },
      { entityType: 'Token', category: 'x', masked: 'NOT-…67', pages: [] },
    ]);
  });

  it('secrets without a value: kept fully masked, once per type and category', () => {
    const noValue: RawFinding = { entityType: 'Secret', category: '', entity: null };
    const other: RawFinding = { entityType: 'Secret', category: 'Keys', entity: null };
    expect(aggregateFindings([noValue, noValue, other], paged)).toEqual([
      { entityType: 'Secret', category: '', masked: FULLY_MASKED, pages: [] },
      { entityType: 'Secret', category: 'Keys', masked: FULLY_MASKED, pages: [] },
    ]);
  });

  it('no secrets: no findings', () => {
    expect(aggregateFindings([], paged)).toEqual([]);
  });

  it('no plain value ever leaves: every finding passes isMaskedValue and the result never contains a secret', () => {
    const findings = aggregateFindings([aws(), password(), aws(null)], paged);
    for (const finding of findings) expect(isMaskedValue(finding.masked)).toBe(true);
    const json = JSON.stringify(findings);
    expect(json).not.toContain(AWS_EXAMPLE_KEY);
    expect(json).not.toContain('not-a-real-password');
  });
});
