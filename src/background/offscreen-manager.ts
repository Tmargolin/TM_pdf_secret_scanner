// Creates the offscreen document on demand (DESIGN.md §2, D41).
// Chrome allows only one offscreen document per extension, and several callers
// may ask for it at the same time (content scripts in several tabs). All
// concurrent calls share one creation ("single-flight").

import type { Logger } from '../shared/safe-logger.ts';

/** Path of the offscreen page inside the extension (see build.ts). */
export const OFFSCREEN_PATH = 'offscreen/offscreen.html';

export const OFFSCREEN_JUSTIFICATION =
  'Runs pdf.js in a Web Worker to extract PDF text and runs the scan pipeline.';

/** The Chrome calls the manager needs – injected so tests can replace them. */
export interface OffscreenApi {
  hasDocument(): Promise<boolean>;
  createDocument(): Promise<void>;
}

/** The real implementation, using chrome.runtime and chrome.offscreen. */
export function chromeOffscreenApi(): OffscreenApi {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  return {
    async hasDocument() {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [url],
      });
      return contexts.length > 0;
    },
    createDocument: () =>
      chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: OFFSCREEN_JUSTIFICATION,
      }),
  };
}

export interface OffscreenManager {
  /** Resolves once the offscreen document exists. Rejects only if creation failed. */
  ensureOffscreen(): Promise<void>;
}

/** Chrome's error when a second document is requested while one exists. */
const ALREADY_EXISTS = /single offscreen document|already exists/i;

export function createOffscreenManager(api: OffscreenApi, log: Logger): OffscreenManager {
  let pending: Promise<void> | null = null;

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

  return {
    ensureOffscreen() {
      // Join the creation in progress, or start a new one; forget it once finished.
      pending ??= create().finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}
