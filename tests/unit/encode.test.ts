import { describe, expect, it } from 'vitest';
import { toBase64, toScanRequest } from '../../src/content/encode.ts';
import { LIMITS, parseScanPortMessage } from '../../src/shared/messages.ts';

const SCAN_ID = '5f1c2a3e-1111-4222-8333-944455556666';
const BATCH_ID = '6a2b3c4d-5555-4666-8777-988899990000';

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);

describe('toBase64', () => {
  // 24,576 bytes is one internal piece: check around the piece boundaries.
  for (const n of [0, 1, 2, 3, 4, 24_575, 24_576, 24_577, 49_152, 100_003]) {
    it(`matches Node's encoder for ${n} bytes`, () => {
      expect(toBase64(bytes(n))).toBe(Buffer.from(bytes(n)).toString('base64'));
    });
  }
});

describe('toScanRequest', () => {
  it('carries the bytes as base64 and passes the offscreen validator', async () => {
    const file = new File([bytes(1_000)], 'report.pdf');
    const request = await toScanRequest(file, BATCH_ID, SCAN_ID);
    expect(request).toEqual({
      type: 'SCAN_REQUEST',
      scanId: SCAN_ID,
      batchId: BATCH_ID,
      fileName: 'report.pdf',
      size: 1_000,
      base64: Buffer.from(bytes(1_000)).toString('base64'),
    });
    expect(parseScanPortMessage(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  it('handles an empty file', async () => {
    const request = await toScanRequest(new File([], 'empty.pdf'), BATCH_ID, SCAN_ID);
    expect(request).toMatchObject({ size: 0, base64: '' });
    expect(parseScanPortMessage(request)).not.toBeNull();
  });

  it('shortens very long file names to the protocol limit', async () => {
    const request = await toScanRequest(new File(['x'], 'a'.repeat(5_000)), BATCH_ID, SCAN_ID);
    expect(request.fileName).toHaveLength(LIMITS.fileNameChars);
    expect(parseScanPortMessage(request)).not.toBeNull();
  });

  it('sends files above the hard limit without reading their bytes', async () => {
    let read = false;
    const huge = {
      name: 'huge.pdf',
      size: LIMITS.fileBytes + 1,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    } as unknown as File;
    const request = await toScanRequest(huge, BATCH_ID, SCAN_ID);
    expect(request).toEqual({
      type: 'SCAN_REQUEST',
      scanId: SCAN_ID,
      batchId: BATCH_ID,
      fileName: 'huge.pdf',
      size: LIMITS.fileBytes + 1,
      skipped: 'FILE_TOO_LARGE',
    });
    expect(read).toBe(false);
    expect(parseScanPortMessage(request)).toEqual(request);
  });
});
