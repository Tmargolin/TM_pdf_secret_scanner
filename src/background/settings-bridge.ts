// Settings bridge – service-worker side (DESIGN.md §2 message flows 2).
// The offscreen document cannot read chrome.storage, so the service worker
// answers its OFFSCREEN_READY with the current settings and pushes
// SETTINGS_UPDATED whenever the stored settings change.

import type { SettingsMessage } from '../shared/messages.ts';
import { registerSecret, type Logger } from '../shared/safe-logger.ts';
import { loadSettings, STORAGE_KEY, type SettingsStorage } from '../shared/settings.ts';

export interface SettingsBridgeDeps {
  storage: SettingsStorage;
  /** Broadcasts to the extension's pages (chrome.runtime.sendMessage). */
  send(message: SettingsMessage): Promise<unknown>;
  dev: boolean;
  log: Logger;
}

export interface SettingsBridge {
  /** The current settings as a SETTINGS_UPDATED message (reply to OFFSCREEN_READY). */
  currentMessage(): Promise<SettingsMessage>;
  /** chrome.storage.onChanged handler. */
  onStorageChanged(changes: Record<string, unknown>, areaName: string): Promise<void>;
}

export function createSettingsBridge(deps: SettingsBridgeDeps): SettingsBridge {
  const currentMessage = async (): Promise<SettingsMessage> => {
    const settings = await loadSettings(deps.storage, deps.dev);
    if (settings.appId !== '') registerSecret(settings.appId);
    return { type: 'SETTINGS_UPDATED', settings };
  };

  return {
    currentMessage,
    async onStorageChanged(changes, areaName) {
      if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
      const message = await currentMessage();
      try {
        await deps.send(message);
        deps.log.info('settings pushed to the offscreen document');
      } catch {
        // No offscreen document right now: it asks for settings when it loads.
        deps.log.debug('settings not pushed: no offscreen document');
      }
    },
  };
}
