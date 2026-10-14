// Turns selected files into SCAN_REQUEST messages (docs/agents/protocol.md).
// Runtime messaging JSON-serialises payloads, so bytes travel as base64
// (DESIGN.md §2).

import { LIMITS, type ScanRequest } from '../shared/messages.ts';

/** Bytes per btoa() call: a multiple of 3, so the pieces join without padding in between. */
const CHUNK_BYTES = 3 * 8_192;

/** Base64 of the bytes, built in pieces to avoid one huge intermediate string. */
export function toBase64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
    const chunk = bytes.subarray(start, start + CHUNK_BYTES);
    pieces.push(btoa(String.fromCharCode(...chunk)));
  }
  return pieces.join('');
}

/**
 * The file as a SCAN_REQUEST. Files above `maxBytes` (the maxFileSizeMB
 * setting, never more than the protocol's hard limit) go without bytes, so the
 * batch's notification can still say the file was too large to check.
 */
export async function toScanRequest(
  file: File,
  batchId: string,
  scanId: string,
  maxBytes: number = LIMITS.fileBytes,
): Promise<ScanRequest> {
  const fileName = file.name.slice(0, LIMITS.fileNameChars);
  const base = { type: 'SCAN_REQUEST' as const, scanId, batchId, fileName, size: file.size };
  if (file.size > Math.min(maxBytes, LIMITS.fileBytes)) return { ...base, skipped: 'FILE_TOO_LARGE' };
  return { ...base, base64: toBase64(new Uint8Array(await file.arrayBuffer())) };
}
