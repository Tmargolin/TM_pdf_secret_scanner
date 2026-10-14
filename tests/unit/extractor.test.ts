// Unit tests of the extractor (src/offscreen/extractor.ts): the
// maxParallelExtractions limit and the shared pdf.js worker, with real pdf.js
// on the fixtures. Open documents are counted from getDocument to destroy().
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import { createExtractor } from '../../src/offscreen/extractor.ts';
import type { PdfJs } from '../../src/scanner/extract.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
type PdfWorker = InstanceType<typeof pdfjs.PDFWorker>;

const workers: PdfWorker[] = [];
afterEach(() => {
  workers.splice(0).forEach((w) => w.destroy());
});

/** Real pdf.js that counts documents open at the same time and records the worker each one got. */
function countingPdfJs() {
  const state = { open: 0, peak: 0, workersUsed: [] as unknown[] };
  const counting: PdfJs = {
    getDocument: ((params: Parameters<typeof pdfjs.getDocument>[0]) => {
      state.open++;
      state.peak = Math.max(state.peak, state.open);
      state.workersUsed.push((params as { worker?: unknown }).worker);
      const task = pdfjs.getDocument(params);
      const destroy = task.destroy.bind(task);
      let counted = false;
      task.destroy = async () => {
        if (!counted) state.open--;
        counted = true;
        return destroy();
      };
      return task;
    }) as PdfJs['getDocument'],
  };
  return { counting, state };
}

function setup(maxParallel: () => number) {
  const { counting, state } = countingPdfJs();
  const extractor = createExtractor({
    pdfjs: counting,
    createWorker: () => {
      const worker = new pdfjs.PDFWorker({ verbosity: 0 });
      workers.push(worker);
      return worker;
    },
    maxParallel,
  });
  return { extractor, state };
}

const MANY = ['one-page.pdf', 'multi-page.pdf', 'multi-line.pdf', 'encrypted.pdf', 'no-text.pdf', 'one-page.pdf'];

describe('createExtractor', () => {
  it.each([1, 2, 4])('never more than maxParallelExtractions (%i) PDFs open at once', async (max) => {
    const { extractor, state } = setup(() => max);
    await Promise.all(MANY.map((name) => extractor.extract(fixture(name))));
    expect(state.peak).toBe(max);
    expect(state.open).toBe(0);
  });

  it('one shared worker for every PDF, created on first use', async () => {
    const { extractor, state } = setup(() => 2);
    expect(extractor.stats().workersCreated).toBe(0);
    await Promise.all(MANY.map((name) => extractor.extract(fixture(name))));
    await extractor.extract(fixture('one-page.pdf')); // later batches too
    expect(extractor.stats().workersCreated).toBe(1);
    expect(new Set(state.workersUsed)).toEqual(new Set([workers[0]]));
  });

  it('the worker is re-created only after it was destroyed', async () => {
    const { extractor } = setup(() => 1);
    await extractor.extract(fixture('one-page.pdf'));
    workers[0]?.destroy();
    expect(await extractor.extract(fixture('one-page.pdf'))).toEqual({ ok: true, pages: ['Hello from a one-page PDF.'] });
    expect(extractor.stats().workersCreated).toBe(2);
  });

  it('returns each PDF its own outcome, also with PDF errors in between', async () => {
    const { extractor } = setup(() => 2);
    const outcomes = await Promise.all(['one-page.pdf', 'encrypted.pdf', 'no-text.pdf'].map((n) => extractor.extract(fixture(n))));
    expect(outcomes).toEqual([
      { ok: true, pages: ['Hello from a one-page PDF.'] },
      { ok: false, code: 'PDF_ENCRYPTED' },
      { ok: false, code: 'NO_TEXT_LAYER' },
    ]);
  });

  it('a job that times out while waiting for a slot leaves the queue and is never parsed', async () => {
    const { extractor, state } = setup(() => 1);
    const first = extractor.extract(fixture('multi-page.pdf'));
    const controller = new AbortController();
    const waiting = extractor.extract(fixture('one-page.pdf'), controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await first;
    expect(state.workersUsed).toHaveLength(1); // only the first was opened
    expect(extractor.stats()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('a job that times out while parsing frees its slot for the next PDF', async () => {
    const { extractor, state } = setup(() => 1);
    const controller = new AbortController();
    const aborted = extractor.extract(fixture('multi-page.pdf'), controller.signal);
    const next = extractor.extract(fixture('one-page.pdf'));
    controller.abort();
    await aborted; // never throws for PDF problems; the job registry has already given up on it
    expect(await next).toEqual({ ok: true, pages: ['Hello from a one-page PDF.'] });
    expect(state.open).toBe(0);
  });
});
