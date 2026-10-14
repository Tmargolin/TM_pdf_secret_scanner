// PDF → text per page with pdf.js (DESIGN.md §4 step 1, docs/agents/scanner.md).
// pdf.js is passed in (the legacy build, D37): the offscreen document gives
// it the real worker, tests give it pdf.js running in Node. The text is never
// logged or stored; it lives only as long as the job that needs it.

import type { getDocument, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';

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
 * Errors (encrypted, invalid…) are passed on; they are classified in 5.2.
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
