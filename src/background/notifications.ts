// Notifications – shown by the service worker only (DESIGN.md §7,
// docs/agents/service-worker.md). Walking skeleton: one notification per
// received batch; the real result texts arrive in step 7.

import type { ShowResult } from '../shared/messages.ts';
import type { Logger } from '../shared/safe-logger.ts';

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
  /** chrome.i18n.getMessage: every text comes from _locales. */
  getMessage(key: string, substitutions?: string[]): string;
}

export function chromeNotificationApi(): NotificationApi {
  return {
    iconUrl: chrome.runtime.getURL(ICON_PATH),
    create: (id, options) => chrome.notifications.create(id, options),
    getMessage: (key, substitutions) => chrome.i18n.getMessage(key, substitutions),
  };
}

/** The site as people read it: "mail.google.com" (port kept if any). */
export function siteName(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

export function createNotifier(api: NotificationApi, log: Logger) {
  return {
    /** Skeleton: says a batch arrived; the real result texts arrive in step 7. */
    async showBatchReceived(message: ShowResult): Promise<void> {
      try {
        // One notification per batch: the same id replaces, never duplicates.
        await api.create(`batch-${message.batchId}`, {
          type: 'basic',
          iconUrl: api.iconUrl,
          title: api.getMessage('skeletonBatchTitle'),
          message: api.getMessage('skeletonBatchMessage', [String(message.results.length), siteName(message.origin)]),
        });
      } catch (error) {
        log.error('notification could not be shown', { error });
      }
    },
  };
}
