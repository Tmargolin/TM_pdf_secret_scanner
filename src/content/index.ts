// Content script, isolated world (DESIGN.md §3, docs/agents/content-script.md).
// Registered by the service worker for allow-listed sites (script-registry.ts).
//
// Files the page obtains reach us from the MAIN-world hooks over the bridge:
//   bridge → batcher (300 ms window, ≤ 100 files) → PDF check (%PDF-) →
//   size check (maxFileSizeMB) → encode → scan port to the offscreen document.

import { LIMITS, SCAN_PORT_NAME } from '../shared/messages.ts';
import { createLogger } from '../shared/safe-logger.ts';
import { loadSettings } from '../shared/settings.ts';
import { BATCH_WINDOW_MS, createBatcher } from './batcher.ts';
import { openBridge } from './bridge.ts';
import { toScanRequest } from './encode.ts';
import { keepPdfs } from './pdf-filter.ts';
import { createScanSender } from './scan-sender.ts';

const log = createLogger('content', { dev: __DEV__ });
const MB = 1024 * 1024;

const sender = createScanSender({
  connect: () => chrome.runtime.connect({ name: SCAN_PORT_NAME }),
  async ensureOffscreen() {
    try {
      const reply: unknown = await chrome.runtime.sendMessage({ type: 'ENSURE_OFFSCREEN' });
      return typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === true;
    } catch {
      return false;
    }
  },
  async reportInterrupted(batchId, fileNames) {
    await chrome.runtime.sendMessage({ type: 'SCAN_INTERRUPTED', batchId, fileNames });
  },
  log,
});

/** maxFileSizeMB in bytes, read fresh per batch. Only this number is kept – never the APP-ID. */
async function maxFileBytes(): Promise<number> {
  try {
    return (await loadSettings(chrome.storage.local, __DEV__)).maxFileSizeMB * MB;
  } catch {
    return LIMITS.fileBytes;
  }
}

async function sendBatch(files: File[]): Promise<void> {
  try {
    const pdfs = await keepPdfs(files);
    log.debug('batch from the page', { files: files.length, pdfs: pdfs.length });
    if (pdfs.length === 0) return;
    const batchId = crypto.randomUUID();
    const maxBytes = await maxFileBytes();
    const requests = await Promise.all(pdfs.map((file) => toScanRequest(file, batchId, crypto.randomUUID(), maxBytes)));
    await sender.send({ batchId, requests });
  } catch (error) {
    log.error('files could not be sent for scanning', { error });
  }
}

const batcher = createBatcher<File>({
  windowMs: BATCH_WINDOW_MS,
  maxItems: LIMITS.filesPerBatch,
  onBatch: (files) => void sendBatch(files),
});

openBridge(window, (file) => batcher.add(file));

log.debug('content script loaded');
