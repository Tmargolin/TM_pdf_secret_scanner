import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_APP_ID } from '../helpers/fake-secrets.ts';
import { createSettingsBridge } from '../../src/background/settings-bridge.ts';
import type { SettingsMessage } from '../../src/shared/messages.ts';
import { clearRegisteredSecrets, createLogger, sanitizeString, type LogLevel } from '../../src/shared/safe-logger.ts';
import { getDefaultSettings, STORAGE_KEY, type SettingsStorage } from '../../src/shared/settings.ts';

function setup(stored?: unknown, options: { sendFails?: boolean } = {}) {
  const data: Record<string, unknown> = stored === undefined ? {} : { [STORAGE_KEY]: stored };
  const storage: SettingsStorage = {
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => void Object.assign(data, items),
  };
  const sent: SettingsMessage[] = [];
  const lines: { level: LogLevel; line: string }[] = [];
  const bridge = createSettingsBridge({
    storage,
    dev: true,
    log: createLogger('sw', { dev: true, sink: (level, line) => void lines.push({ level, line }) }),
    send: async (message) => {
      if (options.sendFails) throw new Error('Could not establish connection. Receiving end does not exist.');
      sent.push(message);
    },
  });
  return { bridge, data, sent, lines };
}

afterEach(() => clearRegisteredSecrets());

describe('currentMessage', () => {
  it('returns the defaults when nothing is stored', async () => {
    const { bridge } = setup();
    expect(await bridge.currentMessage()).toEqual({ type: 'SETTINGS_UPDATED', settings: getDefaultSettings(true) });
  });

  it('returns stored settings, normalised', async () => {
    const { bridge } = setup({ appId: 'abc-123', chunkSize: 8_000, retries: 'many' });
    const { settings } = await bridge.currentMessage();
    expect(settings).toEqual({ ...getDefaultSettings(true), appId: 'abc-123', chunkSize: 8_000 });
  });

  it('registers the APP-ID so it never appears in logs', async () => {
    const { bridge } = setup({ appId: FAKE_APP_ID });
    await bridge.currentMessage();
    expect(sanitizeString(`id ${FAKE_APP_ID}`)).toBe('id [redacted]');
  });
});

describe('onStorageChanged', () => {
  it('pushes the new settings when they change in local storage', async () => {
    const { bridge, data, sent, lines } = setup({ appId: 'old-id' });
    data[STORAGE_KEY] = { appId: 'new-id' };
    await bridge.onStorageChanged({ [STORAGE_KEY]: {} }, 'local');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.settings.appId).toBe('new-id');
    expect(lines.at(-1)).toEqual({ level: 'info', line: '[PSS:sw] settings pushed to the offscreen document' });
  });

  it('ignores other keys and other storage areas', async () => {
    const { bridge, sent } = setup();
    await bridge.onStorageChanged({ somethingElse: {} }, 'local');
    await bridge.onStorageChanged({ [STORAGE_KEY]: {} }, 'sync');
    await bridge.onStorageChanged({ [STORAGE_KEY]: {} }, 'session');
    expect(sent).toHaveLength(0);
  });

  it('skips quietly when there is no offscreen document', async () => {
    const { bridge, lines } = setup(undefined, { sendFails: true });
    await expect(bridge.onStorageChanged({ [STORAGE_KEY]: {} }, 'local')).resolves.toBeUndefined();
    expect(lines).toEqual([{ level: 'debug', line: '[PSS:sw] settings not pushed: no offscreen document' }]);
  });
});
