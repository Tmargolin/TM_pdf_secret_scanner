// Service worker – configuration and display only, never on the scan path
// (DESIGN.md §2, docs/agents/service-worker.md). Chrome may stop it at any
// time, so it holds no state that matters; listeners are registered at the
// top level so Chrome can wake it for these events.

import { isFromContentScript, isFromOffscreen, parseRuntimeMessage } from '../shared/messages.ts';
import { logNotificationPermission } from '../shared/notification-permission.ts';
import { createLogger } from '../shared/safe-logger.ts';
import { chromeOffscreenApi, createOffscreenManager, OFFSCREEN_PATH } from './offscreen-manager.ts';
import { chromeNotificationApi, createNotifier } from './notifications.ts';
import { allowListChanged, chromeScriptingApi, createScriptRegistry } from './script-registry.ts';
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
// Content-script registration follows allow list ∩ granted sites (D24). Every
// trigger simply calls reconcile(): it is idempotent and runs one at a time.
const reconcileScripts = (): void => {
  void scripts.reconcile();
};

chrome.runtime.onInstalled.addListener((details) => {
  keepOffscreenAlive();
  reconcileScripts(); // install, update, reload
  // First install only (not updates or reloads): the user must enter the
  // APP-ID and add sites before anything is scanned.
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch((error: unknown) => log.warn('options page could not be opened', { error }));
  }
});
chrome.runtime.onStartup.addListener(() => {
  keepOffscreenAlive();
  reconcileScripts(); // browser start: re-check in case permissions changed while closed
});
// Granted in the options page, or revoked/granted in chrome://extensions.
chrome.permissions.onAdded.addListener(reconcileScripts);
chrome.permissions.onRemoved.addListener(reconcileScripts);

// Notifications blocked in Chrome cannot be reported by a notification: log it
// at every start and on every change (the options page also shows a warning).
chrome.notifications
  .getPermissionLevel()
  .then((level) => logNotificationPermission(level, log))
  .catch(() => {});
chrome.notifications.onPermissionLevelChanged.addListener((level) => logNotificationPermission(level, log));

chrome.storage.onChanged.addListener((changes, areaName) => {
  void settings.onStorageChanged(changes, areaName);
  if (allowListChanged(changes, areaName)) reconcileScripts();
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
    void notifier.showResult(message);
    return false; // display only, no reply
  }

  return false;
});
