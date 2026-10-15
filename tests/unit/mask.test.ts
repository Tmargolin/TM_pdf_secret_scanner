// Unit tests of masking (src/scanner/mask.ts, DESIGN.md §8).
import { describe, expect, it } from 'vitest';
import { maskSecret, MIN_PARTLY_MASKED_CHARS } from '../../src/scanner/mask.ts';
import { FULLY_MASKED, isMaskedValue } from '../../src/shared/messages.ts';
import { AWS_EXAMPLE_KEY, fakeAwsKeyId } from '../helpers/fake-secrets.ts';

describe('maskSecret', () => {
  it('a long secret: first 4 + "…" + last 2', () => {
    expect(maskSecret(AWS_EXAMPLE_KEY)).toBe('AKIA…LE');
  });

  it(`exactly ${MIN_PARTLY_MASKED_CHARS} characters: partly masked; one less: fully masked`, () => {
    expect(maskSecret('abcdefghijkl')).toBe('abcd…kl');
    expect(maskSecret('abcdefghijk')).toBe(FULLY_MASKED);
  });

  it('short secrets and missing values are fully masked', () => {
    for (const value of ['', 'x', 'pass1234', null]) expect(maskSecret(value)).toBe(FULLY_MASKED);
  });

  it('counts code points: emoji are never cut in half', () => {
    expect(maskSecret('😀😀😀😀abcdefgh😀😀')).toBe('😀😀😀😀…😀😀');
    expect(maskSecret('😀'.repeat(11))).toBe(FULLY_MASKED); // 11 code points, 22 UTF-16 units
  });

  it('a secret with "…" where the mask keeps it is fully masked (the result must stay recognisable as masked)', () => {
    expect(maskSecret('ab…dxxxxxxxxxyz')).toBe(FULLY_MASKED);
    expect(maskSecret('abcdxxxxxxxxx…z')).toBe(FULLY_MASKED);
  });

  it('never shows more than 6 characters of the secret, and always passes isMaskedValue', () => {
    for (let i = 0; i < 50; i++) {
      const secret = `${fakeAwsKeyId()}${'x'.repeat(i)}`;
      const masked = maskSecret(secret);
      expect(isMaskedValue(masked)).toBe(true);
      expect([...masked.replace('…', '')]).toHaveLength(6);
      expect(masked).not.toContain(secret.slice(4, -2));
    }
  });
});
