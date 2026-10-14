import { describe, expect, it } from 'vitest';
import type { ReceivedBatch } from '../../src/offscreen/batch-receiver.ts';
import { placeholderResults, toShowResult } from '../../src/offscreen/results.ts';
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

describe('placeholderResults (step 2)', () => {
  it('one result per file, in order; too-large files as FILE_TOO_LARGE errors', () => {
    expect(placeholderResults(batch)).toEqual([
      { scanId: scanId(1), batchId: BATCH_ID, fileName: 'a.pdf', status: 'clean', findings: [], errors: [] },
      { scanId: scanId(2), batchId: BATCH_ID, fileName: 'big.pdf', status: 'error', findings: [], errors: [{ code: 'FILE_TOO_LARGE' }] },
    ]);
  });

  it('carries no file bytes', () => {
    expect(JSON.stringify(placeholderResults(batch))).not.toContain('YWJj');
  });
});

describe('toShowResult', () => {
  it('builds a SHOW_RESULT the service worker accepts, with the origin from the port', () => {
    const message = toShowResult(batch, placeholderResults(batch));
    expect(message).toMatchObject({ type: 'SHOW_RESULT', batchId: BATCH_ID, origin: 'https://mail.google.com' });
    expect(parseRuntimeMessage(JSON.parse(JSON.stringify(message)), true)).toEqual(message);
  });
});
