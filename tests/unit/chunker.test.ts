// Unit tests of the chunker (src/scanner/chunker.ts, DESIGN.md §4.2).
// Hand-made cases for each rule, then a seeded random check of the
// invariants over many texts and settings (deterministic: same seed, same
// texts). The only secret-like value is AWS's documented example key.
import { describe, expect, it } from 'vitest';
import {
  chunkText,
  findPemBlocks,
  joinPages,
  jsonUtf8Bytes,
  pageAt,
  pagesInRange,
  REQUEST_OVERHEAD_BYTES,
  requestBodyBytes,
  type Chunk,
  type ChunkOptions,
} from '../../src/scanner/chunker.ts';

const KEY = 'AKIAIOSFODNN7EXAMPLE';
const BIG = 65_536;
const opts = (chunkSize: number, chunkOverlap = 0, maxRequestBytes = BIG): ChunkOptions => ({ chunkSize, chunkOverlap, maxRequestBytes });
const codePoints = (text: string) => [...text].length;
/** "w0 w1 w2 …" – n words, single spaces. */
const words = (n: number, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
const ends = (chunks: Chunk[]) => chunks.map((c) => c.end);

const pem = (lines: number) =>
  ['-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: lines }, (_, i) => `MIIB${String(i).padStart(4, '0')}${'Q'.repeat(56)}`), '-----END RSA PRIVATE KEY-----'].join('\n');

describe('joinPages / pageAt / pagesInRange', () => {
  const paged = joinPages(['ab', '', 'cde']); // "ab\n\ncde"

  it('joins pages with "\\n" and records where each starts', () => {
    expect(paged).toEqual({ text: 'ab\n\ncde', pageStarts: [0, 3, 4] });
  });

  it('maps every offset to its page; a separator belongs to the page before it', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((o) => pageAt(paged, o))).toEqual([1, 1, 1, 2, 3, 3, 3]);
  });

  it('an offset past the end is on the last page', () => {
    expect(pageAt(paged, 999)).toBe(3);
  });

  it('pagesInRange lists every page a range touches', () => {
    expect(pagesInRange(paged, 0, 2)).toEqual([1]);
    expect(pagesInRange(paged, 1, 5)).toEqual([1, 2, 3]);
    expect(pagesInRange(paged, 4, 7)).toEqual([3]);
    expect(pagesInRange(paged, 3, 3)).toEqual([]);
  });

  it('many pages: binary search agrees with a linear scan', () => {
    const pages = Array.from({ length: 300 }, (_, i) => 'x'.repeat(i % 7));
    const many = joinPages(pages);
    for (let offset = 0; offset < many.text.length; offset += 3) {
      const linear = many.pageStarts.filter((s) => s <= offset).length;
      expect(pageAt(many, offset)).toBe(linear);
    }
  });

  it('no pages: empty text, one page start', () => {
    expect(joinPages([])).toEqual({ text: '', pageStarts: [0] });
  });
});

describe('request size accounting', () => {
  it.each([
    ['a', 1],
    ['"', 2],
    ['\\', 2],
    ['\n', 2],
    ['\t', 2],
    ['\u0001', 6],
    ['é', 2],
    ['ש', 2],
    ['€', 3],
    [' ', 3],
    ['😀', 4],
    ['\ud800', 6], // lone surrogate → \ud800
  ])('%j costs %i bytes inside the JSON body', (char, bytes) => {
    expect(jsonUtf8Bytes(char.codePointAt(0) as number)).toBe(bytes);
    expect(requestBodyBytes(char) - REQUEST_OVERHEAD_BYTES).toBe(bytes);
  });

  it('agrees with JSON.stringify + UTF-8 for every code point below U+3000', () => {
    for (let cp = 0; cp < 0x3000; cp++) {
      expect(jsonUtf8Bytes(cp)).toBe(requestBodyBytes(String.fromCodePoint(cp)) - REQUEST_OVERHEAD_BYTES);
    }
  });
});

describe('chunkText – basics', () => {
  it('a text that fits is one chunk, unchanged', () => {
    const text = `config: ${KEY}\nmore text`;
    expect(chunkText(text, opts(500))).toEqual([{ start: 0, end: text.length, text }]);
  });

  it('empty or whitespace-only text: no chunks (the API gives no verdict for them)', () => {
    expect(chunkText('', opts(500))).toEqual([]);
    expect(chunkText(' \n\n\t ', opts(500))).toEqual([]);
  });

  it('a chunk is text.slice(start, end), starts increase, all text is covered', () => {
    const text = words(2000);
    const chunks = chunkText(text, opts(500, 50));
    expect(chunks.length).toBeGreaterThan(10);
    chunks.forEach((c, i) => {
      expect(c.text).toBe(text.slice(c.start, c.end));
      if (i > 0) expect(c.start).toBeGreaterThan((chunks[i - 1] as Chunk).start);
    });
    expect(chunks[0]?.start).toBe(0);
    expect(chunks.at(-1)?.end).toBe(text.length);
  });
});

describe('chunkText – where a chunk ends', () => {
  it('after whitespace only: no word is ever split', () => {
    const text = words(3000);
    for (const chunk of chunkText(text, opts(500))) {
      expect(chunk.end === text.length || /\s/.test(text[chunk.end - 1] as string)).toBe(true);
    }
  });

  it('a blank line beats a later line break, which beats later spaces (within the second half)', () => {
    const filler = 'a '.repeat(150); // 300 characters
    const tail = 'c '.repeat(300);
    const blankFirst = `${filler}para one\n\n${'b '.repeat(50)}line\n${tail}`; // blank line at 310, line break at 415
    expect(blankFirst.slice(0, chunkText(blankFirst, opts(500))[0]?.end)).toMatch(/para one\n\n$/);
    const lineFirst = `${filler}line one\n${tail}`; // line break at 309, spaces up to 500
    expect(lineFirst.slice(0, chunkText(lineFirst, opts(500))[0]?.end)).toMatch(/line one\n$/);
  });

  it('a better break in the first half does not win over a space near the limit', () => {
    const text = `intro\n\n${'d '.repeat(400)}`;
    const [first] = chunkText(text, opts(500));
    expect(first?.end).toBeGreaterThan(450);
  });

  it('no break in the second half: the last break in the first half is used', () => {
    const text = `short words here ${'Z'.repeat(800)}`;
    expect(ends(chunkText(text, opts(500))).slice(0, 1)).toEqual(['short words here '.length]);
  });

  it('an unbroken span longer than chunkSize is cut by force at chunkSize', () => {
    const chunks = chunkText('x'.repeat(1200), opts(500));
    expect(chunks.map((c) => c.text.length)).toEqual([500, 500, 200]);
  });

  it('the AWS key is never split, wherever the limit falls', () => {
    for (let shift = 0; shift < 40; shift++) {
      const text = `${'e '.repeat(240)}${'f'.repeat(shift)} key ${KEY} after ${'g '.repeat(300)}`;
      expect(chunkText(text, opts(500, 0)).filter((c) => c.text.includes(KEY))).not.toHaveLength(0);
    }
  });
});

describe('chunkText – PEM blocks', () => {
  it('finds PEM blocks', () => {
    const text = `before\n${pem(2)}\nafter`;
    const [[start, end]] = findPemBlocks(text) as [[number, number]];
    expect(text.slice(start, end)).toBe(pem(2));
  });

  it('a PEM block that fits is never split, wherever the limit falls', () => {
    const block = pem(4); // ~330 characters
    for (let shift = 0; shift < 300; shift += 7) {
      const text = `${'h '.repeat(50 + shift)}\n${block}\n${'i '.repeat(400)}`;
      const chunks = chunkText(text, opts(500, 200));
      expect(chunks.some((c) => c.text.includes(block))).toBe(true);
      const [[start, end]] = findPemBlocks(text) as [[number, number]];
      for (const c of chunks) {
        expect(start < c.end && c.end < end).toBe(false); // no chunk ends inside
        expect(start < c.start && c.start < end).toBe(false); // no overlap starts inside
      }
    }
  });

  it('a PEM block larger than a chunk is broken at its line breaks, not mid-line', () => {
    const block = pem(20); // ~1,300 characters
    const text = `${block}\n`;
    const chunks = chunkText(text, opts(500));
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks.slice(0, -1)) expect(text[c.end - 1]).toBe('\n');
  });
});

describe('chunkText – overlap', () => {
  it('the next chunk starts up to chunkOverlap code points before the previous end, at a word start', () => {
    const text = words(3000);
    const chunks = chunkText(text, opts(500, 100));
    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1] as Chunk;
      const current = chunks[i] as Chunk;
      const overlap = codePoints(text.slice(current.start, previous.end));
      expect(overlap).toBeGreaterThan(80);
      expect(overlap).toBeLessThanOrEqual(100);
      expect(text[current.start - 1]).toBe(' ');
    }
  });

  it('keeps a label with its value on the next line (context)', () => {
    for (let shift = 0; shift < 30; shift++) {
      const text = `${'j '.repeat(230 + shift)}password:\n${KEY}\n${'k '.repeat(400)}`;
      const withKey = chunkText(text, opts(500, 200)).filter((c) => c.text.includes(KEY));
      expect(withKey.some((c) => c.text.includes(`password:\n${KEY}`))).toBe(true);
    }
  });

  it('chunkOverlap 0: chunks touch but do not overlap', () => {
    const chunks = chunkText(words(2000), opts(500, 0));
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]?.start).toBe(chunks[i - 1]?.end);
  });

  it('is at most half of the previous chunk, so chunking always advances', () => {
    const text = words(2000);
    const chunks = chunkText(text, opts(500, 2000));
    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1] as Chunk;
      expect(codePoints(text.slice(chunks[i]?.start, previous.end))).toBeLessThanOrEqual(codePoints(previous.text) / 2);
    }
  });
});

describe('chunkText – sizes in code points and request bytes', () => {
  it('emoji count as one code point and are never split', () => {
    const chunks = chunkText('😀'.repeat(1200), opts(500));
    expect(chunks.map((c) => codePoints(c.text))).toEqual([500, 500, 200]);
    expect(chunks.map((c) => c.text.length)).toEqual([1000, 1000, 400]);
  });

  it('Hebrew: chunkSize code points fit in the default 64 KB body', () => {
    const chunks = chunkText('שלום עולם '.repeat(10_000), opts(32_000, 200, 65_536));
    for (const c of chunks) expect(requestBodyBytes(c.text)).toBeLessThanOrEqual(65_536);
    expect(codePoints(chunks[0]?.text ?? '')).toBeGreaterThan(31_000);
  });

  it('maxRequestBytes limits a chunk before chunkSize does (multi-byte and escaped text)', () => {
    for (const unit of ['שלום ', '"q" ', 'a\\b ', 'x\u0001y ', '😀 ']) {
      const chunks = chunkText(unit.repeat(5000), opts(50_000, 0, 8192));
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) expect(requestBodyBytes(c.text)).toBeLessThanOrEqual(8192);
      for (const c of chunks.slice(0, -1)) expect(requestBodyBytes(c.text)).toBeGreaterThan(8192 * 0.75); // all but the rest at the end are nearly full
    }
  });

  it('whitespace-only stretches between text are not sent', () => {
    const chunks = chunkText(`alpha${' '.repeat(2000)}omega`, opts(500));
    expect(chunks.map((c) => c.text.trim())).toEqual(['alpha', 'omega']);
  });
});

describe('chunkText – random texts keep every rule (seeded)', () => {
  let seed = 20261015;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
  const tokens = ['alpha', 'beta', KEY, 'password:', 'שלום', 'עולם', '😀x😀', 'y'.repeat(30), 'q"b\\s', 'tab\tz', 'c\u0001d'];
  const randomText = (length: number) => {
    let text = '';
    while (text.length < length) {
      const r = random();
      if (r < 0.02) text += `\n${pem(1 + Math.floor(random() * 10))}\n`;
      else if (r < 0.03) text += 'Z'.repeat(Math.floor(random() * 3000));
      else if (r < 0.08) text += '\n\n';
      else if (r < 0.15) text += '\n';
      else text += `${pick(tokens)} `;
    }
    return text;
  };
  const fits = (span: string, o: ChunkOptions) => codePoints(span) <= o.chunkSize && requestBodyBytes(span) <= o.maxRequestBytes;

  it('200 texts × random settings', () => {
    for (let round = 0; round < 200; round++) {
      const text = randomText(Math.floor(random() * 20_000));
      const o = opts(pick([500, 700, 1000, 3000, 32_000]), pick([0, 50, 200, 2000]), pick([600, 1500, 8192, 65_536]));
      const chunks = chunkText(text, o);
      const blocks = findPemBlocks(text);
      const covered = new Uint8Array(text.length);
      chunks.forEach((c, i) => {
        covered.fill(1, c.start, c.end);
        expect(codePoints(c.text)).toBeLessThanOrEqual(o.chunkSize);
        expect(requestBodyBytes(c.text)).toBeLessThanOrEqual(o.maxRequestBytes);
        expect(c.text.trim()).not.toBe('');
        expect(c.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/); // no split pair
        const previous = chunks[i - 1];
        if (previous && c.start < previous.end) {
          expect(codePoints(text.slice(c.start, previous.end))).toBeLessThanOrEqual(o.chunkOverlap);
          expect(text[c.start - 1]).toMatch(/\s/);
        }
      });
      let uncovered = -1;
      for (let i = 0; i < text.length && uncovered < 0; i++) if (!covered[i] && !/\s/.test(text[i] as string)) uncovered = i;
      expect(uncovered).toBe(-1);
      const inOneChunk = (start: number, end: number) => chunks.some((c) => c.start <= start && end <= c.end);
      const splitTokens = [...text.matchAll(/\S+/g)].filter((m) => fits(m[0], o) && !inOneChunk(m.index, m.index + m[0].length));
      expect(splitTokens.map((m) => m[0])).toEqual([]);
      const splitBlocks = blocks.filter(([start, end]) => fits(text.slice(start, end), o) && !inOneChunk(start, end));
      expect(splitBlocks).toEqual([]);
    }
  });
});
