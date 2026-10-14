// Results of a batch, sent to the service worker as one SHOW_RESULT
// (DESIGN.md §2 flow 4, §4). Walking skeleton: files are not scanned yet, so
// every result says so honestly via the notification text; steps 5–6 replace
// placeholderResults with real extraction and scanning.

import type { ShowResult } from '../shared/messages.ts';
import type { ScanResult } from '../shared/types.ts';
import type { ReceivedBatch } from './batch-receiver.ts';

/** One result per file. Too-large files are the only outcome known already. */
export function placeholderResults(batch: ReceivedBatch): ScanResult[] {
  return batch.requests.map((request): ScanResult => {
    const base = { scanId: request.scanId, batchId: batch.batchId, fileName: request.fileName, findings: [] };
    return 'skipped' in request
      ? { ...base, status: 'error', errors: [{ code: 'FILE_TOO_LARGE' }] }
      : { ...base, status: 'clean', errors: [] };
  });
}

export function toShowResult(batch: ReceivedBatch, results: ScanResult[]): ShowResult {
  return { type: 'SHOW_RESULT', batchId: batch.batchId, origin: batch.origin, results };
}
