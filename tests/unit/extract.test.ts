import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildFixtures, FIXTURES } from '../../scripts/make-fixtures.ts';
import { DOCUMENT_OPTIONS, extractText, joinTextItems, type PdfJs } from '../../src/scanner/extract.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

/** Real pdf.js, with getDocument recorded: the options passed and whether destroy() was called. */
function recordingPdfJs() {
  const calls: { params: Record<string, unknown>; destroyed: boolean }[] = [];
  const recording: PdfJs = {
    getDocument: ((params: Parameters<typeof pdfjs.getDocument>[0]) => {
      const call = { params: params as Record<string, unknown>, destroyed: false };
      calls.push(call);
      const task = pdfjs.getDocument(params);
      const destroy = task.destroy.bind(task);
      task.destroy = async () => {
        call.destroyed = true;
        return destroy();
      };
      return task;
    }) as PdfJs['getDocument'],
  };
  return { recording, calls };
}

describe('fixtures', () => {
  it.each([...buildFixtures()])('%s on disk equals the generator output (run `npm run fixtures` after changing it)', (name, bytes) => {
    expect(fixture(name)).toEqual(bytes);
  });

  it('every fixture listed in the generator exists', () => {
    expect([...buildFixtures().keys()]).toEqual(Object.keys(FIXTURES));
  });
});

describe('extractText – real pdf.js on the fixtures', () => {
  it.each([
    ['one-page.pdf', ['Hello from a one-page PDF.']],
    [
      'multi-page.pdf',
      ['Page one: introduction.', 'Page two: configuration\naws_access_key_id = AKIAIOSFODNN7EXAMPLE', 'Page three: the end.'],
    ],
    ['multi-line.pdf', ['First line\nSecond line\nThird line']],
    ['split-token.pdf', ['key AKIAIOSFODNN7EXAMPLE']], // drawn in pieces, read as one token
    ['special-chars.pdf', ['Parentheses (like these) and a back\\slash']],
    ['empty-page-between.pdf', ['Before the empty page', '', 'After the empty page']], // page numbers stay right
  ])('%s', async (name, pages) => {
    expect(await extractText(pdfjs, fixture(name))).toEqual({ pages });
  });
});

describe('extractText – how pdf.js is used', () => {
  it('opens every document with the safety options (isEvalSupported off, no fonts, no XFA, no canvas)', async () => {
    const { recording, calls } = recordingPdfJs();
    await extractText(recording, fixture('one-page.pdf'));
    expect(calls[0]?.params).toMatchObject({ ...DOCUMENT_OPTIONS });
    expect(DOCUMENT_OPTIONS).toMatchObject({
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      isOffscreenCanvasSupported: false,
    });
  });

  it('passes the shared worker when one is given, and none otherwise', async () => {
    const { recording, calls } = recordingPdfJs();
    await extractText(recording, fixture('one-page.pdf'));
    expect('worker' in (calls[0]?.params ?? {})).toBe(false);
    const worker = new pdfjs.PDFWorker();
    try {
      await extractText(recording, fixture('one-page.pdf'), { worker });
      expect(calls[1]?.params['worker']).toBe(worker);
    } finally {
      worker.destroy();
    }
  });

  it('destroys the document after a successful extraction', async () => {
    const { recording, calls } = recordingPdfJs();
    await extractText(recording, fixture('multi-page.pdf'));
    expect(calls[0]?.destroyed).toBe(true);
  });

  it('destroys the document and passes the error on when the file is not a PDF', async () => {
    const { recording, calls } = recordingPdfJs();
    await expect(extractText(recording, new TextEncoder().encode('not a pdf at all'))).rejects.toMatchObject({
      name: 'InvalidPDFException',
    });
    expect(calls[0]?.destroyed).toBe(true);
  });
});

describe('joinTextItems', () => {
  it('joins text in order and adds a line break where pdf.js reports one', () => {
    expect(
      joinTextItems([
        { str: 'Hello', hasEOL: false },
        { str: ' world', hasEOL: true },
        { str: 'next line', hasEOL: false },
      ]),
    ).toBe('Hello world\nnext line');
  });

  it('skips items without text (marked-content markers)', () => {
    expect(joinTextItems([{ type: 'beginMarkedContent' }, { str: 'text', hasEOL: false }, { type: 'endMarkedContent' }])).toBe('text');
  });

  it('ignores a non-string str and a non-boolean hasEOL', () => {
    expect(joinTextItems([{ str: 42 }, { str: 'a', hasEOL: 'yes' }])).toBe('a');
  });

  it('no items: empty text', () => {
    expect(joinTextItems([])).toBe('');
  });
});
