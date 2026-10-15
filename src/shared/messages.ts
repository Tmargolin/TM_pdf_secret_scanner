// Messages between the extension's contexts (catalogue: docs/agents/protocol.md).
// Every receiver must run the matching parse* function on incoming data and
// check the sender before acting: data from other contexts is untrusted.

import { normalizeSettings, type Settings } from './settings.ts';
import { ERROR_CODES, type ErrorCode, type MaskedFinding, type ScanError, type ScanResult, type ScanStats } from './types.ts';

// ---------- constants ----------

/** Name of the port a content script opens to the offscreen document (one per batch). */
export const SCAN_PORT_NAME = 'scan-batch';

/** Marker on the window message that hands the MessagePort to the MAIN-world hooks. */
export const HANDOFF_MARKER = '__pss_handoff_v1__';

/** Upper bounds for untrusted fields. */
export const LIMITS = {
  fileNameChars: 1_024,
  /** 45 MB: largest allowed maxFileSizeMB (settings.ts). */
  fileBytes: 45 * 1024 * 1024,
  filesPerBatch: 100,
  findingsPerFile: 1_000,
  detailChars: 200,
} as const;

// ---------- message types ----------

/** content script → offscreen document, over the scan port: one per file. */
export type ScanRequest =
  | { type: 'SCAN_REQUEST'; scanId: string; batchId: string; fileName: string; size: number; base64: string }
  | { type: 'SCAN_REQUEST'; scanId: string; batchId: string; fileName: string; size: number; skipped: 'FILE_TOO_LARGE' };

/** content script → offscreen document, over the scan port: all files of the batch were sent. */
export interface BatchEnd {
  type: 'BATCH_END';
  batchId: string;
  fileCount: number;
}

export type ScanPortMessage = ScanRequest | BatchEnd;

/** offscreen document → content script, over the scan port: every file of the batch arrived (D35). */
export interface BatchAccepted {
  type: 'BATCH_ACCEPTED';
  batchId: string;
}

/** offscreen document → content script, over the scan port: every job ended; the port closes next (D35). */
export interface BatchDone {
  type: 'BATCH_DONE';
  batchId: string;
}

/**
 * offscreen document → content script, over the scan port: the document is
 * closing (idle, D42); no file was accepted. The port closes next; the content
 * script asks for a new document and resends.
 */
export interface BatchRejected {
  type: 'BATCH_REJECTED';
  batchId: string;
  reason: 'closing';
}

/** Replies on the scan port. They carry no results: results never go back to the page. */
export type ScanPortReply = BatchAccepted | BatchDone | BatchRejected;

/** offscreen document → service worker, once it has loaded. Reply: SettingsReply. */
export interface OffscreenReady {
  type: 'OFFSCREEN_READY';
}

/** service worker → offscreen document: reply to OFFSCREEN_READY, and on every change. */
export interface SettingsMessage {
  type: 'SETTINGS_UPDATED';
  settings: Settings;
}

/** offscreen document → service worker, once per batch when all its files are done. */
export interface ShowResult {
  type: 'SHOW_RESULT';
  batchId: string;
  /** Origin of the page, taken from port.sender – never from the page itself. */
  origin: string;
  results: ScanResult[];
}

/** content script → service worker: no offscreen document answered; create it. Reply: { ok }. */
export interface EnsureOffscreen {
  type: 'ENSURE_OFFSCREEN';
}

/** offscreen document → service worker: idle for offscreenIdleTimeoutSec, now rejecting new batches – close me (D42). */
export interface OffscreenIdle {
  type: 'OFFSCREEN_IDLE';
}

/** content script → service worker: the scan port dropped before the batch finished. */
export interface ScanInterrupted {
  type: 'SCAN_INTERRUPTED';
  batchId: string;
  fileNames: string[];
}

export type RuntimeMessage = OffscreenReady | OffscreenIdle | SettingsMessage | ShowResult | EnsureOffscreen | ScanInterrupted;

// ---------- small checks ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isIntIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isFileName = (v: unknown): v is string => isText(v, LIMITS.fileNameChars);
const isErrorCode = (v: unknown): v is ErrorCode => typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);

/** How a fully masked value (secret shorter than 12 characters) is shown (DESIGN.md §8). */
export const FULLY_MASKED = '••••••';
/** Masked form of longer secrets: first 4 characters + "…" + last 2 (DESIGN.md §8). */
const PARTLY_MASKED = /^[^…]{4}…[^…]{2}$/u;

/** True only for the two masked forms – an unmasked secret can never pass. */
export function isMaskedValue(v: unknown): v is string {
  return typeof v === 'string' && (v === FULLY_MASKED || PARTLY_MASKED.test(v));
}

/** Number of bytes a padded base64 string decodes to, or -1 if its length is not a multiple of 4. */
export function base64DecodedLength(base64: string): number {
  if (base64.length % 4 !== 0) return -1;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

// ---------- parsers (return a typed message, or null if invalid) ----------

/** Messages arriving on the scan port (offscreen document side). */
export function parseScanPortMessage(data: unknown): ScanPortMessage | null {
  if (!isRecord(data)) return null;

  if (data['type'] === 'BATCH_END') {
    if (!isId(data['batchId']) || !isIntIn(data['fileCount'], 1, LIMITS.filesPerBatch)) return null;
    return { type: 'BATCH_END', batchId: data['batchId'], fileCount: data['fileCount'] };
  }

  if (data['type'] !== 'SCAN_REQUEST') return null;
  const { scanId, batchId, fileName, size } = data;
  if (!isId(scanId) || !isId(batchId) || !isFileName(fileName) || !isIntIn(size, 0, Number.MAX_SAFE_INTEGER)) return null;

  if (data['skipped'] === 'FILE_TOO_LARGE' && !('base64' in data)) {
    return { type: 'SCAN_REQUEST', scanId, batchId, fileName, size, skipped: 'FILE_TOO_LARGE' };
  }
  const base64 = data['base64'];
  if ('skipped' in data || typeof base64 !== 'string') return null;
  if (size > LIMITS.fileBytes || base64DecodedLength(base64) !== size || !BASE64.test(base64)) return null;
  return { type: 'SCAN_REQUEST', scanId, batchId, fileName, size, base64 };
}

/** Replies arriving on the scan port (content script side). */
export function parseScanPortReply(data: unknown): ScanPortReply | null {
  if (!isRecord(data) || !isId(data['batchId'])) return null;
  if (data['type'] === 'BATCH_ACCEPTED') return { type: 'BATCH_ACCEPTED', batchId: data['batchId'] };
  if (data['type'] === 'BATCH_DONE') return { type: 'BATCH_DONE', batchId: data['batchId'] };
  if (data['type'] === 'BATCH_REJECTED' && data['reason'] === 'closing') {
    return { type: 'BATCH_REJECTED', batchId: data['batchId'], reason: 'closing' };
  }
  return null;
}

function parseFinding(v: unknown): MaskedFinding | null {
  if (!isRecord(v)) return null;
  const { entityType, category, masked, pages } = v;
  if (!isText(entityType, 100) || !isText(category, 100) || !isMaskedValue(masked)) return null;
  if (!Array.isArray(pages) || !pages.every((p) => isIntIn(p, 1, 1_000_000))) return null;
  return { entityType, category, masked, pages: [...pages] };
}

function parseError(v: unknown): ScanError | null {
  if (!isRecord(v) || !isErrorCode(v['code'])) return null;
  if (v['detail'] === undefined) return { code: v['code'] };
  return isText(v['detail'], LIMITS.detailChars) ? { code: v['code'], detail: v['detail'] } : null;
}

function parseStats(v: unknown): ScanStats | null {
  if (!isRecord(v)) return null;
  const n = (k: string) => isIntIn(v[k], 0, Number.MAX_SAFE_INTEGER);
  if (!['pages', 'chunks', 'failedChunks', 'textChars', 'scannedChars', 'ms'].every(n)) return null;
  if (typeof v['truncated'] !== 'boolean') return null;
  return {
    pages: v['pages'] as number,
    chunks: v['chunks'] as number,
    failedChunks: v['failedChunks'] as number,
    textChars: v['textChars'] as number,
    scannedChars: v['scannedChars'] as number,
    truncated: v['truncated'],
    ms: v['ms'] as number,
  };
}

function parseResult(v: unknown): ScanResult | null {
  if (!isRecord(v)) return null;
  const { scanId, batchId, fileName, status, findings, errors } = v;
  if (!isId(scanId) || !isId(batchId) || !isFileName(fileName)) return null;
  if (status !== 'clean' && status !== 'secrets' && status !== 'error') return null;
  if (!Array.isArray(findings) || findings.length > LIMITS.findingsPerFile || !Array.isArray(errors)) return null;
  const parsedFindings = findings.map(parseFinding);
  const parsedErrors = errors.map(parseError);
  if (parsedFindings.includes(null) || parsedErrors.includes(null)) return null;
  const result: ScanResult = {
    scanId,
    batchId,
    fileName,
    status,
    findings: parsedFindings as MaskedFinding[],
    errors: parsedErrors as ScanError[],
  };
  if (v['stats'] !== undefined) {
    const stats = parseStats(v['stats']);
    if (stats === null) return null;
    result.stats = stats;
  }
  return result;
}

/**
 * Messages sent with chrome.runtime.sendMessage.
 * `dev` is needed to validate settings the same way the settings model does.
 */
export function parseRuntimeMessage(data: unknown, dev: boolean): RuntimeMessage | null {
  if (!isRecord(data)) return null;
  switch (data['type']) {
    case 'OFFSCREEN_READY':
      return { type: 'OFFSCREEN_READY' };
    case 'OFFSCREEN_IDLE':
      return { type: 'OFFSCREEN_IDLE' };
    case 'ENSURE_OFFSCREEN':
      return { type: 'ENSURE_OFFSCREEN' };
    case 'SETTINGS_UPDATED': {
      if (!isRecord(data['settings'])) return null;
      // Normalising guarantees a complete, valid Settings object.
      return { type: 'SETTINGS_UPDATED', settings: normalizeSettings(data['settings'], dev) };
    }
    case 'SCAN_INTERRUPTED': {
      const { batchId, fileNames } = data;
      if (!isId(batchId) || !Array.isArray(fileNames)) return null;
      if (fileNames.length === 0 || fileNames.length > LIMITS.filesPerBatch || !fileNames.every(isFileName)) return null;
      return { type: 'SCAN_INTERRUPTED', batchId, fileNames: [...fileNames] };
    }
    case 'SHOW_RESULT': {
      const { batchId, origin, results } = data;
      if (!isId(batchId) || !isText(origin, 512) || !Array.isArray(results)) return null;
      if (results.length === 0 || results.length > LIMITS.filesPerBatch) return null;
      const parsed = results.map(parseResult);
      if (parsed.includes(null) || parsed.some((r) => r?.batchId !== batchId)) return null;
      return { type: 'SHOW_RESULT', batchId, origin, results: parsed as ScanResult[] };
    }
    default:
      return null;
  }
}

/** The window message carrying the MessagePort from the content script to the MAIN-world hooks. */
export function isHandoffPortMessage(data: unknown, ports: readonly MessagePort[]): boolean {
  return isRecord(data) && data['marker'] === HANDOFF_MARKER && ports.length === 1;
}

// ---------- sender checks ----------

/** The parts of chrome.runtime.MessageSender that the checks use. */
export interface SenderInfo {
  id?: string | undefined;
  url?: string | undefined;
  tab?: unknown;
}

/** Sent by one of our own content scripts (from a tab, by this extension). */
export function isFromContentScript(sender: SenderInfo, extensionId: string): boolean {
  return sender.id === extensionId && sender.tab !== undefined;
}

/**
 * Sent by one of our own extension contexts that is not in a tab (service
 * worker or offscreen document). Web pages cannot message us at all (no
 * externally_connectable), and content scripts always have a tab.
 */
export function isFromExtensionContext(sender: SenderInfo, extensionId: string): boolean {
  return sender.id === extensionId && sender.tab === undefined;
}

/** Sent by our offscreen document (no tab, exact page URL). */
export function isFromOffscreen(sender: SenderInfo, extensionId: string, offscreenUrl: string): boolean {
  return sender.id === extensionId && sender.tab === undefined && sender.url === offscreenUrl;
}
