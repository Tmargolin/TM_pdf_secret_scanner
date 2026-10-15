// Sends one batch to the offscreen document over its own port and decides,
// from the replies, whether to retry or report an interruption (D35,
// DESIGN.md §2 flows 3 and 5, docs/agents/content-script.md):
//   port closes before BATCH_ACCEPTED, or BATCH_REJECTED (document closing, D42)
//     → files never arrived → ENSURE_OFFSCREEN, pause, resend – up to 3 times (D43)
//   still not accepted after the last resend, ENSURE_OFFSCREEN fails, or the port
//     closes after BATCH_ACCEPTED but before BATCH_DONE → SCAN_INTERRUPTED
//   BATCH_DONE → finished (the notification comes from the service worker)

import { parseScanPortReply, type BatchEnd, type ScanRequest } from '../shared/messages.ts';
import type { Logger } from '../shared/safe-logger.ts';
import type { ScanPort } from '../shared/scan-port.ts';

export interface OutgoingBatch {
  batchId: string;
  requests: ScanRequest[];
}

/**
 * Pause before each resend (D43). The first resend follows a missing document
 * (lazy creation) and needs none; the later ones give a closing document time
 * to be closed, so the next ENSURE_OFFSCREEN creates a new one.
 */
export const RESEND_PAUSES_MS: readonly number[] = [0, 200, 500];

export interface ScanSenderDeps {
  /** Opens a new scan port (chrome.runtime.connect). */
  connect(): ScanPort;
  /** Asks the service worker to create the offscreen document; true if it exists now. */
  ensureOffscreen(): Promise<boolean>;
  /** Tells the service worker the batch could not be (fully) scanned. */
  reportInterrupted(batchId: string, fileNames: string[]): Promise<void>;
  log: Logger;
  /** Waits between resends; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
}

export type BatchOutcome = 'done' | 'interrupted';

type AttemptResult = 'done' | 'not-accepted' | 'interrupted';

export function createScanSender(deps: ScanSenderDeps) {
  const { log } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** One try: send everything on a fresh port and wait for the port to finish. */
  const attempt = (batch: OutgoingBatch): Promise<AttemptResult> =>
    new Promise((resolve) => {
      let accepted = false;
      let settled = false;
      const finish = (result: AttemptResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let port: ScanPort;
      try {
        port = deps.connect();
      } catch {
        finish('not-accepted'); // e.g. extension reloaded: this content script is orphaned
        return;
      }

      port.onMessage.addListener((raw) => {
        const reply = parseScanPortReply(raw);
        if (reply === null || reply.batchId !== batch.batchId) return;
        if (reply.type === 'BATCH_ACCEPTED') {
          accepted = true;
          return;
        }
        // BATCH_REJECTED: the document is closing and kept nothing – same as never accepted.
        finish(reply.type === 'BATCH_DONE' ? 'done' : 'not-accepted');
        port.disconnect();
      });

      port.onDisconnect.addListener(() => {
        // Reading lastError tells Chrome we handled it (no "Unchecked runtime.lastError").
        void globalThis.chrome?.runtime?.lastError;
        finish(accepted ? 'interrupted' : 'not-accepted');
      });

      try {
        for (const request of batch.requests) port.postMessage(request);
        const end: BatchEnd = { type: 'BATCH_END', batchId: batch.batchId, fileCount: batch.requests.length };
        port.postMessage(end);
      } catch {
        // Posting to a port that already closed throws; onDisconnect decides the result.
      }
    });

  return {
    async send(batch: OutgoingBatch): Promise<BatchOutcome> {
      let result = await attempt(batch);
      for (const pause of RESEND_PAUSES_MS) {
        if (result !== 'not-accepted') break;
        log.debug('scan port not accepted, asking for the offscreen document');
        if (!(await deps.ensureOffscreen())) break;
        if (pause > 0) await sleep(pause);
        result = await attempt(batch);
      }
      if (result === 'done') {
        log.debug('batch done', { files: batch.requests.length });
        return 'done';
      }
      log.warn('batch interrupted', { files: batch.requests.length });
      try {
        await deps.reportInterrupted(batch.batchId, batch.requests.map((r) => r.fileName));
      } catch {
        // No service worker answer either: nothing more we can do from the page.
      }
      return 'interrupted';
    },
  };
}
