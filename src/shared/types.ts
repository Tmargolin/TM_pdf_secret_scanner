// Result types shared by the offscreen document (producer) and the service
// worker (notifications). DESIGN.md §4 (result model).

export const ERROR_CODES = [
  'NOT_CONFIGURED',
  'FILE_TOO_LARGE',
  'PDF_ENCRYPTED',
  'PDF_INVALID',
  'NO_TEXT_LAYER',
  'API_UNREACHABLE',
  'API_TIMEOUT',
  'API_HTTP_ERROR',
  'API_BAD_RESPONSE',
  'API_UNAUTHORIZED',
  'SCAN_INTERRUPTED',
  'SCAN_TIMEOUT',
  'TEXT_TRUNCATED',
  'CHUNK_TOO_LARGE',
  'QUEUE_FULL',
] as const;

/** Why (part of) a file could not be scanned. */
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ScanStatus = 'clean' | 'secrets' | 'error';

/** A secret found in a file – only ever in masked form outside the offscreen document. */
export interface MaskedFinding {
  /** e.g. "AWS credentials" */
  entityType: string;
  /** e.g. "Access Tokens" */
  category: string;
  /** e.g. "AKIA…B1" (first 4 + last 2) */
  masked: string;
  /** Page numbers (1-based); empty if the text could not be located. */
  pages: number[];
}

export interface ScanError {
  code: ErrorCode;
  /** Short, non-sensitive detail, e.g. an HTTP status ("503"). */
  detail?: string;
}

export interface ScanStats {
  pages: number;
  chunks: number;
  failedChunks: number;
  textChars: number;
  scannedChars: number;
  truncated: boolean;
  ms: number;
}

/** Outcome for one file. */
export interface ScanResult {
  scanId: string;
  batchId: string;
  fileName: string;
  status: ScanStatus;
  findings: MaskedFinding[];
  errors: ScanError[];
  /** Absent when the file was never scanned (e.g. too large, queue full). */
  stats?: ScanStats;
}
