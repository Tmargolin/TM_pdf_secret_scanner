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
});

describe('content-script registration', () => {
  it('registers the content script on install for the granted dev seed', async () => {
    fake.grantedOrigins.push('http://localhost/*');
    await startServiceWorker();
    expect(fake.registeredScripts).toEqual([]); // not at every start-up
    fake.onInstalled.dispatch(INSTALLED.update);
    await flushAsync();
    expect(fake.registeredScripts.map((s) => [s.id, s.matches])).toEqual([
      ['pss-hooks', ['http://localhost/*']],
      ['pss-content', ['http://localhost/*']],
    ]);
  });

  it('registers nothing on install when no allow-listed site is granted', async () => {
    await startServiceWorker();
    fake.onInstalled.dispatch(INSTALLED.update);
    await flushAsync();
    expect(fake.registeredScripts).toEqual([]);
  });
});

describe('notifications blocked in Chrome', () => {
  const BLOCKED = '[PSS:sw] notifications are blocked in Chrome – alerts will not be shown';

  it('warns at start-up while blocked', async () => {
    fake.notificationLevel = 'denied';
    await startServiceWorker();
    expect(console.warn).toHaveBeenCalledWith(BLOCKED);
  });

  it('does not warn at start-up while allowed', async () => {
    await startServiceWorker();
    expect(console.warn).not.toHaveBeenCalledWith(BLOCKED);
  });

  it('warns when the user turns notifications off, and stops when they are on again', async () => {
    await startServiceWorker();
    expect(fake.onNotificationLevelChanged.listeners).toHaveLength(1);
    fake.onNotificationLevelChanged.dispatch('denied');
    expect(console.warn).toHaveBeenCalledTimes(1);
    fake.onNotificationLevelChanged.dispatch('granted');
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('starts normally when the level cannot be read', async () => {
    Reflect.set(fake.chrome.notifications, 'getPermissionLevel', async () => {
      throw new Error('not available');
    });
    await startServiceWorker();
    expect(fake.onMessage.listeners).toHaveLength(1);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('options page on install', () => {
  it('opens on the first install', async () => {
    await startServiceWorker();
    fake.onInstalled.dispatch(INSTALLED.install);
    await flushAsync();
    expect(fake.optionsPageOpened).toBe(1);
  });

  it.each([
    ['an extension update or reload', INSTALLED.update],
    ['a Chrome update', { reason: 'chrome_update' } as const],
  ])('does not open on %s', async (_name, details) => {
    await startServiceWorker();
    fake.onInstalled.dispatch(details);
    await flushAsync();
    expect(fake.optionsPageOpened).toBe(0);
  });

  it('still sets everything up on install, also when the page cannot be opened', async () => {
    fake.grantedOrigins.push('http://localhost/*');
    await startServiceWorker();
    Reflect.set(fake.chrome.runtime, 'openOptionsPage', async () => {
      throw new Error('Could not create an options page.');
    });
    fake.onInstalled.dispatch(INSTALLED.install);
    await flushAsync();
    expect(console.warn).toHaveBeenCalledWith('[PSS:sw] options page could not be opened', expect.anything());
    expect(fake.registeredScripts).toHaveLength(2); // hooks + content script
  });
});

describe('reconcile triggers (step 3)', () => {
  const EXAMPLE = '*://example.com/*';
  const LOCALHOST = 'http://localhost/*';
  /** Matches of the content script (the hooks script always has the same). */
  const matches = () => fake.registeredScripts.filter((s) => s.id === 'pss-content').map((s) => s.matches);
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

describe('lazy offscreen document (D41)', () => {
  it('no document after the service worker starts', async () => {
    await startServiceWorker();
    expect(fake.offscreenDocuments).toHaveLength(0);
    expect(fake.createDocumentCalls).toHaveLength(0);
  });

  it.each([
    ['first install', () => fake.onInstalled.dispatch(INSTALLED.install)],
    ['an update or reload', () => fake.onInstalled.dispatch(INSTALLED.update)],
    ['browser start', () => fake.onStartup.dispatch()],
    ['a notification click', () => fake.onNotificationClicked.dispatch('not-configured')],
    ['a settings change', () => void fake.chrome.storage.local.set({ settings: getDefaultSettings(true) })],
  ])('no document after %s', async (_name, trigger) => {
    await startServiceWorker();
    trigger();
    await flushAsync();
    expect(fake.createDocumentCalls).toHaveLength(0);
  });

  it('the first ENSURE_OFFSCREEN creates exactly one document', async () => {
    await startServiceWorker();
    const { sendResponse } = await send({ type: 'ENSURE_OFFSCREEN' }, CONTENT_SCRIPT);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(fake.offscreenDocuments).toEqual([OFFSCREEN_URL]);
    expect(fake.createDocumentCalls).toHaveLength(1);
  });

  it('two tabs asking at the same time share one creation', async () => {
    await startServiceWorker();
    const first = vi.fn();
    const second = vi.fn();
    const otherTab = { id: FAKE_EXTENSION_ID, tab: { id: 8 } };
    fake.onMessage.dispatch({ type: 'ENSURE_OFFSCREEN' }, CONTENT_SCRIPT as object as chrome.runtime.MessageSender, first);
    fake.onMessage.dispatch({ type: 'ENSURE_OFFSCREEN' }, otherTab as object as chrome.runtime.MessageSender, second);
    await flushAsync();
    expect(first).toHaveBeenCalledWith({ ok: true });
    expect(second).toHaveBeenCalledWith({ ok: true });
    expect(fake.createDocumentCalls).toHaveLength(1);
  });

  it('a later ENSURE_OFFSCREEN with the document present creates nothing', async () => {
    await startServiceWorker();
    await send({ type: 'ENSURE_OFFSCREEN' }, CONTENT_SCRIPT);
    const { sendResponse } = await send({ type: 'ENSURE_OFFSCREEN' }, CONTENT_SCRIPT);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(fake.createDocumentCalls).toHaveLength(1);
  });

  it('a failed creation is retried by the next ENSURE_OFFSCREEN', async () => {
    await startServiceWorker();
    fake.failNextCreate = new Error('boom');
    const failed = await send({ type: 'ENSURE_OFFSCREEN' }, CONTENT_SCRIPT);
    expect(failed.sendResponse).toHaveBeenCalledWith({ ok: false });
    const retried = await send({ type: 'ENSURE_OFFSCREEN' }, CONTENT_SCRIPT);
    expect(retried.sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(fake.offscreenDocuments).toHaveLength(1);
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
        status: 'secrets',
        findings: [{ entityType: 'AWS credentials', category: 'Access Tokens', masked: 'AKIA…LE', pages: [1] }],
        errors: [],
      },
    ],
  };

  it('shows one notification for a result from the offscreen document, without replying', async () => {
    await startServiceWorker();
    const { returned, sendResponse } = await send(SHOW, OFFSCREEN);
    expect(returned).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(fake.notifications.get(`batch-${BATCH_ID}-secrets`)?.title).toBe('Secrets found in a.pdf');
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

describe('SCAN_INTERRUPTED and notification clicks (7.3)', () => {
  const BATCH_ID = '6a2b3c4d-5555-4666-8777-988899990000';
  const INTERRUPTED = { type: 'SCAN_INTERRUPTED', batchId: BATCH_ID, fileNames: ['a.pdf'] };

  it('from a content script: the "interrupted" notification, no reply', async () => {
    await startServiceWorker();
    const { returned, sendResponse } = await send(INTERRUPTED, { ...CONTENT_SCRIPT, url: 'https://mail.google.com/' });
    expect(returned).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(fake.notifications.get(`batch-${BATCH_ID}-failed`)?.title).toBe('The scan of a.pdf was interrupted');
  });

  it.each([
    ['the offscreen document', OFFSCREEN],
    ['another extension', { id: 'otherextensionidotherextensionid', tab: { id: 7 } }],
  ])('ignored when sent by %s', async (_name, sender) => {
    await startServiceWorker();
    await send(INTERRUPTED, sender);
    expect(fake.notifications.size).toBe(0);
  });

  it('ignored when malformed (no file names)', async () => {
    await startServiceWorker();
    await send({ ...INTERRUPTED, fileNames: [] }, CONTENT_SCRIPT);
    expect(fake.notifications.size).toBe(0);
  });

  it('clicking "isn\'t set up" opens the settings', async () => {
    await startServiceWorker();
    fake.onNotificationClicked.dispatch('not-configured');
    await flushAsync();
    expect(fake.optionsPageOpened).toBe(1);
  });

  it('clicking a result notification does not', async () => {
    await startServiceWorker();
    fake.onNotificationClicked.dispatch(`batch-${BATCH_ID}-secrets`);
    await flushAsync();
    expect(fake.optionsPageOpened).toBe(0);
  });
});
