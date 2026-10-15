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

/** The close half of OffscreenApi, for fakes that only test creation. */
const NO_CLOSE = { currentDocumentId: async () => null, closeDocument: async () => {} };

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
    ...NO_CLOSE,
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
      ...NO_CLOSE,
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
      ...NO_CLOSE,
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
      ...NO_CLOSE,
      hasDocument: async () => false,
      createDocument: async () => {
        throw 'not an Error object';
      },
    };
    await expect(createOffscreenManager(api, recordingLogger().log).ensureOffscreen()).rejects.toBe('not an Error object');
  });
});

/** A fake with documents that have ids, and a log of every create/close in order. */
function lifecycleApi() {
  let current: string | null = null;
  let created = 0;
  const events: string[] = [];
  let failClose: Error | null = null;
  const tick = () => new Promise((r) => setTimeout(r, 1)); // Chrome calls take time
  const api: OffscreenApi = {
    hasDocument: async () => current !== null,
    createDocument: async () => {
      await tick();
      current = `doc-${++created}`;
      events.push(`create ${current}`);
    },
    currentDocumentId: async () => current,
    closeDocument: async () => {
      await tick();
      if (failClose) throw failClose;
      events.push(`close ${current}`);
      current = null;
    },
  };
  return {
    api,
    events,
    current: () => current,
    failClose: (error: Error) => void (failClose = error),
  };
}

describe('closeOffscreen (D42)', () => {
  it('closes the document that reported idle', async () => {
    const t = lifecycleApi();
    const { log, lines } = recordingLogger();
    const manager = createOffscreenManager(t.api, log);
    await manager.ensureOffscreen();
    await manager.closeOffscreen('doc-1');
    expect(t.events).toEqual(['create doc-1', 'close doc-1']);
    expect(lines).toContainEqual({ level: 'info', line: '[PSS:test] offscreen document closed (idle)' });
  });

  it('never closes a newer document than the one that reported idle', async () => {
    const t = lifecycleApi();
    const { log, lines } = recordingLogger();
    const manager = createOffscreenManager(t.api, log);
    await manager.ensureOffscreen();
    await manager.closeOffscreen('doc-1');
    await manager.ensureOffscreen(); // doc-2
    await manager.closeOffscreen('doc-1'); // a late report from the old document
    expect(t.current()).toBe('doc-2');
    expect(lines).toContainEqual({ level: 'info', line: '[PSS:test] idle report from an earlier offscreen document ignored' });
  });

  it('without a documentId closes whatever document exists', async () => {
    const t = lifecycleApi();
    const manager = createOffscreenManager(t.api, recordingLogger().log);
    await manager.ensureOffscreen();
    await manager.closeOffscreen();
    expect(t.current()).toBeNull();
  });

  it('no document: nothing to close', async () => {
    const t = lifecycleApi();
    await createOffscreenManager(t.api, recordingLogger().log).closeOffscreen('doc-1');
    expect(t.events).toEqual([]);
  });

  it('a failed close is logged and does not reject; the next ensure still works', async () => {
    const t = lifecycleApi();
    const { log, lines } = recordingLogger();
    const manager = createOffscreenManager(t.api, log);
    await manager.ensureOffscreen();
    t.failClose(new Error('closing failed'));
    await expect(manager.closeOffscreen('doc-1')).resolves.toBeUndefined();
    expect(lines.at(-1)).toEqual({ level: 'warn', line: '[PSS:test] offscreen document could not be closed' });
    await manager.ensureOffscreen();
    expect(t.current()).toBe('doc-1'); // still open – it resumes by itself (safety valve)
  });
});

describe('one queue for create and close', () => {
  it('an ensure that arrives during a close waits for it, then creates a new document', async () => {
    const t = lifecycleApi();
    const manager = createOffscreenManager(t.api, recordingLogger().log);
    await manager.ensureOffscreen();
    const closing = manager.closeOffscreen('doc-1');
    const ensured = manager.ensureOffscreen(); // a content script's batch was rejected meanwhile
    await Promise.all([closing, ensured]);
    expect(t.events).toEqual(['create doc-1', 'close doc-1', 'create doc-2']);
    expect(t.current()).toBe('doc-2');
  });

  it('an ensure queued after a close does not join an ensure queued before it', async () => {
    const t = lifecycleApi();
    const manager = createOffscreenManager(t.api, recordingLogger().log);
    const before = manager.ensureOffscreen();
    const closing = manager.closeOffscreen('doc-1');
    const after = manager.ensureOffscreen();
    expect(after).not.toBe(before);
    await Promise.all([before, closing, after]);
    expect(t.events).toEqual(['create doc-1', 'close doc-1', 'create doc-2']);
  });

  it('ensures with nothing queued after them share one creation', async () => {
    const t = lifecycleApi();
    const manager = createOffscreenManager(t.api, recordingLogger().log);
    const first = manager.ensureOffscreen();
    expect(manager.ensureOffscreen()).toBe(first);
    await first;
    expect(t.events).toEqual(['create doc-1']);
  });

  it('a failed creation does not block the queue', async () => {
    const t = lifecycleApi();
    const manager = createOffscreenManager(
      { ...t.api, createDocument: async () => Promise.reject(new Error('boom')) },
      recordingLogger().log,
    );
    await expect(manager.ensureOffscreen()).rejects.toThrow('boom');
    await expect(manager.closeOffscreen()).resolves.toBeUndefined();
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

  it('reads the current document\'s id and closes it', async () => {
    const own = createChromeFake(); // the fake above already holds a document
    own.install();
    const api = chromeOffscreenApi();
    expect(await api.currentDocumentId()).toBeNull();
    await api.createDocument();
    expect(await api.currentDocumentId()).toBe('doc-1');
    await api.closeDocument();
    expect(own.closeDocumentCalls).toBe(1);
    expect(await api.hasDocument()).toBe(false);
    own.uninstall();
  });
});
