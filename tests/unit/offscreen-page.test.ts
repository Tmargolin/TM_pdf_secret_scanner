import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChromeFake, FAKE_EXTENSION_ID, flushAsync, type ChromeFake } from '../helpers/chrome-fake.ts';

let fake: ChromeFake;

const isReady = (m: unknown) => typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'OFFSCREEN_READY';

/** Service worker stand-in that answers OFFSCREEN_READY with the given settings. */
const answerWith = (settings: Record<string, unknown>) => async (message: unknown) =>
  isReady(message) ? { type: 'SETTINGS_UPDATED', settings } : undefined;

/** Loads the offscreen page as Chrome would: a fresh module run. */
async function loadOffscreenPage(): Promise<void> {
  vi.resetModules();
  await import('../../src/offscreen/offscreen.ts');
  await flushAsync();
}

const deliver = (message: unknown, sender: object) =>
  fake.onMessage.dispatch(message, sender as chrome.runtime.MessageSender, vi.fn());

beforeEach(() => {
  fake = createChromeFake();
  fake.install();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fake.uninstall();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('offscreen page start-up', () => {
  it('logs that it loaded and asks the service worker for settings', async () => {
    fake.sendMessageHandler = answerWith({ appId: 'abc' });
    await loadOffscreenPage();
    expect(console.info).toHaveBeenCalledWith('[PSS:offscreen] offscreen document loaded');
    expect(fake.sentMessages).toEqual([{ type: 'OFFSCREEN_READY' }]);
    expect(console.info).toHaveBeenCalledWith('[PSS:offscreen] settings received', { configured: true, sites: 1 });
  });

  it('retries, then reports when the service worker never answers', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    await import('../../src/offscreen/offscreen.ts');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.sentMessages).toHaveLength(4); // first attempt + 3 retries
    expect(console.error).toHaveBeenCalledWith('[PSS:offscreen] no settings received from the service worker');
  });
});

describe('pushed settings', () => {
  it('accepts SETTINGS_UPDATED from the service worker without replying', async () => {
    fake.sendMessageHandler = answerWith({});
    await loadOffscreenPage();
    const [returned] = deliver({ type: 'SETTINGS_UPDATED', settings: { appId: 'new-id' } }, { id: FAKE_EXTENSION_ID });
    expect(returned).toBe(false);
    expect(console.info).toHaveBeenCalledWith('[PSS:offscreen] settings updated', { configured: true, sites: 1 });
  });

  it.each([
    ['a content script (has a tab)', { id: FAKE_EXTENSION_ID, tab: { id: 3 } }],
    ['another extension', { id: 'otherextensionidotherextensionid' }],
  ])('ignores settings sent by %s', async (_name, sender) => {
    fake.sendMessageHandler = answerWith({});
    await loadOffscreenPage();
    deliver({ type: 'SETTINGS_UPDATED', settings: { appId: 'evil' } }, sender);
    expect(console.info).not.toHaveBeenCalledWith('[PSS:offscreen] settings updated', expect.anything());
  });
});
