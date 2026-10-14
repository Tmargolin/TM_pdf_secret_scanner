// PDF extraction for jobs (docs/agents/offscreen.md): at most
// maxParallelExtractions PDFs are parsed at once, all on one shared pdf.js
// worker (DESIGN.md §4.1). The worker is created on first use and re-created
// only if it was destroyed.

import type { PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPages, type ExtractionOutcome, type PdfJs } from '../scanner/extract.ts';
import { createLimiter } from './limiter.ts';

export interface ExtractorDeps {
  pdfjs: PdfJs;
  createWorker(): PDFWorker;
  /** Read at every start, so a changed setting applies to the next PDF. */
  maxParallel(): number;
}

export interface Extractor {
  /** Never throws for PDF problems; rejects only if `signal` aborts while waiting for a slot. */
  extract(bytes: Uint8Array, signal?: AbortSignal): Promise<ExtractionOutcome>;
  stats(): { active: number; waiting: number; workersCreated: number };
}

export function createExtractor(deps: ExtractorDeps): Extractor {
  const limiter = createLimiter(deps.maxParallel);
  let worker: PDFWorker | null = null;
  let workersCreated = 0;

  const sharedWorker = (): PDFWorker => {
    if (worker === null || worker.destroyed) {
      worker = deps.createWorker();
      workersCreated++;
    }
    return worker;
  };

  return {
    extract: (bytes, signal) =>
      limiter.run(() => extractPages(deps.pdfjs, bytes, { worker: sharedWorker(), ...(signal ? { signal } : {}) }), signal),
    stats: () => ({ ...limiter.stats(), workersCreated }),
  };
}
