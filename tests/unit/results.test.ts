import { describe, expect, it } from 'vitest';
import type { ReceivedBatch } from '../../src/offscreen/batch-receiver.ts';
import { errorResult } from '../../src/offscreen/jobs.ts';
import { toShowResult } from '../../src/offscreen/results.ts';
import type { ScanResult } from '../../src/shared/types.ts';
import { parseRuntimeMessage } from '../../src/shared/messages.ts';

const BATCH_ID = '6a2b3c4d-5555-4666-8777-988899990000';
const scanId = (n: number) => `5f1c2a3e-1111-4222-8333-94445555666${n}`;
const batch: ReceivedBatch = {
  batchId: BATCH_ID,
  origin: 'https://mail.google.com',
  tabId: 7,
  frameId: 0,
  requests: [
    { type: 'SCAN_REQUEST', scanId: scanId(1), batchId: BATCH_ID, fileName: 'a.pdf', size: 3, base64: 'YWJj' },
    { type: 'SCAN_REQUEST', scanId: scanId(2), batchId: BATCH_ID, fileName: 'big.pdf', size: 99_000_000, skipped: 'FILE_TOO_LARGE' },
  ],
};

/** Results as the job registry produces them: a scanned file and a too-large one. */
const results: ScanResult[] = [
  { scanId: scanId(1), batchId: BATCH_ID, fileName: 'a.pdf', status: 'clean', findings: [], errors: [] },
  errorResult({ scanId: scanId(2), batchId: BATCH_ID, fileName: 'big.pdf' }, 'FILE_TOO_LARGE'),
];

describe('toShowResult', () => {
  it('builds a SHOW_RESULT the service worker accepts, with the origin from the port', () => {
    const message = toShowResult(batch, results);
    expect(message).toMatchObject({ type: 'SHOW_RESULT', batchId: BATCH_ID, origin: 'https://mail.google.com' });
    expect(parseRuntimeMessage(JSON.parse(JSON.stringify(message)), true)).toEqual(message);
  });

  it('carries no file bytes', () => {
    expect(JSON.stringify(toShowResult(batch, results))).not.toContain('YWJj');
  });
});
