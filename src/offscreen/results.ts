// Results of a batch, sent to the service worker as one SHOW_RESULT
// (DESIGN.md §2 flow 4, §4). Until scanning exists (step 6), a file whose text
// was extracted gets placeholderOutcome; the notification text says honestly
// that nothing was checked.

import type { ExtractionOutcome } from '../scanner/extract.ts';
import type { ShowResult } from '../shared/messages.ts';
import type { ScanResult } from '../shared/types.ts';
import type { ReceivedBatch } from './batch-receiver.ts';
import type { JobOutcome } from './jobs.ts';

/** Placeholder for the work of one job until extraction (5.4) and scanning (step 6). */
export function placeholderOutcome(): JobOutcome {
  return { status: 'clean', findings: [], errors: [] };
}

/** A job's outcome after extraction: the PDF error, or (until step 6) the placeholder. The text is dropped here. */
export function extractionOutcome(extracted: ExtractionOutcome): JobOutcome {
  return extracted.ok ? placeholderOutcome() : { status: 'error', findings: [], errors: [{ code: extracted.code }] };
}

export function toShowResult(batch: ReceivedBatch, results: ScanResult[]): ShowResult {
  return { type: 'SHOW_RESULT', batchId: batch.batchId, origin: batch.origin, results };
}
