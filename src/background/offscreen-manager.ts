// Creates the offscreen document on demand and closes it when it reports idle
// (DESIGN.md §2 "Offscreen lifecycle", D41, D42).
// Chrome allows only one offscreen document per extension. Create and close
// run through ONE queue, in arrival order: an ENSURE_OFFSCREEN that arrives
// during a close waits for it, then creates a new document. Concurrent ensures
// with nothing queued after them share one creation ("single-flight").

import type { Logger } from '../shared/safe-logger.ts';

/** Path of the offscreen page inside the extension (see build.ts). */
export const OFFSCREEN_PATH = 'offscreen/offscreen.html';

export const OFFSCREEN_JUSTIFICATION =
  'Runs pdf.js in a Web Worker to extract PDF text and runs the scan pipeline.';

/** The Chrome calls the manager needs – injected so tests can replace them. */
export interface OffscreenApi {
  hasDocument(): Promise<boolean>;
  createDocument(): Promise<void>;
  /** documentId of the current offscreen document, or null if there is none. */
  currentDocumentId(): Promise<string | null>;
  closeDocument(): Promise<void>;
}

/** The real implementation, using chrome.runtime and chrome.offscreen. */
export function chromeOffscreenApi(): OffscreenApi {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = () =>
    chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [url],
    });
  return {
    hasDocument: async () => (await contexts()).length > 0,
    createDocument: () =>
      chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: OFFSCREEN_JUSTIFICATION,
      }),
    currentDocumentId: async () => (await contexts())[0]?.documentId ?? null,
    closeDocument: () => chrome.offscreen.closeDocument(),
  };
}

export interface OffscreenManager {
  /** Resolves once the offscreen document exists. Rejects only if creation failed. */
  ensureOffscreen(): Promise<void>;
  /**
   * Closes the offscreen document after it reported idle. With `documentId`
   * (the reporting document), a newer document is never closed. Never rejects.
   */
  closeOffscreen(documentId?: string): Promise<void>;
}

/** Chrome's error when a second document is requested while one exists. */
const ALREADY_EXISTS = /single offscreen document|already exists/i;

export function createOffscreenManager(api: OffscreenApi, log: Logger): OffscreenManager {
  // The queue: every operation starts after the previous one has settled.
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  /** The last queued operation, if it is an ensure that has not settled – new ensures join it. */
  let lastEnsure: Promise<void> | null = null;

  const create = async (): Promise<void> => {
    if (await api.hasDocument()) return;
    try {
      await api.createDocument();
      log.info('offscreen document created');
    } catch (error) {
      // Lost a race with another creator: the document exists, which is what we want.
      if (error instanceof Error && ALREADY_EXISTS.test(error.message)) return;
      log.error('offscreen document could not be created', { error });
      throw error;
    }
  };

  const close = async (documentId: string | undefined): Promise<void> => {
    try {
      const current = await api.currentDocumentId();
      if (current === null) return; // already gone
      if (documentId !== undefined && current !== documentId) {
        log.info('idle report from an earlier offscreen document ignored');
        return;
      }
      await api.closeDocument();
      log.info('offscreen document closed (idle)');
    } catch (error) {
      // The document stays; it resumes by itself after its grace period (D42).
      log.warn('offscreen document could not be closed', { error });
    }
  };

  return {
    ensureOffscreen() {
      if (lastEnsure) return lastEnsure;
      const ensure = enqueue(create);
      lastEnsure = ensure;
      const forget = () => {
        if (lastEnsure === ensure) lastEnsure = null;
      };
      ensure.then(forget, forget);
      return ensure;
    },
    closeOffscreen(documentId) {
      lastEnsure = null; // an ensure after this close must not join one queued before it
      return enqueue(() => close(documentId));
    },
  };
}
