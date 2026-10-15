// The work for one file – the whole scan pipeline (DESIGN.md §4,
// docs/agents/offscreen.md). Called by the job registry, which adds the
// limits, the timeout (signal) and the ids.
//
//   APP-ID empty?            → NOT_CONFIGURED (nothing extracted, nothing sent)
//   extract (limited, shared worker) → PDF_ENCRYPTED / PDF_INVALID / NO_TEXT_LAYER
//   join pages → truncate at maxTextChars (TEXT_TRUNCATED)
//   chunk at the session's effective chunk size
//   every chunk at once → scanWithSplitting → global API limiter → API client
//   aggregate (de-duplicate, pages, mask) → status
//
// The text, the chunks and the plain secrets live only inside this function
// call; what it returns holds masked values only. Logs carry counts only.

import type { ApiClient, ApiSettings } from '../scanner/api-client.ts';
import type { ApiLimiter } from '../scanner/api-limiter.ts';
import { aggregateFindings, scanStatus, uniqueErrors } from '../scanner/aggregate.ts';
import { chunkText, joinPages, truncateText } from '../scanner/chunker.ts';
import type { ExtractionOutcome } from '../scanner/extract.ts';
import { scanWithSplitting, type ChunkSizer } from '../scanner/splitter.ts';
import type { Logger } from '../shared/safe-logger.ts';
import type { Settings } from '../shared/settings.ts';
import type { ScanError } from '../shared/types.ts';
import type { JobOutcome, RunJob } from './jobs.ts';

export interface ScanJobDeps {
  /** PDF bytes → text per page (extractor.extract: limited, shared worker). */
  extract(bytes: Uint8Array, signal: AbortSignal): Promise<ExtractionOutcome>;
  api: ApiClient;
  /** The one limiter shared by all jobs (maxConcurrency, round-robin). */
  limiter: ApiLimiter;
  /** The session's effective chunk size (shrinks after cut-short chunks). */
  sizer: ChunkSizer;
  /** Current settings – read once per job, so a job runs with one consistent set. */
  settings(): Settings;
  log: Logger;
  now?: () => number;
}

const failed = (code: ScanError['code']): JobOutcome => ({ status: 'error', findings: [], errors: [{ code }] });

export function createScanJob(deps: ScanJobDeps): RunJob {
  const now = deps.now ?? (() => Date.now());
  return async (job, bytes, signal) => {
    const started = now();
    const settings = deps.settings();
    if (settings.appId === '') return failed('NOT_CONFIGURED');

    const extracted = await deps.extract(bytes, signal);
    if (!extracted.ok) return failed(extracted.code);

    const paged = joinPages(extracted.pages);
    const kept = truncateText(paged.text, settings.maxTextChars);
    const chunkOptions = { chunkOverlap: settings.chunkOverlap, maxRequestBytes: settings.maxRequestBytes };
    const chunks = chunkText(kept.text, { ...chunkOptions, chunkSize: deps.sizer.effective(settings.chunkSize) });

    const api: ApiSettings = {
      apiUrl: settings.apiUrl,
      appId: settings.appId,
      requestTimeoutMs: settings.requestTimeoutMs,
      retries: settings.retries,
    };
    const scan = (text: string) => deps.limiter.run(job.scanId, () => deps.api.scanChunk(text, api, signal), signal);
    // All chunks at once: the limiter decides how many calls really run (and whose turn it is).
    const scanned = await Promise.all(
      chunks.map((chunk) => scanWithSplitting(chunk, { scan, sizer: deps.sizer, options: chunkOptions, log: deps.log })),
    );

    const errors = uniqueErrors([
      ...scanned.flatMap((s) => s.errors),
      ...(kept.truncated ? [{ code: 'TEXT_TRUNCATED' as const }] : []),
    ]);
    const findings = aggregateFindings(
      scanned.flatMap((s) => s.secrets),
      paged,
    );
    const scannedChunks = scanned.reduce((sum, s) => sum + s.scannedChunks, 0);
    const failedChunks = scanned.reduce((sum, s) => sum + s.failedChunks, 0);
    const stats = {
      pages: extracted.pages.length,
      chunks: scannedChunks + failedChunks,
      failedChunks,
      textChars: kept.textChars,
      scannedChars: kept.scannedChars,
      truncated: kept.truncated,
      ms: Math.max(0, Math.round(now() - started)),
    };
    deps.log.info('file scanned', {
      pageCount: stats.pages, // "pages" is a field name the safe logger always redacts (it could hold page text)
      chunks: stats.chunks,
      failedChunks,
      calls: scanned.reduce((sum, s) => sum + s.calls, 0),
      findings: findings.length,
      ms: stats.ms,
    });
    return { status: scanStatus(findings.length, errors), findings, errors, stats };
  };
}
