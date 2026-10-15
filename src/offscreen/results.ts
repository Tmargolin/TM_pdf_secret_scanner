// Results of a batch, sent to the service worker as one SHOW_RESULT
// (DESIGN.md §2 flow 4, §4). Findings are already masked (scan-job.ts).

import type { ShowResult } from '../shared/messages.ts';
import type { ScanResult } from '../shared/types.ts';
import type { ReceivedBatch } from './batch-receiver.ts';

/** Dev log: one short code per file – "clean", "secrets:2", "NOT_CONFIGURED", "secrets:1+TEXT_TRUNCATED" (no names, no values). */
export function outcomeCode(result: ScanResult): string {
  const codes = result.errors.map((e) => e.code);
  if (result.status === 'secrets') return [`secrets:${result.findings.length}`, ...codes].join('+');
  return codes.join('+') || result.status;
}

export function toShowResult(batch: ReceivedBatch, results: ScanResult[]): ShowResult {
  return { type: 'SHOW_RESULT', batchId: batch.batchId, origin: batch.origin, results };
}
