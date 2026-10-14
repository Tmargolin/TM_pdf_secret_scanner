// Offscreen document – owns all scan work (DESIGN.md §2, docs/agents/offscreen.md).
// Walking skeleton so far: settings handshake and receiving batches over the
// scan port. Notifications per batch: 2.9; extraction and scanning: steps 5–6.

import { isFromExtensionContext } from '../shared/messages.ts';
import { createLogger } from '../shared/safe-logger.ts';
import { createBatchReceiver } from './batch-receiver.ts';
import { createSettingsClient } from './settings-client.ts';

const log = createLogger('offscreen', { dev: __DEV__ });

const settings = createSettingsClient({
  requestSettings: () => chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }),
  dev: __DEV__,
  log,
});

const batches = createBatchReceiver({
  extensionId: chrome.runtime.id,
  log,
  async runBatch(batch) {
    await settings.ready(); // jobs wait for the settings handshake
    log.info('batch received', { files: batch.requests.length });
  },
});

chrome.runtime.onMessage.addListener((raw, sender) => {
  if (isFromExtensionContext(sender, chrome.runtime.id)) settings.accept(raw);
  return false; // never replies
});

chrome.runtime.onConnect.addListener((port) => batches.onConnect(port));

log.info('offscreen document loaded');
void settings.start();
