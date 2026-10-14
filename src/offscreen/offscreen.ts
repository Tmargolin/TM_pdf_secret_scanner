// Offscreen document – owns all scan work (DESIGN.md §2, docs/agents/offscreen.md).
// So far: settings handshake, batches over the scan port, every file a job in
// the job registry (limits, queue cap, timeout), one SHOW_RESULT per batch.
// The work per job is still a placeholder: extraction 5.4, scanning step 6.

import { isFromExtensionContext } from '../shared/messages.ts';
import { createLogger } from '../shared/safe-logger.ts';
import { createBatchReceiver } from './batch-receiver.ts';
import { createJobRegistry } from './jobs.ts';
import { placeholderOutcome, toShowResult } from './results.ts';
import { createSettingsClient } from './settings-client.ts';

const log = createLogger('offscreen', { dev: __DEV__ });

const settings = createSettingsClient({
  requestSettings: () => chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }),
  dev: __DEV__,
  log,
});

const jobs = createJobRegistry({
  // runBatch waits for the settings first, so current() is set when jobs run.
  limits: () => {
    const current = settings.current();
    if (!current) throw new Error('settings not ready');
    return current;
  },
  runJob: async () => placeholderOutcome(),
  log,
});

const batches = createBatchReceiver({
  extensionId: chrome.runtime.id,
  log,
  async runBatch(batch) {
    await settings.ready(); // jobs wait for the settings handshake
    log.info('batch received', { files: batch.requests.length });
    const results = await jobs.submitBatch(batch);
    try {
      // Wakes the service worker if it was stopped; it shows the notification.
      await chrome.runtime.sendMessage(toShowResult(batch, results));
    } catch {
      log.warn('result not delivered to the service worker');
    }
  },
});

chrome.runtime.onMessage.addListener((raw, sender) => {
  if (isFromExtensionContext(sender, chrome.runtime.id)) settings.accept(raw);
  return false; // never replies
});

chrome.runtime.onConnect.addListener((port) => batches.onConnect(port));

log.info('offscreen document loaded');
void settings.start();
