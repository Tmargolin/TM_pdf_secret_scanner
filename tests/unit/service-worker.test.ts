import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChromeFake, FAKE_EXTENSION_ID, flushAsync, type ChromeFake } from '../helpers/chrome-fake.ts';

const CONTENT_SCRIPT = { id: FAKE_EXTENSION_ID, tab: { id: 7 } };

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
  vi.spyOn(console, 'info').mockImplementation(() => {});
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
    fake.onInstalled.dispatch();
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

describe('offscreen document page', () => {
  it('logs that it loaded', async () => {
    vi.resetModules();
    await import('../../src/offscreen/offscreen.ts');
    expect(console.info).toHaveBeenCalledWith('[PSS:offscreen] offscreen document loaded');
  });
});
