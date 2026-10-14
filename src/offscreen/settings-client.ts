// Settings client – offscreen-document side (DESIGN.md §2 message flows 2).
// Asks the service worker for settings when the document loads (with retries)
// and accepts SETTINGS_UPDATED pushes afterwards. Scan jobs wait on ready().

import { parseRuntimeMessage } from '../shared/messages.ts';
import { registerSecret, type Logger } from '../shared/safe-logger.ts';
import { isConfigured, type Settings } from '../shared/settings.ts';

/** Waits between attempts to get settings from the service worker. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 2_000, 5_000];

export interface SettingsClientDeps {
  /** Sends OFFSCREEN_READY and resolves with the reply. */
  requestSettings(): Promise<unknown>;
  dev: boolean;
  log: Logger;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export interface SettingsClient {
  /** Requests settings until a valid reply arrives or all retries are used. */
  start(): Promise<void>;
  /** Resolves with the first settings received. */
  ready(): Promise<Settings>;
  /** Latest settings, or null before the first arrive. */
  current(): Settings | null;
  /** Handles an incoming message; true if it was a valid SETTINGS_UPDATED. */
  accept(raw: unknown): boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createSettingsClient(deps: SettingsClientDeps): SettingsClient {
  const { log, dev, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, sleep = defaultSleep } = deps;
  let settings: Settings | null = null;
  let resolveReady!: (s: Settings) => void;
  const readyPromise = new Promise<Settings>((resolve) => {
    resolveReady = resolve;
  });

  const accept = (raw: unknown): boolean => {
    const message = parseRuntimeMessage(raw, dev);
    if (message?.type !== 'SETTINGS_UPDATED') return false;
    const first = settings === null;
    settings = message.settings;
    if (settings.appId !== '') registerSecret(settings.appId);
    log.info(first ? 'settings received' : 'settings updated', {
      configured: isConfigured(settings),
      sites: settings.allowedSites.length,
    });
    if (first) resolveReady(settings);
    return true;
  };

  return {
    accept,
    ready: () => readyPromise,
    current: () => settings,
    async start() {
      for (const delay of [0, ...retryDelaysMs]) {
        if (delay > 0) await sleep(delay);
        if (settings !== null) return; // a push arrived meanwhile
        try {
          if (accept(await deps.requestSettings())) return;
        } catch {
          // Service worker not answering yet – try again after the next delay.
        }
      }
      log.error('no settings received from the service worker');
    },
  };
}
