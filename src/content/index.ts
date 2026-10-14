// Content script, isolated world (DESIGN.md §3, docs/agents/content-script.md).
// Registered by the service worker for allow-listed sites (script-registry.ts).
// Only builds the real chrome.* dependencies; the wiring is in pipeline.ts.

import { SCAN_PORT_NAME } from '../shared/messages.ts';
import { createLogger } from '../shared/safe-logger.ts';
import { startContentScript } from './pipeline.ts';
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

startContentScript({ win: window, storage: chrome.storage.local, sender, dev: __DEV__, log });

log.debug('content script loaded');
