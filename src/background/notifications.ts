// Notifications – shown by the service worker only (DESIGN.md §7,
// docs/agents/service-worker.md). What to show is decided in
// result-notifications.ts; this module only talks to chrome.notifications.

import type { GetMessage } from '../shared/i18n.ts';
import type { ShowResult } from '../shared/messages.ts';
import type { Logger } from '../shared/safe-logger.ts';
import { notificationsFor } from './result-notifications.ts';

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
  /** chrome.i18n.getMessage: every text comes from _locales (keys checked by the compiler). */
  getMessage: GetMessage;
}

export function chromeNotificationApi(): NotificationApi {
  return {
    iconUrl: chrome.runtime.getURL(ICON_PATH),
    create: (id, options) => chrome.notifications.create(id, options),
    getMessage: (key, substitutions) => chrome.i18n.getMessage(key, substitutions),
  };
}

export function createNotifier(api: NotificationApi, log: Logger) {
  return {
    /**
     * Shows the notifications for one batch: none if every file is clean,
     * otherwise one for secrets and/or one for files not fully checked (D39).
     * The same batch again replaces its notifications (same ids). Never throws.
     */
    async showResult(message: ShowResult): Promise<void> {
      for (const spec of notificationsFor(message, api.getMessage)) {
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
    },
  };
}
