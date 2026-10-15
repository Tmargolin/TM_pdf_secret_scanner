// Unit tests of bounded splitting (src/scanner/splitter.ts, DESIGN.md §4.2).
// The API is a fake that scans only the first CAP characters of what it gets
// and reports how many it took – like the real API above its limit – or
// answers 413 / an error.
import { describe, expect, it } from 'vitest';
import type { ApiCallOutcome } from '../../src/scanner/api-client.ts';
import type { Chunk } from '../../src/scanner/chunker.ts';
import { createChunkSizer, MIN_CHUNK_CHARS, scanWithSplitting, type SplitScanDeps } from '../../src/scanner/splitter.ts';
import { createLogger } from '../../src/shared/safe-logger.ts';
import { AWS_EXAMPLE_KEY } from '../helpers/fake-secrets.ts';

const codePoints = (text: string) => [...text].length;
const OPTIONS = { chunkOverlap: 200, maxRequestBytes: 65_536 };
const whole = (text: string): Chunk => ({ start: 0, end: text.length, text });
/** "w0 w1 …" with the AWS example key as word `keyAt`. */
const textWithKey = (words: number, keyAt: number) =>
  Array.from({ length: words }, (_, i) => (i === keyAt ? AWS_EXAMPLE_KEY : `w${i}`)).join(' ');

/** Fake API: scans only the first `cap` code points; reports min(sent, cap) as characters. */
function cappedApi(cap: number) {
  const sent: string[] = [];
  const scan = async (text: string): Promise<ApiCallOutcome> => {
    sent.push(text);
    const scanned = [...text].slice(0, cap).join('');
    return {
      kind: 'ok',
      secrets: scanned.includes(AWS_EXAMPLE_KEY) ? [{ entityType: 'AWS credentials', category: 'Access Tokens', entity: AWS_EXAMPLE_KEY }] : [],
      characters: Math.min(codePoints(text), cap),
      chunksRequired: 1,
    };
  };
  return { scan, sent };
}

function setup(scan: SplitScanDeps['scan']) {
  const lines: string[] = [];
  const sizer = createChunkSizer();
  sizer.effective(32_000);
  const deps: SplitScanDeps = {
    scan,
    sizer,
    options: OPTIONS,
    log: createLogger('scan', { sink: (level, line, fields) => void lines.push(`${level} ${line} ${JSON.stringify(fields ?? {})}`) }),
  };
  return { deps, sizer, lines };
}

describe('scanWithSplitting – nothing cut short', () => {
  it('one call; the secrets of that call', async () => {
    const api = cappedApi(1_000_000);
    const text = textWithKey(2000, 1500);
    const { deps, sizer } = setup(api.scan);
    expect(await scanWithSplitting(whole(text), deps)).toEqual({
      secrets: [{ entityType: 'AWS credentials', category: 'Access Tokens', entity: AWS_EXAMPLE_KEY }],
      scannedChunks: 1,
      failedChunks: 0,
      errors: [],
      calls: 1,
    });
    expect(api.sent).toEqual([text]);
    expect(sizer.effective(32_000)).toBe(32_000);
  });

  it('characters are compared in code points: a fully scanned emoji text is not cut short', async () => {
    const text = '😀 '.repeat(2000); // 4,000 code points, 6,000 UTF-16 units
    const { deps } = setup(async () => ({ kind: 'ok', secrets: [], characters: 4000, chunksRequired: 1 }));
    expect(await scanWithSplitting(whole(text), deps)).toMatchObject({ scannedChunks: 1, failedChunks: 0, calls: 1 });
  });

  it('no Token Limitation in the answer (characters null): taken as complete', async () => {
    const { deps } = setup(async () => ({ kind: 'ok', secrets: [], characters: null, chunksRequired: null }));
    expect(await scanWithSplitting(whole('some text'), deps)).toMatchObject({ scannedChunks: 1, calls: 1 });
  });
});

describe('scanWithSplitting – cut short (characters < sent)', () => {
  it('a key beyond what the API scanned is still found, in a half', async () => {
    const text = textWithKey(3000, 2800); // ~17,000 characters, key near the end
    const api = cappedApi(10_000);
    const { deps } = setup(api.scan);
    const result = await scanWithSplitting(whole(text), deps);
    expect(result.secrets.map((s) => s.entity)).toContain(AWS_EXAMPLE_KEY);
    expect(result.failedChunks).toBe(0);
    expect(result.calls).toBeGreaterThan(1);
  });

  it('every piece that counts as scanned was scanned completely, and all text is covered', async () => {
    const text = textWithKey(4000, 10);
    const api = cappedApi(3_000);
    const { deps } = setup(api.scan);
    const result = await scanWithSplitting(whole(text), deps);
    const complete = api.sent.filter((piece) => codePoints(piece) <= 3_000);
    expect(result.scannedChunks).toBe(complete.length);
    expect(result.failedChunks).toBe(0);
    const covered = complete.join(' ');
    for (const word of text.split(' ')) expect(covered).toContain(word);
  });

  it('the halves follow the chunker rules: no word and no PEM block is split', async () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: 5 }, (_, i) => `MIIB${i}${'Q'.repeat(59)}`), '-----END RSA PRIVATE KEY-----'].join('\n');
    const words = (prefix: string) => Array.from({ length: 1500 }, (_, i) => `${prefix}${i}`).join(' ');
    const text = `${words('a')}\n${pem}\n${words('b')}`;
    const api = cappedApi(4_000);
    const { deps } = setup(api.scan);
    await scanWithSplitting(whole(text), deps);
    const complete = api.sent.filter((piece) => codePoints(piece) <= 4_000);
    expect(complete.some((piece) => piece.includes(pem))).toBe(true);
    for (const piece of complete) {
      const at = text.indexOf(piece);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at === 0 || /\s/.test(text[at - 1] as string)).toBe(true); // starts at a word start
      const end = at + piece.length;
      expect(end === text.length || /\s/.test(text[end - 1] as string)).toBe(true); // ends after whitespace
    }
  });

  it('secrets reported for the cut-short chunk itself are kept', async () => {
    const text = textWithKey(3000, 5); // key at the very start: seen even in the cut-short call
    const api = cappedApi(10_000);
    const { deps } = setup(api.scan);
    const result = await scanWithSplitting(whole(text), deps);
    expect(result.secrets.length).toBeGreaterThanOrEqual(2); // once from the cut-short call, once from its half (aggregation de-duplicates)
  });

  it('the effective chunk size shrinks to the half and stays there', async () => {
    const text = textWithKey(3000, 10); // ~17,000 characters
    const { deps, sizer } = setup(cappedApi(10_000).scan);
    await scanWithSplitting(whole(text), deps);
    const size = sizer.effective(32_000);
    expect(size).toBeLessThanOrEqual(Math.ceil(codePoints(text) / 2));
    expect(size).toBeGreaterThanOrEqual(MIN_CHUNK_CHARS);
  });

  it('logs the sizes only – never the text', async () => {
    const text = textWithKey(3000, 2800);
    const { deps, lines } = setup(cappedApi(10_000).scan);
    await scanWithSplitting(whole(text), deps);
    expect(lines.some((l) => l.startsWith('warn [PSS:scan] chunk cut short by the API {"sent":'))).toBe(true);
    expect(lines.join('\n')).not.toContain(AWS_EXAMPLE_KEY);
    expect(lines.join('\n')).not.toContain('w2799');
  });
});

describe('scanWithSplitting – 413 and the floor', () => {
  it('413 → split; the halves are scanned', async () => {
    const text = textWithKey(3000, 2800);
    const api = cappedApi(1_000_000);
    const { deps } = setup(async (piece) => (codePoints(piece) > 10_000 ? { kind: 'too-large' } : api.scan(piece)));
    const result = await scanWithSplitting(whole(text), deps);
    expect(result.secrets.map((s) => s.entity)).toContain(AWS_EXAMPLE_KEY);
    expect(result).toMatchObject({ failedChunks: 0, errors: [] });
  });

  it(`still cut short at ${MIN_CHUNK_CHARS} characters or less → CHUNK_TOO_LARGE, a failed chunk`, async () => {
    const { deps, sizer } = setup(cappedApi(100).scan);
    const result = await scanWithSplitting(whole(textWithKey(150, 1000)), deps); // ~800 characters
    expect(result.failedChunks).toBeGreaterThan(0);
    expect(result.errors.every((e) => e.code === 'CHUNK_TOO_LARGE')).toBe(true);
    expect(sizer.effective(32_000)).toBe(MIN_CHUNK_CHARS);
  });

  it('always 413: bounded – every piece ends at the floor', async () => {
    const text = textWithKey(8000, 10); // ~47,000 characters
    let calls = 0;
    const { deps } = setup(async () => {
      calls++;
      return { kind: 'too-large' };
    });
    const result = await scanWithSplitting(whole(text), deps);
    expect(result.scannedChunks).toBe(0);
    expect(result.failedChunks).toBeGreaterThan(0);
    expect(result.calls).toBe(calls);
    // A tree of halves down to the floor (~320 calls here), not an endless loop.
    expect(calls).toBeLessThan(8 * (codePoints(text) / MIN_CHUNK_CHARS));
  });

  it('a small chunk cut short is not split at all', async () => {
    const { deps } = setup(async () => ({ kind: 'too-large' }));
    expect(await scanWithSplitting(whole('tiny text'), deps)).toEqual({
      secrets: [],
      scannedChunks: 0,
      failedChunks: 1,
      errors: [{ code: 'CHUNK_TOO_LARGE' }],
      calls: 1,
    });
  });
});

describe('scanWithSplitting – API errors', () => {
  it('an error answer is a failed chunk with its code (no split)', async () => {
    const { deps } = setup(async () => ({ kind: 'error', code: 'API_HTTP_ERROR', detail: '503' }));
    expect(await scanWithSplitting(whole(textWithKey(3000, 1)), deps)).toEqual({
      secrets: [],
      scannedChunks: 0,
      failedChunks: 1,
      errors: [{ code: 'API_HTTP_ERROR', detail: '503' }],
      calls: 1,
    });
  });

  it('an error in one half does not lose the other half', async () => {
    const text = textWithKey(3000, 2900);
    const api = cappedApi(10_000);
    let call = 0;
    const { deps } = setup(async (piece) => (++call === 2 ? { kind: 'error', code: 'API_TIMEOUT' } : api.scan(piece)));
    const result = await scanWithSplitting(whole(text), deps);
    expect(result.errors).toEqual([{ code: 'API_TIMEOUT' }]);
    expect(result.failedChunks).toBe(1);
    expect(result.secrets.map((s) => s.entity)).toContain(AWS_EXAMPLE_KEY);
  });

  it('a rejected call (the job timed out) rejects', async () => {
    const { deps } = setup(async () => {
      throw new DOMException('job timed out', 'AbortError');
    });
    await expect(scanWithSplitting(whole('text'), deps)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('createChunkSizer', () => {
  it('starts at the configured size', () => {
    expect(createChunkSizer().effective(32_000)).toBe(32_000);
  });

  it('only shrinks, never grows', () => {
    const sizer = createChunkSizer();
    sizer.effective(32_000);
    sizer.shrink(10_000);
    sizer.shrink(20_000);
    expect(sizer.effective(32_000)).toBe(10_000);
  });

  it(`never below ${MIN_CHUNK_CHARS}`, () => {
    const sizer = createChunkSizer();
    sizer.shrink(10);
    expect(sizer.effective(32_000)).toBe(MIN_CHUNK_CHARS);
  });

  it('never above the configured size', () => {
    const sizer = createChunkSizer();
    sizer.effective(32_000);
    sizer.shrink(10_000);
    expect(sizer.effective(8_000)).toBe(8_000); // chunkSize lowered below the shrunk size: start over
  });

  it('starts over when chunkSize changes in the settings', () => {
    const sizer = createChunkSizer();
    sizer.effective(32_000);
    sizer.shrink(5_000);
    expect(sizer.effective(32_000)).toBe(5_000);
    expect(sizer.effective(40_000)).toBe(40_000);
  });

  it('a shrink before the first use is kept', () => {
    const sizer = createChunkSizer();
    sizer.shrink(7_000);
    expect(sizer.effective(32_000)).toBe(7_000);
  });
});
