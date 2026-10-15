// Bounded automatic shrinking (DESIGN.md §4.2, docs/agents/scanner.md).
// The API never says "too large" – it silently scans less. So after every
// call we check:
//
//   cut short = HTTP 413, or Token Limitation.characters < code points sent
//
// A cut-short chunk is split in half at the best boundary (chunkText with
// half the size, so the same rules apply: whitespace, PEM blocks, overlap)
// and both halves are scanned. Secrets the API did report for the cut-short
// chunk are kept – they are real, only the rest was unchecked.
//
//   - The session's effective chunk size shrinks to the half, so later chunks
//     don't fail the same way. It only ever shrinks, never above the
//     configured chunkSize, and resets when chunkSize changes (or the
//     offscreen document restarts – the sizer lives there).
//   - Floor MIN_CHUNK_CHARS: a chunk of that size or less that is still cut
//     short fails with CHUNK_TOO_LARGE (a failed chunk).
//   - So the depth is bounded: ≤ log2(chunkSize / 500) levels (≤ 7 at 50,000).
//     Every extra call counts against the job's jobTimeoutMs.

import type { Logger } from '../shared/safe-logger.ts';
import type { ScanError } from '../shared/types.ts';
import type { ApiCallOutcome } from './api-client.ts';
import { chunkText, type Chunk, type ChunkOptions } from './chunker.ts';
import type { RawFinding } from './parse.ts';

export const MIN_CHUNK_CHARS = 500;

/** The session's chunk size: the configured one, or smaller after a cut-short chunk. */
export interface ChunkSizer {
  /** The size to chunk with now; resets the shrinking when `configured` changed. */
  effective(configured: number): number;
  /** Never grows; never below MIN_CHUNK_CHARS. */
  shrink(to: number): void;
}

export function createChunkSizer(): ChunkSizer {
  let configured: number | null = null;
  let size = Number.POSITIVE_INFINITY;
  return {
    effective(current) {
      if (configured !== null && current !== configured) size = Number.POSITIVE_INFINITY; // chunkSize changed: start over
      configured = current;
      return Math.min(size, current);
    },
    shrink(to) {
      size = Math.max(MIN_CHUNK_CHARS, Math.min(size, to));
    },
  };
}

export interface SplitScanDeps {
  /** One API call for one chunk of text (api-client scanChunk, later through the limiter). */
  scan(text: string): Promise<ApiCallOutcome>;
  sizer: ChunkSizer;
  /** chunkOverlap and maxRequestBytes for the halves (chunkSize is set per split). */
  options: Pick<ChunkOptions, 'chunkOverlap' | 'maxRequestBytes'>;
  log: Logger;
}

export interface SplitScanResult {
  secrets: RawFinding[];
  /** API calls that returned a verdict for all the text they were sent. */
  scannedChunks: number;
  /** Pieces whose text was not (fully) checked. */
  failedChunks: number;
  errors: ScanError[];
  /** API calls made, splits included. */
  calls: number;
}

/** Code points in `text` – a string's iterator yields one per code point (an emoji is one, not two). */
const codePoints = (text: string) => {
  let count = 0;
  for (const _ of text) count++;
  return count;
};

/**
 * Scans one chunk; splits it (again and again, bounded) while the API cuts it
 * short. Rejects only if `deps.scan` rejects (the job was aborted).
 */
export async function scanWithSplitting(chunk: Chunk, deps: SplitScanDeps): Promise<SplitScanResult> {
  const result: SplitScanResult = { secrets: [], scannedChunks: 0, failedChunks: 0, errors: [], calls: 0 };
  const pending: Chunk[] = [chunk];
  while (pending.length > 0) {
    const piece = pending.shift() as Chunk;
    const sent = codePoints(piece.text);
    const outcome = await deps.scan(piece.text);
    result.calls++;

    if (outcome.kind === 'error') {
      result.failedChunks++;
      result.errors.push(outcome.detail === undefined ? { code: outcome.code } : { code: outcome.code, detail: outcome.detail });
      continue;
    }
    if (outcome.kind === 'ok') {
      result.secrets.push(...outcome.secrets); // real even if the chunk was cut short
      const cutShort = outcome.characters !== null && outcome.characters < sent;
      if (!cutShort) {
        result.scannedChunks++;
        continue;
      }
      deps.log.warn('chunk cut short by the API', { sent, characters: outcome.characters });
    } else {
      deps.log.warn('chunk too large for the API (413)', { sent });
    }

    if (sent <= MIN_CHUNK_CHARS) {
      result.failedChunks++;
      result.errors.push({ code: 'CHUNK_TOO_LARGE' });
      continue;
    }
    const half = Math.max(MIN_CHUNK_CHARS, Math.ceil(sent / 2));
    deps.sizer.shrink(half);
    const halves = chunkText(piece.text, { ...deps.options, chunkSize: half }).map((c) => ({
      start: piece.start + c.start,
      end: piece.start + c.end,
      text: c.text,
    }));
    pending.unshift(...halves);
  }
  return result;
}
