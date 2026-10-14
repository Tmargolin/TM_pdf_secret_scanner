// Content-script wiring (DESIGN.md §3, docs/agents/content-script.md):
//   bridge → batcher (300 ms window, ≤ 100 files) → PDF check (%PDF-) →
//   size check (maxFileSizeMB) → encode → scan sender.
// Everything from outside is injected, so the whole path can be tested in a
// real browser without the extension; index.ts passes the real chrome.* parts.

import { LIMITS } from '../shared/messages.ts';
import type { Logger } from '../shared/safe-logger.ts';
import { loadSettings, type SettingsStorage } from '../shared/settings.ts';
import { BATCH_WINDOW_MS, createBatcher } from './batcher.ts';
import { openBridge } from './bridge.ts';
import { toScanRequest } from './encode.ts';
import { keepPdfs } from './pdf-filter.ts';
import type { OutgoingBatch } from './scan-sender.ts';

const MB = 1024 * 1024;

export interface ContentScriptDeps {
  /** The page's window: the MAIN-world hooks are reached through it. */
  win: Window;
  /** chrome.storage.local – only maxFileSizeMB is used. */
  storage: SettingsStorage;
  /** Sends one batch to the offscreen document (scan-sender.ts). */
  sender: { send(batch: OutgoingBatch): Promise<unknown> };
  dev: boolean;
  log: Logger;
  /** Batch window; tests use a shorter one. */
  windowMs?: number;
  newId?: () => string;
}

export function startContentScript(deps: ContentScriptDeps): void {
  const { log, newId = () => crypto.randomUUID() } = deps;

  /** maxFileSizeMB in bytes, read fresh per batch. Only this number is kept – never the APP-ID. */
  const maxFileBytes = async (): Promise<number> => {
    try {
      return (await loadSettings(deps.storage, deps.dev)).maxFileSizeMB * MB;
    } catch {
      return LIMITS.fileBytes;
    }
  };

  const sendBatch = async (files: File[]): Promise<void> => {
    try {
      const pdfs = await keepPdfs(files);
      log.debug('batch from the page', { files: files.length, pdfs: pdfs.length });
      if (pdfs.length === 0) return;
      const batchId = newId();
      const maxBytes = await maxFileBytes();
      const requests = await Promise.all(pdfs.map((file) => toScanRequest(file, batchId, newId(), maxBytes)));
      await deps.sender.send({ batchId, requests });
    } catch (error) {
      log.error('files could not be sent for scanning', { error });
    }
  };

  const batcher = createBatcher<File>({
    windowMs: deps.windowMs ?? BATCH_WINDOW_MS,
    maxItems: LIMITS.filesPerBatch,
    onBatch: (files) => void sendBatch(files),
  });

  openBridge(deps.win, (file) => batcher.add(file));
}
