import { afterEach, describe, expect, it } from 'vitest';
import {
  chromeOffscreenApi,
  createOffscreenManager,
  OFFSCREEN_JUSTIFICATION,
  OFFSCREEN_PATH,
  type OffscreenApi,
} from '../../src/background/offscreen-manager.ts';
import { createLogger, type LogLevel } from '../../src/shared/safe-logger.ts';
import { createChromeFake, FAKE_EXTENSION_ID } from '../helpers/chrome-fake.ts';

/** A logger that records lines instead of printing them. */
function recordingLogger() {
  const lines: { level: LogLevel; line: string }[] = [];
  const log = createLogger('test', { sink: (level, line) => void lines.push({ level, line }) });
  return { log, lines };
}

/** An OffscreenApi fake: creation takes one macrotask, like a real page load. */
function fakeApi(options: { exists?: boolean } = {}) {
  let exists = options.exists ?? false;
  const calls = { has: 0, create: 0 };
  const api: OffscreenApi = {
    hasDocument: async () => {
      calls.has += 1;
      return exists;
    },
    createDocument: async () => {
      calls.create += 1;
      await new Promise((r) => setTimeout(r, 1));
      if (exists) throw new Error('Only a single offscreen document may be created.');
      exists = true;
    },
  };
  return { api, calls, remove: () => void (exists = false) };
}

describe('createOffscreenManager', () => {
  it('creates the document when it is missing', async () => {
    const { api, calls } = fakeApi();
    const { log, lines } = recordingLogger();
    await createOffscreenManager(api, log).ensureOffscreen();
    expect(calls.create).toBe(1);
    expect(lines).toEqual([{ level: 'info', line: '[PSS:test] offscreen document created' }]);
  });

  it('does nothing when the document already exists', async () => {
    const { api, calls } = fakeApi({ exists: true });
    await createOffscreenManager(api, recordingLogger().log).ensureOffscreen();
    expect(calls.create).toBe(0);
  });

  it('creates exactly one document for concurrent calls', async () => {
    const { api, calls } = fakeApi();
    const manager = createOffscreenManager(api, recordingLogger().log);
    await Promise.all(Array.from({ length: 10 }, () => manager.ensureOffscreen()));
    expect(calls.create).toBe(1);
    expect(calls.has).toBe(1);
  });

  it('checks again after a creation has finished', async () => {
    const { api, calls, remove } = fakeApi();
    const manager = createOffscreenManager(api, recordingLogger().log);
    await manager.ensureOffscreen();
    remove(); // e.g. Chrome closed the document
    await manager.ensureOffscreen();
    expect(calls.has).toBe(2);
    expect(calls.create).toBe(2);
  });

  it('treats "only a single offscreen document" as success (race with another creator)', async () => {
    const { log, lines } = recordingLogger();
    const api: OffscreenApi = {
      hasDocument: async () => false,
      createDocument: async () => {
        throw new Error('Only a single offscreen document may be created.');
      },
    };
    await expect(createOffscreenManager(api, log).ensureOffscreen()).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('reports a real failure, logs it, and tries again on the next call', async () => {
    const { log, lines } = recordingLogger();
    let fail = true;
    let created = 0;
    const api: OffscreenApi = {
      hasDocument: async () => false,
      createDocument: async () => {
        if (fail) throw new Error('boom');
        created += 1;
      },
    };
    const manager = createOffscreenManager(api, log);
    await expect(manager.ensureOffscreen()).rejects.toThrow('boom');
    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.line).toBe('[PSS:test] offscreen document could not be created');

    fail = false;
    await manager.ensureOffscreen();
    expect(created).toBe(1);
  });

  it('rejects when something other than an Error is thrown', async () => {
    const api: OffscreenApi = {
      hasDocument: async () => false,
      createDocument: async () => {
        throw 'not an Error object';
      },
    };
    await expect(createOffscreenManager(api, recordingLogger().log).ensureOffscreen()).rejects.toBe('not an Error object');
  });
});

describe('chromeOffscreenApi', () => {
  const fake = createChromeFake();
  afterEach(() => fake.uninstall());

  it('looks for an offscreen document with the exact page URL', async () => {
    fake.install();
    expect(await chromeOffscreenApi().hasDocument()).toBe(false);
    expect(fake.getContextsCalls.at(-1)).toEqual({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [`chrome-extension://${FAKE_EXTENSION_ID}/${OFFSCREEN_PATH}`],
    });
  });

  it('creates the page with reason WORKERS and finds it afterwards', async () => {
    fake.install();
    const api = chromeOffscreenApi();
    await api.createDocument();
    expect(fake.createDocumentCalls.at(-1)).toEqual({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification: OFFSCREEN_JUSTIFICATION,
    });
    expect(await api.hasDocument()).toBe(true);
  });
});
