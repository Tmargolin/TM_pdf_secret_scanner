import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildFixtures, buildPdf, FIXTURES } from '../../scripts/make-fixtures.ts';
import {
  classifyPdfError,
  DOCUMENT_OPTIONS,
  extractPages,
  extractText,
  hasTextLayer,
  joinTextItems,
  type PdfJs,
} from '../../src/scanner/extract.ts';

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

describe('extractText – abort (job timeout)', () => {
  it('already aborted: fails with the abort reason and never opens the document', async () => {
    const { recording, calls } = recordingPdfJs();
    const controller = new AbortController();
    controller.abort();
    await expect(extractText(recording, fixture('one-page.pdf'), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });

  it('aborted while reading: fails and the document is destroyed', async () => {
    const { recording, calls } = recordingPdfJs();
    const controller = new AbortController();
    const reading = extractText(recording, fixture('multi-page.pdf'), { signal: controller.signal });
    controller.abort();
    await expect(reading).rejects.toBeDefined();
    expect(calls[0]?.destroyed).toBe(true);
  });

  it('abort ends a pdf.js call that would otherwise never finish (the task is destroyed at once)', async () => {
    let failOpen: (error: Error) => void = () => {};
    let destroyCalls = 0;
    const hanging: PdfJs = {
      getDocument: (() => ({
        promise: new Promise((_resolve, reject) => {
          failOpen = reject;
        }),
        destroy: async () => {
          destroyCalls++;
          failOpen(new Error('Worker was destroyed'));
        },
      })) as unknown as PdfJs['getDocument'],
    };
    const controller = new AbortController();
    const reading = extractText(hanging, fixture('one-page.pdf'), { signal: controller.signal });
    controller.abort();
    await expect(reading).rejects.toThrow('Worker was destroyed');
    expect(destroyCalls).toBeGreaterThan(0);
  });

  it('a shared worker survives an aborted document and reads the next one', async () => {
    const worker = new pdfjs.PDFWorker({ verbosity: 0 });
    try {
      const controller = new AbortController();
      const reading = extractText(pdfjs, fixture('multi-page.pdf'), { worker, signal: controller.signal });
      controller.abort();
      await reading.catch(() => {});
      expect(worker.destroyed).toBe(false);
      expect(await extractText(pdfjs, fixture('one-page.pdf'), { worker })).toEqual({ pages: ['Hello from a one-page PDF.'] });
    } finally {
      worker.destroy();
    }
  });

  it('a signal that never aborts changes nothing', async () => {
    const { signal } = new AbortController();
    expect(await extractText(pdfjs, fixture('one-page.pdf'), { signal })).toEqual({ pages: ['Hello from a one-page PDF.'] });
  });

  it('extractPages after an abort still does not throw (the caller has given up on it)', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await extractPages(pdfjs, fixture('one-page.pdf'), { signal: controller.signal })).toEqual({ ok: false, code: 'PDF_INVALID' });
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

describe('extractPages – files that cannot be scanned (5.2)', () => {
  it('a password-protected PDF → PDF_ENCRYPTED', async () => {
    expect(await extractPages(pdfjs, fixture('encrypted.pdf'))).toEqual({ ok: false, code: 'PDF_ENCRYPTED' });
  });

  it('the encrypted fixture is real encryption: with the password, pdf.js reads it', async () => {
    const task = pdfjs.getDocument({ data: fixture('encrypted.pdf'), password: 'secret', ...DOCUMENT_OPTIONS });
    try {
      const page = await (await task.promise).getPage(1);
      expect(joinTextItems((await page.getTextContent()).items)).toBe('Behind a password: AKIAIOSFODNN7EXAMPLE');
    } finally {
      await task.destroy();
    }
  });

  it('encrypted with an owner password only (no password needed to open) → scanned normally', async () => {
    expect(await extractPages(pdfjs, fixture('owner-password-only.pdf'))).toEqual({ ok: true, pages: ['Restricted, but readable'] });
  });

  it('a page that only draws shapes (like a scan) → NO_TEXT_LAYER', async () => {
    expect(await extractPages(pdfjs, fixture('no-text.pdf'))).toEqual({ ok: false, code: 'NO_TEXT_LAYER' });
  });

  it('text that is only whitespace → NO_TEXT_LAYER', async () => {
    expect(await extractPages(pdfjs, buildPdf([['   '], ['  ']]))).toEqual({ ok: false, code: 'NO_TEXT_LAYER' });
  });

  it('an empty page next to pages with text → scanned (page numbers kept)', async () => {
    expect(await extractPages(pdfjs, fixture('empty-page-between.pdf'))).toEqual({
      ok: true,
      pages: ['Before the empty page', '', 'After the empty page'],
    });
  });

  const multiPage = fixture('multi-page.pdf');
  it.each([
    ['garbage after %PDF-', new TextEncoder().encode('%PDF-1.4\nthis is not really a pdf\n')],
    ['a truncated file (60 %)', multiPage.slice(0, Math.floor(multiPage.length * 0.6))],
    ['only the header', new TextEncoder().encode('%PDF-1.7')],
    ['zero bytes', new Uint8Array(0)],
  ])('%s → PDF_INVALID', async (_name, bytes) => {
    expect(await extractPages(pdfjs, bytes)).toEqual({ ok: false, code: 'PDF_INVALID' });
  });

  it('never throws – not even if pdf.js itself throws at once', async () => {
    const broken: PdfJs = {
      getDocument: (() => {
        throw new Error('worker could not start');
      }) as PdfJs['getDocument'],
    };
    await expect(extractPages(broken, fixture('one-page.pdf'))).resolves.toEqual({ ok: false, code: 'PDF_INVALID' });
  });

  it('destroys the document also when classifying a failure', async () => {
    const { recording, calls } = recordingPdfJs();
    await extractPages(recording, fixture('encrypted.pdf'));
    expect(calls[0]?.destroyed).toBe(true);
  });
});

describe('classifyPdfError', () => {
  it.each([
    [{ name: 'PasswordException', code: 1 }, 'PDF_ENCRYPTED'],
    [{ name: 'PasswordException', code: 2 }, 'PDF_ENCRYPTED'],
    [{ name: 'InvalidPDFException' }, 'PDF_INVALID'],
    [{ name: 'UnknownErrorException' }, 'PDF_INVALID'],
    [new Error('anything'), 'PDF_INVALID'],
    ['a string', 'PDF_INVALID'],
    [null, 'PDF_INVALID'],
    [undefined, 'PDF_INVALID'],
  ])('%j → %s', (error, code) => {
    expect(classifyPdfError(error)).toBe(code);
  });
});

describe('hasTextLayer', () => {
  it.each([
    [['text'], true],
    [['', ' x '], true],
    [[], false],
    [['', '   ', '\n\t'], false],
  ])('%j → %s', (pages, expected) => {
    expect(hasTextLayer(pages)).toBe(expected);
  });
});
