// Service worker – configuration and display only, never on the scan path
// (DESIGN.md §2, docs/agents/service-worker.md). Chrome may stop it at any
// time, so it holds no state that matters; listeners are registered at the
// top level so Chrome can wake it for these events.

import { isFromContentScript, parseRuntimeMessage } from '../shared/messages.ts';
import { createLogger } from '../shared/safe-logger.ts';
import { chromeOffscreenApi, createOffscreenManager } from './offscreen-manager.ts';

const log = createLogger('sw', { dev: __DEV__ });
const offscreen = createOffscreenManager(chromeOffscreenApi(), log);

/** Create the offscreen document; failures are already logged by the manager. */
const keepOffscreenAlive = (): void => {
  offscreen.ensureOffscreen().catch(() => {});
};

// Every time the service worker starts (install, update, browser start, extension
// re-enabled, or woken after being stopped) – a cheap existence check.
keepOffscreenAlive();
chrome.runtime.onInstalled.addListener(keepOffscreenAlive);
chrome.runtime.onStartup.addListener(keepOffscreenAlive);

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const message = parseRuntimeMessage(raw, __DEV__);
  if (message?.type === 'ENSURE_OFFSCREEN' && isFromContentScript(sender, chrome.runtime.id)) {
    offscreen.ensureOffscreen().then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true; // the response is sent asynchronously
  }
  return false;
});
