// PDF → text per page with pdf.js (DESIGN.md §4 step 1, docs/agents/scanner.md).
// pdf.js is passed in (the legacy build, D37): the offscreen document gives
// it the real worker, tests give it pdf.js running in Node. The text is never
// logged or stored; it lives only as long as the job that needs it.

import type { getDocument, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ErrorCode } from '../shared/types.ts';

/** The part of the pdf.js module we use. */
export interface PdfJs {
  getDocument: typeof getDocument;
}

/**
 * Options for every document we open. We only read text, never draw:
 *   isEvalSupported: false – never turn PDF data into JavaScript and run it
 *     (CVE-2024-4367 class of bugs; also forbidden by the MV3 policy);
 *   disableFontFace / useSystemFonts: false – no fonts are loaded into the page;
 *   enableXfa: false – no XFA forms;
 *   stopAtErrors: false – read what can be read from a slightly damaged file;
 *   isOffscreenCanvasSupported: false – no canvas work at all;
 *   verbosity: 0 – errors only in the console, never PDF content.
 */
export const DOCUMENT_OPTIONS = {
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  enableXfa: false,
  stopAtErrors: false,
  isOffscreenCanvasSupported: false,
  verbosity: 0,
} as const;

export interface ExtractedText {
  /** Text of each page; index 0 = page 1. */
  pages: string[];
}

/**
 * Joins a page's text items in reading order, with a line break where pdf.js
 * reports one. Items without text (marked-content markers) are skipped.
 */
export function joinTextItems(items: readonly object[]): string {
  let text = '';
  for (const item of items) {
    if (!('str' in item) || typeof item.str !== 'string') continue;
    text += item.str;
    if ('hasEOL' in item && item.hasEOL === true) text += '\n';
  }
  return text;
}

/**
 * Extracts the text of every page. The document is always destroyed at the
 * end – also on errors – so its memory is released at once.
 * Note: pdf.js takes ownership of `bytes` (they move to the worker).
 * pdf.js errors are passed on; extractPages() classifies them.
 */
export async function extractText(
  pdfjs: PdfJs,
  bytes: Uint8Array,
  options: { worker?: PDFWorker } = {},
): Promise<ExtractedText> {
  const task = pdfjs.getDocument({ data: bytes, ...DOCUMENT_OPTIONS, ...(options.worker ? { worker: options.worker } : {}) });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(joinTextItems(content.items));
      page.cleanup();
    }
    return { pages };
  } finally {
    await task.destroy();
  }
}

/** Why a PDF could not be read. */
export type ExtractionErrorCode = Extract<ErrorCode, 'PDF_ENCRYPTED' | 'PDF_INVALID' | 'NO_TEXT_LAYER'>;

export type ExtractionOutcome = { ok: true; pages: string[] } | { ok: false; code: ExtractionErrorCode };

/**
 * pdf.js error → our code (behaviour checked against pdf.js 6.4.299):
 *   PasswordException ("No password given") → PDF_ENCRYPTED – a password is
 *     needed to open the file. (Files encrypted with an owner password only
 *     open normally and are scanned.)
 *   anything else (InvalidPDFException for damaged, truncated, empty files…)
 *     → PDF_INVALID: the file could not be read, so it was not checked.
 * pdf.js error messages are not passed on – only the code.
 */
export function classifyPdfError(error: unknown): Exclude<ExtractionErrorCode, 'NO_TEXT_LAYER'> {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'PasswordException' ? 'PDF_ENCRYPTED' : 'PDF_INVALID';
}

/** True if any page has text other than whitespace. Scanned PDFs (images only) have none – OCR is out of scope. */
export function hasTextLayer(pages: readonly string[]): boolean {
  return pages.some((page) => page.trim() !== '');
}

/** extractText, with every failure turned into one of our codes. Never throws. */
export async function extractPages(
  pdfjs: PdfJs,
  bytes: Uint8Array,
  options: { worker?: PDFWorker } = {},
): Promise<ExtractionOutcome> {
  let pages: string[];
  try {
    ({ pages } = await extractText(pdfjs, bytes, options));
  } catch (error) {
    return { ok: false, code: classifyPdfError(error) };
  }
  return hasTextLayer(pages) ? { ok: true, pages } : { ok: false, code: 'NO_TEXT_LAYER' };
}
