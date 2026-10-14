// Whether Chrome lets this extension show notifications (DESIGN.md §7).
// Only Chrome's own block is detectable; a block by the operating system is
// not (create() succeeds) – the README lists it as a requirement.

import type { Logger } from './safe-logger.ts';

/** chrome.notifications.getPermissionLevel() result: "granted" or "denied". */
export function notificationsBlocked(level: string): boolean {
  return level !== 'granted';
}

/** Service-worker log line for the level: a warning while blocked. */
export function logNotificationPermission(level: string, log: Logger): void {
  if (notificationsBlocked(level)) log.warn('notifications are blocked in Chrome – alerts will not be shown');
  else log.debug('notifications are allowed');
}
