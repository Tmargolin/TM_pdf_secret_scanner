import { describe, expect, it } from 'vitest';
import { isPdf, keepPdfs } from '../../src/content/pdf-filter.ts';

const file = (content: string, name = 'x.pdf') => new File([content], name);

describe('isPdf – by content, not by name or type', () => {
  it.each([
    ['%PDF-1.7 rest of file', true],
    ['%PDF-', true],
    ['%PDF', false], // too short
    ['%pdf-1.7', false], // case matters
    [' %PDF-1.7', false], // must be at the very start
    ['PK\u0003\u0004 a zip', false],
    ['', false],
  ])('%j → %s', async (content, expected) => {
    expect(await isPdf(file(content))).toBe(expected);
  });

  it('ignores the name and the MIME type', async () => {
    expect(await isPdf(new File(['%PDF-1.4'], 'report.txt', { type: 'text/plain' }))).toBe(true);
    expect(await isPdf(new File(['not a pdf'], 'report.pdf', { type: 'application/pdf' }))).toBe(false);
  });

  it('reads only the first 5 bytes', async () => {
    let requested: [number | undefined, number | undefined] | undefined;
    const big = file('%PDF-1.7' + 'x'.repeat(1_000_000));
    const spy = Object.assign(Object.create(big) as Blob, {
      slice: (start?: number, end?: number) => {
        requested = [start, end];
        return big.slice(start, end);
      },
    });
    expect(await isPdf(spy)).toBe(true);
    expect(requested).toEqual([0, 5]);
  });

  it('an unreadable file counts as "not a PDF" and does not throw', async () => {
    const broken = { slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }) } as unknown as Blob;
    expect(await isPdf(broken)).toBe(false);
  });
});

describe('keepPdfs', () => {
  it('keeps only the PDFs, in their original order', async () => {
    const a = file('%PDF-1 a', 'a.pdf');
    const b = file('text', 'b.txt');
    const c = file('%PDF-1 c', 'c.pdf');
    const d = file('fake', 'd.pdf');
    expect(await keepPdfs([a, b, c, d])).toEqual([a, c]);
  });

  it('an empty list or no PDFs: empty result', async () => {
    expect(await keepPdfs([])).toEqual([]);
    expect(await keepPdfs([file('text', 'notes.txt')])).toEqual([]);
  });
});
