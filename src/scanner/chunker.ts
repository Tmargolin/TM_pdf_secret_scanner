// Text → chunks for the API (DESIGN.md §4.2, docs/agents/scanner.md).
//
//   pages ──joinPages──▶ one text + page start offsets (pageAt: offset → page)
//   text  ──chunkText──▶ chunks { start, end, text }, each within chunkSize code
//                        points AND maxRequestBytes of JSON request body
//
// Where a chunk may end (it ends just after a whitespace character, so no run
// of non-whitespace – where a secret would be – is ever split):
//   1. a blank line   2. a line break   3. any whitespace
// The best kind found in the second half of the allowed window wins; a
// better kind further back is not worth a chunk half as long. If the second
// half has no break at all, the last break anywhere in the window is used.
// Never inside a PEM block (-----BEGIN …----- … -----END …-----), unless the
// block itself is larger than the window – then at whitespace inside it. Only
// an unbroken span longer than the window is cut by force (never inside a
// surrogate pair).
// Overlap: the next chunk starts about chunkOverlap code points before the
// previous end, moved forward to the start of a word and out of any PEM
// block; at most half of the previous chunk, so chunking always advances.
// Chunks of whitespace only are dropped (the API returns no verdict for them).
//
// Offsets are UTF-16 indexes into the text (what String.slice uses); sizes
// are counted in code points, as the design specifies.

/** The pages of a PDF as one text, joined with "\n". */
export interface PagedText {
  text: string;
  /** pageStarts[i] = offset where page i + 1 starts; pageStarts[0] = 0. */
  pageStarts: number[];
}

export interface Chunk {
  /** UTF-16 offsets into the joined text: text.slice(start, end). */
  start: number;
  end: number;
  text: string;
}

export interface ChunkOptions {
  /** Maximum code points per chunk. */
  chunkSize: number;
  /** Code points repeated from the end of the previous chunk, for context. */
  chunkOverlap: number;
  /** Maximum UTF-8 size of the request body {"prompt":"…"} in bytes. */
  maxRequestBytes: number;
}

export function joinPages(pages: readonly string[]): PagedText {
  const pageStarts: number[] = [];
  let offset = 0;
  for (const page of pages) {
    pageStarts.push(offset);
    offset += page.length + 1; // + the "\n" separator
  }
  return { text: pages.join('\n'), pageStarts: pageStarts.length > 0 ? pageStarts : [0] };
}

/** Page number (1-based) of the character at `offset` (binary search). */
export function pageAt(paged: PagedText, offset: number): number {
  let low = 0;
  let high = paged.pageStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((paged.pageStarts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Page numbers touched by the range [start, end). */
export function pagesInRange(paged: PagedText, start: number, end: number): number[] {
  if (end <= start) return [];
  const first = pageAt(paged, start);
  const last = pageAt(paged, end - 1);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** Bytes of {"prompt":""} around the text. */
export const REQUEST_OVERHEAD_BYTES = '{"prompt":""}'.length;

/** UTF-8 bytes a code point takes inside a JSON string (JSON.stringify escaping). */
export function jsonUtf8Bytes(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2; // \" \\
  if (codePoint === 0x08 || codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0c || codePoint === 0x0d) return 2; // \b \t \n \f \r
  if (codePoint < 0x20) return 6; // \u00XX
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6; // lone surrogate → \uXXXX
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Size of the request body for `text`, exactly as the API client will send it. */
export function requestBodyBytes(text: string): number {
  return new TextEncoder().encode(JSON.stringify({ prompt: text })).length;
}

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;

/** [start, end) of every PEM block; no chunk boundary may fall strictly inside one. */
export function findPemBlocks(text: string): [number, number][] {
  return [...text.matchAll(PEM_BLOCK)].map((m) => [m.index, m.index + m[0].length]);
}

const isWhitespace = (char: string | undefined) => char !== undefined && /\s/.test(char);
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Length (UTF-16) of the code point starting at `i`. */
function codePointLength(text: string, i: number): number {
  return isHighSurrogate(text.charCodeAt(i)) && isLowSurrogate(text.charCodeAt(i + 1)) ? 2 : 1;
}

/** Break quality of ending a chunk at `end` (exclusive): 3 blank line, 2 line break, 1 whitespace, 0 none. */
function breakQuality(text: string, end: number): number {
  if (!isWhitespace(text[end - 1])) return 0;
  if (text[end - 1] !== '\n') return 1;
  // A blank line: this "\n" ends a line that holds only spaces/tabs.
  let i = end - 2;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r')) i--;
  return i >= 0 && text[i] === '\n' ? 3 : 2;
}

export function chunkText(text: string, options: ChunkOptions): Chunk[] {
  const pem = findPemBlocks(text);
  const insidePem = (offset: number) => pem.some(([s, e]) => s < offset && offset < e);
  const pemContaining = (offset: number) => pem.find(([s, e]) => s < offset && offset < e);
  const byteBudget = options.maxRequestBytes - REQUEST_OVERHEAD_BYTES;

  /** Largest end such that [start, end) fits both limits (at least one code point). */
  const windowEnd = (start: number): number => {
    let end = start;
    let codePoints = 0;
    let bytes = 0;
    while (end < text.length && codePoints < options.chunkSize) {
      const length = codePointLength(text, end);
      const cost = jsonUtf8Bytes(text.codePointAt(end) as number);
      if (bytes + cost > byteBudget && end > start) break;
      bytes += cost;
      codePoints++;
      end += length;
    }
    return end;
  };

  /** Best break in (start, limit], or -1. `protectPem`: no break inside a PEM block. */
  const findBreak = (start: number, limit: number, protectPem: boolean): number => {
    const half = start + Math.ceil((limit - start) / 2);
    let best = 0;
    let bestEnd = -1;
    let anyEnd = -1;
    for (let end = limit; end > start; end--) {
      const quality = breakQuality(text, end);
      if (quality === 0 || (protectPem && insidePem(end))) continue;
      if (end >= half) {
        if (quality > best) {
          best = quality;
          bestEnd = end;
          if (quality === 3) break;
        }
      } else {
        anyEnd = end; // first (= last in the text) break below the half
        break;
      }
    }
    if (bestEnd > start) return bestEnd;
    if (anyEnd > start) return anyEnd;
    return -1;
  };

  /** Where the chunk starting at `start` ends. */
  const chooseEnd = (start: number): number => {
    const limit = windowEnd(start);
    if (limit >= text.length) return text.length;
    const end = findBreak(start, limit, true);
    if (end > 0) return end;
    // A PEM block larger than the window: break at whitespace inside it rather than mid-token.
    const inPem = findBreak(start, limit, false);
    if (inPem > 0) return inPem;
    return limit; // an unbroken span longer than the window: cut by force
  };

  /** Where the next chunk starts, given the previous chunk [start, end). */
  const nextStart = (start: number, end: number): number => {
    // Step back chunkOverlap code points, but at most half of the chunk.
    let codePointsInChunk = 0;
    for (let i = start; i < end; i += codePointLength(text, i)) codePointsInChunk++;
    let steps = Math.min(options.chunkOverlap, Math.floor(codePointsInChunk / 2));
    let candidate = end;
    while (steps > 0 && candidate > start) {
      candidate -= isLowSurrogate(text.charCodeAt(candidate - 1)) && isHighSurrogate(text.charCodeAt(candidate - 2)) ? 2 : 1;
      steps--;
    }
    // Forward to the start of a word, and out of any PEM block.
    for (;;) {
      while (candidate < end && !isWhitespace(text[candidate - 1])) candidate++;
      if (candidate >= end) return end; // no room for overlap
      const block = pemContaining(candidate);
      if (!block) break;
      candidate = block[1];
    }
    // Always > start: we stepped back at most half of the chunk, then only forward.
    return candidate;
  };

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = chooseEnd(start);
    const chunk = text.slice(start, end);
    if (chunk.trim() !== '') chunks.push({ start, end, text: chunk });
    if (end >= text.length) break;
    start = nextStart(start, end);
  }
  return chunks;
}
