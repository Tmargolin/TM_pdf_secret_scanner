// Offscreen side of the scan port (DESIGN.md §2 flows 3 and 5, D35,
// docs/agents/offscreen.md). Collects one batch per port, answers
// BATCH_ACCEPTED once all files arrived, hands the batch on, then answers
// BATCH_DONE and closes the port. The batch keeps running if the page goes
// away after BATCH_ACCEPTED. While the document is closing (idle, D42) every
// new port is answered BATCH_REJECTED and closed, before any file is accepted.

import { isFromContentScript, LIMITS, parseScanPortMessage, SCAN_PORT_NAME, type ScanRequest } from '../shared/messages.ts';
import type { Logger } from '../shared/safe-logger.ts';
import type { ScanPort } from '../shared/scan-port.ts';

export interface ReceivedBatch {
  batchId: string;
  /** Site origin from port.sender (set by Chrome) – never from the page. */
  origin: string;
  tabId: number | undefined;
  frameId: number | undefined;
  requests: ScanRequest[];
}

/** The idle monitor's view of the receiver's work (idle-monitor.ts). */
export interface BatchActivity {
  /** Work started; call the returned function when it ends. */
  begin(): () => void;
  /** True while the document is closing: new batches must be rejected. */
  isClosing(): boolean;
}

export interface BatchReceiverDeps {
  extensionId: string;
  log: Logger;
  activity: BatchActivity;
  /** Runs the batch; BATCH_DONE is sent when it settles. */
  runBatch(batch: ReceivedBatch): Promise<void>;
}

/** The origin Chrome reports for the sender, or null if it has none we can use. */
function senderOrigin(sender: chrome.runtime.MessageSender): string | null {
  if (typeof sender.origin === 'string' && sender.origin !== 'null') return sender.origin;
  try {
    return sender.url ? new URL(sender.url).origin : null;
  } catch {
    return null;
  }
}

export function createBatchReceiver(deps: BatchReceiverDeps) {
  const { log } = deps;

  return {
    /** chrome.runtime.onConnect handler. */
    onConnect(port: ScanPort): void {
      if (port.name !== SCAN_PORT_NAME) return; // not ours to handle
      const sender = port.sender;
      const origin = sender ? senderOrigin(sender) : null;
      if (!sender || !isFromContentScript(sender, deps.extensionId) || origin === null) {
        log.warn('scan port refused: not from our content script');
        port.disconnect();
        return;
      }

      // Decided once, when the port opens: a port is either rejected as a
      // whole or counts as work until its batch is dropped or done.
      const rejecting = deps.activity.isClosing();
      const endWork = rejecting ? () => {} : deps.activity.begin();

      let batchId: string | null = null;
      const requests = new Map<string, ScanRequest>();
      let ended = false;

      /** Protocol violation: drop everything; the content script decides retry / interrupted. */
      const refuse = (reason: string) => {
        log.warn('scan port closed', { reason });
        ended = true;
        requests.clear();
        endWork();
        port.disconnect();
      };

      const post = (message: unknown) => {
        try {
          port.postMessage(message);
        } catch {
          // The page went away: the scan continues, there is just nobody to tell.
        }
      };

      port.onMessage.addListener((raw) => {
        if (ended) return;
        const message = parseScanPortMessage(raw);
        if (message === null) return refuse('invalid message');
        if (rejecting) {
          ended = true;
          post({ type: 'BATCH_REJECTED', batchId: message.batchId, reason: 'closing' });
          log.debug('batch rejected: closing');
          port.disconnect();
          return;
        }
        if (batchId === null) batchId = message.batchId;
        if (message.batchId !== batchId) return refuse('mixed batch ids');

        if (message.type === 'SCAN_REQUEST') {
          if (requests.has(message.scanId)) return refuse('duplicate scan id');
          if (requests.size >= LIMITS.filesPerBatch) return refuse('too many files');
          requests.set(message.scanId, message);
          return;
        }

        // BATCH_END
        if (message.fileCount !== requests.size) return refuse('file count mismatch');
        ended = true;
        const batch: ReceivedBatch = {
          batchId,
          origin,
          tabId: sender.tab?.id,
          frameId: sender.frameId,
          requests: [...requests.values()],
        };
        post({ type: 'BATCH_ACCEPTED', batchId });
        log.debug('batch accepted', { files: batch.requests.length });
        void deps
          .runBatch(batch)
          .catch((error: unknown) => log.error('batch failed', { error }))
          .finally(() => {
            endWork();
            post({ type: 'BATCH_DONE', batchId: batch.batchId });
            try {
              port.disconnect();
            } catch {
              // already closed
            }
          });
      });

      port.onDisconnect.addListener(() => {
        void globalThis.chrome?.runtime?.lastError;
        // Before BATCH_END the batch is incomplete: drop it. After, it keeps running.
        if (!ended) {
          requests.clear();
          endWork();
        }
      });
    },
  };
}
