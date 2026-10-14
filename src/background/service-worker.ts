// Service worker – configuration and display only, never on the scan path
// (DESIGN.md §2, docs/agents/service-worker.md). Chrome may stop it at any
// time, so it holds no state that matters; listeners are registered at the
// top level so Chrome can wake it for these events.

import { isFromContentScript, isFromOffscreen, parseRuntimeMessage } from '../shared/messages.ts';
import { createLogger } from '../shared/safe-logger.ts';
import { chromeOffscreenApi, createOffscreenManager, OFFSCREEN_PATH } from './offscreen-manager.ts';
import { chromeNotificationApi, createNotifier } from './notifications.ts';
import { chromeScriptingApi, createScriptRegistry } from './script-registry.ts';
import { createSettingsBridge } from './settings-bridge.ts';

const log = createLogger('sw', { dev: __DEV__ });
const offscreen = createOffscreenManager(chromeOffscreenApi(), log);
const settings = createSettingsBridge({
  storage: chrome.storage.local,
  send: (message) => chrome.runtime.sendMessage(message),
  dev: __DEV__,
  log,
});
const notifier = createNotifier(chromeNotificationApi(), log);
const scripts = createScriptRegistry({
  api: chromeScriptingApi(),
  storage: chrome.storage.local,
  dev: __DEV__,
  log,
});

/** Create the offscreen document; failures are already logged by the manager. */
const keepOffscreenAlive = (): void => {
  offscreen.ensureOffscreen().catch(() => {});
};

// Every time the service worker starts (install, update, browser start, extension
// re-enabled, or woken after being stopped) – a cheap existence check.
keepOffscreenAlive();
chrome.runtime.onInstalled.addListener(() => {
  keepOffscreenAlive();
  // Install, update or reload: register the content scripts for the allow list.
  // (Startup, allow-list and permission changes are added in step 3.)
  void scripts.reconcile();
});
chrome.runtime.onStartup.addListener(keepOffscreenAlive);

chrome.storage.onChanged.addListener((changes, areaName) => {
  void settings.onStorageChanged(changes, areaName);
});

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const message = parseRuntimeMessage(raw, __DEV__);
  const extensionId = chrome.runtime.id;

  if (message?.type === 'ENSURE_OFFSCREEN' && isFromContentScript(sender, extensionId)) {
    offscreen.ensureOffscreen().then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true; // the response is sent asynchronously
  }

  if (message?.type === 'OFFSCREEN_READY' && isFromOffscreen(sender, extensionId, chrome.runtime.getURL(OFFSCREEN_PATH))) {
    settings.currentMessage().then(sendResponse, () => sendResponse(undefined));
    return true;
  }

  if (message?.type === 'SHOW_RESULT' && isFromOffscreen(sender, extensionId, chrome.runtime.getURL(OFFSCREEN_PATH))) {
    void notifier.showBatchReceived(message);
    return false; // display only, no reply
  }

  return false;
});
