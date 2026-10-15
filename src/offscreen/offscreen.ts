// Offscreen document – owns all scan work (DESIGN.md §2, docs/agents/offscreen.md).
// Settings handshake, batches over the scan port, every file a job in the job
// registry (limits, queue cap, timeout), each job the scan pipeline
// (scan-job.ts: extraction → chunks → API → findings), one SHOW_RESULT per batch.

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createApiClient } from '../scanner/api-client.ts';
import { createApiLimiter } from '../scanner/api-limiter.ts';
import { DOCUMENT_OPTIONS } from '../scanner/extract.ts';
import { createChunkSizer } from '../scanner/splitter.ts';
import { isFromExtensionContext } from '../shared/messages.ts';
import { createLogger } from '../shared/safe-logger.ts';
import type { Settings } from '../shared/settings.ts';
import { createBatchReceiver } from './batch-receiver.ts';
import { createExtractor } from './extractor.ts';
import { createJobRegistry } from './jobs.ts';
import { outcomeCode, toShowResult } from './results.ts';
import { createScanJob } from './scan-job.ts';
import { createSettingsClient } from './settings-client.ts';

const log = createLogger('offscreen', { dev: __DEV__ });

const settings = createSettingsClient({
  requestSettings: () => chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }),
  dev: __DEV__,
  log,
});

// runBatch waits for the settings first, so current() is set when jobs run.
const currentSettings = (): Settings => {
  const current = settings.current();
  if (!current) throw new Error('settings not ready');
  return current;
};

// The pdf.js worker script is copied next to this page by build.ts (D37:
// legacy build). A module worker from our own origin – no eval, no remote code.
pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('offscreen/pdf.worker.mjs');

const extractor = createExtractor({
  pdfjs,
  // The worker logs at its own level, not the document's: keep it errors-only too.
  createWorker: () => new pdfjs.PDFWorker({ verbosity: DOCUMENT_OPTIONS.verbosity }),
  maxParallel: () => currentSettings().maxParallelExtractions,
});

// Shared by every job of every tab for the life of this document.
const runScanJob = createScanJob({
  extract: (bytes, signal) => extractor.extract(bytes, signal),
  api: createApiClient({ fetch: (input, init) => fetch(input, init), log }),
  limiter: createApiLimiter(() => currentSettings().maxConcurrency),
  sizer: createChunkSizer(),
  settings: currentSettings,
  log,
});

const jobs = createJobRegistry({ limits: currentSettings, runJob: runScanJob, log });

const batches = createBatchReceiver({
  extensionId: chrome.runtime.id,
  log,
  async runBatch(batch) {
    await settings.ready(); // jobs wait for the settings handshake
    log.info('batch received', { files: batch.requests.length });
    const results = await jobs.submitBatch(batch);
    // Dev builds: outcome per file as codes only (no names, no values).
    log.debug('batch finished', { outcomes: results.map(outcomeCode) });
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
