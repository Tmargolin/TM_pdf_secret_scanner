// Notifications – shown by the service worker only (DESIGN.md §7,
// docs/agents/service-worker.md). What to show is decided in
// result-notifications.ts; this module only talks to chrome.notifications.

import type { GetMessage } from '../shared/i18n.ts';
import type { ScanInterrupted, ShowResult } from '../shared/messages.ts';
import type { Logger } from '../shared/safe-logger.ts';
import { interruptedNotification, notificationsFor, opensSettings, type NotificationSpec } from './result-notifications.ts';

export { siteName } from './result-notifications.ts';

/**
 * Icon for every notification (copied to dist/ by build.ts). Passed as a full
 * chrome-extension:// URL: a relative iconUrl is resolved against the service
 * worker's own folder (background/), where the icon is not.
 */
export const ICON_PATH = 'icons/icon-128.png';

/** The Chrome calls the notifier needs – injected so tests can replace them. */
export interface NotificationApi {
  /** Full URL of ICON_PATH (chrome.runtime.getURL). */
  readonly iconUrl: string;
  create(id: string, options: chrome.notifications.NotificationCreateOptions): Promise<unknown>;
  clear(id: string): Promise<unknown>;
  /** chrome.runtime.openOptionsPage. */
  openSettings(): Promise<void>;
  /** chrome.i18n.getMessage: every text comes from _locales (keys checked by the compiler). */
  getMessage: GetMessage;
}

export function chromeNotificationApi(): NotificationApi {
  return {
    iconUrl: chrome.runtime.getURL(ICON_PATH),
    create: (id, options) => chrome.notifications.create(id, options),
    clear: (id) => chrome.notifications.clear(id),
    openSettings: () => chrome.runtime.openOptionsPage(),
    getMessage: (key, substitutions) => chrome.i18n.getMessage(key, substitutions),
  };
}

export function createNotifier(api: NotificationApi, log: Logger) {
  const show = async (specs: NotificationSpec[]): Promise<void> => {
    for (const spec of specs) {
      try {
        await api.create(spec.id, {
          type: 'basic',
          iconUrl: api.iconUrl,
          title: spec.title,
          message: spec.message,
          priority: 2,
          requireInteraction: true, // stays until dismissed, where the OS allows it
        });
      } catch (error) {
        log.error('notification could not be shown', { error, kind: spec.kind });
      }
    }
  };

  return {
    /**
     * Shows the notifications for one batch: none if every file is clean,
     * otherwise for secrets, files not fully checked (D39) and/or a missing
     * APP-ID. The same batch again replaces its notifications (same ids). Never throws.
     */
    showResult: (message: ShowResult): Promise<void> => show(notificationsFor(message, api.getMessage)),

    /** The scan of a batch stopped before a result (SCAN_INTERRUPTED from the content script). */
    showInterrupted: (message: ScanInterrupted): Promise<void> => show([interruptedNotification(message, api.getMessage)]),

    /** chrome.notifications.onClicked: "isn't set up" and "APP-ID rejected" open the settings. */
    async onClicked(notificationId: string): Promise<void> {
      if (!opensSettings(notificationId)) return;
      try {
        await api.openSettings();
        await api.clear(notificationId);
      } catch (error) {
        log.warn('options page could not be opened', { error });
      }
    },
  };
}
