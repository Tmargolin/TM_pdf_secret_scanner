import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultSettings } from '../../src/shared/settings.ts';
import { createChromeFake, FAKE_EXTENSION_ID, flushAsync, INSTALLED, type ChromeFake } from '../helpers/chrome-fake.ts';

const CONTENT_SCRIPT = { id: FAKE_EXTENSION_ID, tab: { id: 7 } };
const OFFSCREEN_URL = `chrome-extension://${FAKE_EXTENSION_ID}/offscreen/offscreen.html`;
const OFFSCREEN = { id: FAKE_EXTENSION_ID, url: OFFSCREEN_URL };

let fake: ChromeFake;

/** Loads the service worker as Chrome would: a fresh module run with chrome.* present. */
async function startServiceWorker(): Promise<void> {
  vi.resetModules();
  await import('../../src/background/service-worker.ts');
  await flushAsync();
}

/** Sends a runtime message; returns the listener's return value and the response. */
async function send(message: unknown, sender: object) {
  const sendResponse = vi.fn();
  const [returned] = fake.onMessage.dispatch(message, sender as chrome.runtime.MessageSender, sendResponse);
  await flushAsync();
  return { returned, sendResponse };
}

beforeEach(() => {
  fake = createChromeFake();
  fake.install();
  // The safe logger writes to the console; keep test output quiet.
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fake.uninstall();
  vi.restoreAllMocks();
});

describe('service worker start-up', () => {
  it('registers its listeners at the top level', async () => {
    await startServiceWorker();
    expect(fake.onInstalled.listeners).toHaveLength(1);
    expect(fake.onStartup.listeners).toHaveLength(1);
    expect(fake.onMessage.listeners).toHaveLength(1);
  });

  it('creates the offscreen document as soon as it starts', async () => {
    await startServiceWorker();
    expect(fake.offscreenDocuments).toHaveLength(1);
  });

  it('keeps exactly one document when install and startup events follow', async () => {
    await startServiceWorker();
    fake.onInstalled.dispatch(INSTALLED.update);
    fake.onStartup.dispatch();
    await flushAsync();
    expect(fake.offscreenDocuments).toHaveLength(1);
  });

  it('re-creates the document on onStartup if it is gone', async () => {
    await startServiceWorker();
    fake.offscreenDocuments.length = 0;
    fake.onStartup.dispatch();
    await flushAsync();
    expect(fake.offscreenDocuments).toHaveLength(1);
  });

  it('survives a failed creation at start-up and logs it', async () => {
    fake.failNextCreate = new Error('boom');
    await startServiceWorker();
    expect(fake.offscreenDocuments).toHaveLength(0);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe('content-script registration', () => {
  it('registers the content script on install for the granted dev seed', async () => {
    fake.grantedOrigins.push('http://localhost/*');
    await startServiceWorker();
    expect(fake.registeredScripts).toEqual([]); // not at every start-up
    fake.onInstalled.dispatch(INSTALLED.update);
    await flushAsync();
    expect(fake.registeredScripts.map((s) => s.matches)).toEqual([['http://localhost/*']]);
  });

  it('registers nothing on install when no allow-listed site is granted', async () => {
    await startServiceWorker();
    fake.onInstalled.dispatch(INSTALLED.update);
    await flushAsync();
    expect(fake.registeredScripts).toEqual([]);
  });

  it('still keeps the offscreen document on install', async () => {
    await startServiceWorker();
    fake.offscreenDocuments.length = 0;
    fake.onInstalled.dispatch(INSTALLED.update);
    await flushAsync();
    expect(fake.offscreenDocuments).toHaveLength(1);
  });
});

describe('reconcile triggers (step 3)', () => {
  const EXAMPLE = '*://example.com/*';
  const LOCALHOST = 'http://localhost/*';
  const matches = () => fake.registeredScripts.map((s) => s.matches);
  /** Options-page code running against the same fake (other context, same chrome.* state). */
  const optionsPage = async () => {
    const { addSite, removeSite, chromePermissionsApi } = await import('../../src/options/sites.ts');
    const { createLogger } = await import('../../src/shared/safe-logger.ts');
    const deps = {
      storage: fake.chrome.storage.local,
      permissions: chromePermissionsApi(),
      dev: true,
      log: createLogger('options', { sink: () => {} }),
    };
    return {
      add: (input: string, shown: string[]) => addSite(input, shown, deps),
      remove: (pattern: string) => removeSite(pattern, deps),
    };
  };
  /** Lets the chained reconcile runs finish. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await flushAsync();
  };

  it('listens for permission changes', async () => {
    await startServiceWorker();
    expect(fake.onPermissionsAdded.listeners).toHaveLength(1);
    expect(fake.onPermissionsRemoved.listeners).toHaveLength(1);
  });

  it('browser restart: reconciles on onStartup', async () => {
    fake.grantedOrigins.push(LOCALHOST);
    await startServiceWorker();
    fake.onStartup.dispatch();
    await settle();
    expect(matches()).toEqual([[LOCALHOST]]);
  });

  it('adding a site in the options page registers it at once (no extension reload)', async () => {
    fake.grantedOrigins.push(LOCALHOST);
    await startServiceWorker();
    const page = await optionsPage();
    expect((await page.add('example.com', [LOCALHOST])).ok).toBe(true);
    await settle();
    expect(matches()).toEqual([[LOCALHOST, EXAMPLE]]);
  });

  it('removing a site in the options page unregisters it', async () => {
    fake.grantedOrigins.push(LOCALHOST);
    await startServiceWorker();
    const page = await optionsPage();
    await page.add('example.com', [LOCALHOST]);
    await settle();
    await page.remove(EXAMPLE);
    await settle();
    expect(matches()).toEqual([[LOCALHOST]]);
  });

  it('revoking a site in chrome://extensions stops scanning there; granting it again restarts it', async () => {
    fake.grantedOrigins.push(LOCALHOST);
    await startServiceWorker();
    const page = await optionsPage();
    await page.add('example.com', [LOCALHOST]);
    await settle();

    fake.grantedOrigins.splice(fake.grantedOrigins.indexOf(EXAMPLE), 1); // Chrome's Site access → remove
    fake.onPermissionsRemoved.dispatch({ origins: [EXAMPLE] });
    await settle();
    expect(matches()).toEqual([[LOCALHOST]]);

    fake.grantedOrigins.push(EXAMPLE); // granted again from Chrome's menu
    fake.onPermissionsAdded.dispatch({ origins: [EXAMPLE] });
    await settle();
    expect(matches()).toEqual([[LOCALHOST, EXAMPLE]]);
  });

  it('revoking the last site unregisters the script', async () => {
    fake.grantedOrigins.push(LOCALHOST);
    await startServiceWorker();
    fake.onInstalled.dispatch(INSTALLED.update);
    await settle();
    fake.grantedOrigins.length = 0;
    fake.onPermissionsRemoved.dispatch({ origins: [LOCALHOST] });
    await settle();
    expect(fake.registeredScripts).toEqual([]);
  });

  it('saving other settings does not touch the registration', async () => {
    fake.grantedOrigins.push(LOCALHOST);
    fake.storageData['settings'] = getDefaultSettings(true); // settings saved before (not a first save)
    await startServiceWorker();
    fake.onInstalled.dispatch(INSTALLED.update);
    await settle();
    const before = fake.scriptingCalls.length;
    await fake.chrome.storage.local.set({ settings: { ...getDefaultSettings(true), appId: 'new-id' } });
    await settle();
    expect(fake.scriptingCalls).toHaveLength(before);
  });
});

describe('ENSURE_OFFSCREEN', () => {
  it('re-creates a missing document for a content script and replies ok', async () => {
    await startServiceWorker();
    fake.offscreenDocuments.length = 0;
    const { returned, sendResponse } = await send({ type: 'ENSURE_OFFSCREEN' }, CONTENT_SCRIPT);
    expect(returned).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(fake.offscreenDocuments).toHaveLength(1);
  });

  it('replies ok:false when creation fails', async () => {
    await startServiceWorker();
    fake.offscreenDocuments.length = 0;
    fake.failNextCreate = new Error('boom');
    const { sendResponse } = await send({ type: 'ENSURE_OFFSCREEN' }, CONTENT_SCRIPT);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false });
  });

  it.each([
    ['no tab (not a content script)', { id: FAKE_EXTENSION_ID }],
    ['another extension', { id: 'otherextensionidotherextensionid', tab: { id: 7 } }],
  ])('ignores the request from %s', async (_name, sender) => {
    await startServiceWorker();
    fake.offscreenDocuments.length = 0;
    const { returned, sendResponse } = await send({ type: 'ENSURE_OFFSCREEN' }, sender);
    expect(returned).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(fake.offscreenDocuments).toHaveLength(0);
  });

  it.each([
    ['an unknown message', { type: 'DELETE_EVERYTHING' }],
    ['a message for another context', { type: 'OFFSCREEN_READY' }],
    ['malformed data', 'ENSURE_OFFSCREEN'],
  ])('ignores %s', async (_name, message) => {
    await startServiceWorker();
    const { returned, sendResponse } = await send(message, CONTENT_SCRIPT);
    expect(returned).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

describe('settings handshake', () => {
  it('answers OFFSCREEN_READY from the offscreen document with the current settings', async () => {
    fake.storageData['settings'] = { appId: 'abc' };
    await startServiceWorker();
    const { returned, sendResponse } = await send({ type: 'OFFSCREEN_READY' }, OFFSCREEN);
    expect(returned).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({
      type: 'SETTINGS_UPDATED',
      settings: { ...getDefaultSettings(true), appId: 'abc' },
    });
  });

  it.each([
    ['a content script', { ...CONTENT_SCRIPT, url: 'https://mail.google.com/' }],
    ['another page of the extension', { id: FAKE_EXTENSION_ID, url: `chrome-extension://${FAKE_EXTENSION_ID}/options/options.html` }],
    ['another extension', { id: 'otherextensionidotherextensionid', url: OFFSCREEN_URL }],
  ])('ignores OFFSCREEN_READY from %s', async (_name, sender) => {
    await startServiceWorker();
    const { returned, sendResponse } = await send({ type: 'OFFSCREEN_READY' }, sender);
    expect(returned).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('pushes the settings when they change in storage', async () => {
    await startServiceWorker();
    fake.sendMessageHandler = async () => undefined;
    await fake.chrome.storage.local.set({ settings: { appId: 'new-id' } });
    await flushAsync();
    expect(fake.sentMessages).toEqual([
      { type: 'SETTINGS_UPDATED', settings: { ...getDefaultSettings(true), appId: 'new-id' } },
    ]);
  });

  it('does not push when other storage keys change', async () => {
    await startServiceWorker();
    await fake.chrome.storage.local.set({ somethingElse: 1 });
    await flushAsync();
    expect(fake.sentMessages).toEqual([]);
  });
});

describe('SHOW_RESULT → notification', () => {
  const BATCH_ID = '6a2b3c4d-5555-4666-8777-988899990000';
  const SHOW = {
    type: 'SHOW_RESULT',
    batchId: BATCH_ID,
    origin: 'http://localhost:8787',
    results: [
      {
        scanId: '5f1c2a3e-1111-4222-8333-944455556666',
        batchId: BATCH_ID,
        fileName: 'a.pdf',
        status: 'clean',
        findings: [],
        errors: [],
      },
    ],
  };

  it('shows one notification for a result from the offscreen document, without replying', async () => {
    await startServiceWorker();
    const { returned, sendResponse } = await send(SHOW, OFFSCREEN);
    expect(returned).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(fake.notifications.get(`batch-${BATCH_ID}`)?.message).toBe(
      'Received 1 file(s) from localhost:8787. Scanning is not implemented yet – nothing was checked.',
    );
  });

  it.each([
    ['a content script', { ...CONTENT_SCRIPT, url: 'https://mail.google.com/' }],
    ['another page of the extension', { id: FAKE_EXTENSION_ID, url: `chrome-extension://${FAKE_EXTENSION_ID}/options/options.html` }],
    ['another extension', { id: 'otherextensionidotherextensionid', url: OFFSCREEN_URL }],
  ])('ignores a result sent by %s', async (_name, sender) => {
    await startServiceWorker();
    await send(SHOW, sender);
    expect(fake.notifications.size).toBe(0);
  });

  it('ignores a malformed result', async () => {
    await startServiceWorker();
    await send({ ...SHOW, results: [] }, OFFSCREEN);
    await send({ ...SHOW, origin: 42 }, OFFSCREEN);
    expect(fake.notifications.size).toBe(0);
  });
});
