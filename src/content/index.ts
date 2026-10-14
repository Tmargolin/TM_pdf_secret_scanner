// Content script, isolated world (DESIGN.md §3, docs/agents/content-script.md).
// Registered by the service worker for allow-listed sites (script-registry.ts).
//
// Walking skeleton: files chosen in an <input type="file"> are sent to the
// offscreen document as one batch. Since 4.4 the MAIN-world hooks also hand
// every File over the bridge – logged only for now; 4.5 switches sending to
// them (PDF filter, batching by time) and removes the change listener.

import { LIMITS, SCAN_PORT_NAME } from '../shared/messages.ts';
import { createLogger } from '../shared/safe-logger.ts';
import { openBridge } from './bridge.ts';
import { toScanRequest } from './encode.ts';
import { createScanSender } from './scan-sender.ts';

const log = createLogger('content', { dev: __DEV__ });

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

async function sendFiles(files: File[]): Promise<void> {
  const batchId = crypto.randomUUID();
  const selected = files.slice(0, LIMITS.filesPerBatch);
  if (selected.length < files.length) log.warn('too many files in one batch', { sent: selected.length, total: files.length });
  try {
    const requests = await Promise.all(selected.map((file) => toScanRequest(file, batchId, crypto.randomUUID())));
    await sender.send({ batchId, requests });
  } catch (error) {
    log.error('files could not be sent for scanning', { error });
  }
}

// Capture phase on the document: runs even if the page stops the event.
document.addEventListener(
  'change',
  (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    const files = [...(input.files ?? [])];
    if (files.length > 0) void sendFiles(files);
  },
  true,
);

// Files obtained by the page, from the MAIN-world hooks (4.4: logged only).
openBridge(window, (file) => log.debug('file handed to the page', { bytes: file.size }));

log.debug('content script loaded');
