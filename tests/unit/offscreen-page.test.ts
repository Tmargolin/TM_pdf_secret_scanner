import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScanSender } from '../../src/content/scan-sender.ts';
import { createLogger } from '../../src/shared/safe-logger.ts';
import { createChromeFake, FAKE_EXTENSION_ID, flushAsync, type ChromeFake } from '../helpers/chrome-fake.ts';
import { createPortPair } from '../helpers/port-pair.ts';

// The page points pdf.js at its worker file inside the extension. In Node
// pdf.js must keep its own worker set-up, so the page gets a stand-in
// GlobalWorkerOptions; getDocument and PDFWorker stay real.
const workerOptions = vi.hoisted(() => ({ workerSrc: '' }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  GlobalWorkerOptions: workerOptions,
}));

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
  // Never the real API from a test (docs/agents/testing.md).
  vi.stubGlobal('fetch', () => Promise.reject(new Error('the real API must not be called from tests')));
});

afterEach(() => {
  fake.uninstall();
  vi.unstubAllGlobals();
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

describe('scan port (content script → offscreen document, direct)', () => {
  const BATCH_ID = '6a2b3c4d-5555-4666-8777-988899990000';
  const CONTENT_SCRIPT = { id: FAKE_EXTENSION_ID, tab: { id: 7 } as chrome.tabs.Tab, frameId: 0, origin: 'http://localhost:8787' };

  /** A real scan sender whose ports are delivered to the page's onConnect listeners. */
  const contentScript = () =>
    createScanSender({
      connect() {
        const { client, server } = createPortPair(CONTENT_SCRIPT);
        fake.onConnect.dispatch(server as unknown as chrome.runtime.Port);
        return client;
      },
      ensureOffscreen: async () => false,
      reportInterrupted: async () => {},
      log: createLogger('content', { sink: () => {} }),
    });

  const batch = {
    batchId: BATCH_ID,
    requests: [
      {
        type: 'SCAN_REQUEST' as const,
        scanId: '5f1c2a3e-1111-4222-8333-944455556666',
        batchId: BATCH_ID,
        fileName: 'a.pdf',
        size: 3,
        base64: 'YWJj',
      },
    ],
  };

  it('receives the batch and finishes it', async () => {
    fake.sendMessageHandler = answerWith({});
    await loadOffscreenPage();
    expect(fake.onConnect.listeners).toHaveLength(1);
    expect(await contentScript().send(batch)).toBe('done');
    expect(console.info).toHaveBeenCalledWith('[PSS:offscreen] batch received', { files: 1 });
  });

  it('sends one SHOW_RESULT to the service worker before BATCH_DONE', async () => {
    const order: string[] = [];
    fake.sendMessageHandler = async (message) => {
      if ((message as { type?: string }).type === 'SHOW_RESULT') order.push('SHOW_RESULT');
      return answerWith({})(message);
    };
    await loadOffscreenPage();
    await contentScript().send(batch);
    order.push('done');
    expect(order).toEqual(['SHOW_RESULT', 'done']);
    expect(fake.sentMessages).toContainEqual({
      type: 'SHOW_RESULT',
      batchId: BATCH_ID,
      origin: 'http://localhost:8787',
      results: [
        {
          scanId: '5f1c2a3e-1111-4222-8333-944455556666',
          batchId: BATCH_ID,
          fileName: 'a.pdf',
          status: 'error', // no APP-ID in these settings: nothing is extracted or sent
          findings: [],
          errors: [{ code: 'NOT_CONFIGURED' }],
        },
      ],
    });
  });

  it('points pdf.js at the worker file inside the extension', async () => {
    fake.sendMessageHandler = answerWith({});
    await loadOffscreenPage();
    expect(workerOptions.workerSrc).toBe(`chrome-extension://${FAKE_EXTENSION_ID}/offscreen/pdf.worker.mjs`);
  });

  it('not configured: the result says so; dev logs codes only', async () => {
    const bytes = readFileSync(new URL('../fixtures/one-page.pdf', import.meta.url));
    const pdf = {
      type: 'SCAN_REQUEST' as const,
      scanId: '5f1c2a3e-1111-4222-8333-944455556666',
      batchId: BATCH_ID,
      fileName: 'secret-plans.pdf',
      size: bytes.length,
      base64: bytes.toString('base64'),
    };
    fake.sendMessageHandler = answerWith({});
    await loadOffscreenPage();
    await contentScript().send({ batchId: BATCH_ID, requests: [pdf] });
    expect(fake.sentMessages).toContainEqual(
      expect.objectContaining({ type: 'SHOW_RESULT', results: [expect.objectContaining({ fileName: 'secret-plans.pdf', status: 'error' })] }),
    );
    expect(console.debug).toHaveBeenCalledWith('[PSS:offscreen] batch finished', { outcomes: ['NOT_CONFIGURED'] });
    expect(JSON.stringify(vi.mocked(console.debug).mock.calls)).not.toContain('secret-plans');
  });

  it('still finishes the batch when the service worker cannot be reached', async () => {
    fake.sendMessageHandler = async (message) => {
      if ((message as { type?: string }).type === 'SHOW_RESULT') throw new Error('Could not establish connection.');
      return answerWith({})(message);
    };
    await loadOffscreenPage();
    expect(await contentScript().send(batch)).toBe('done');
    expect(console.warn).toHaveBeenCalledWith('[PSS:offscreen] result not delivered to the service worker');
  });

  it('a batch that arrives before the settings waits for them', async () => {
    await loadOffscreenPage(); // the service worker does not answer OFFSCREEN_READY
    let outcome: string | undefined;
    void contentScript()
      .send(batch)
      .then((o) => {
        outcome = o;
      });
    await flushAsync();
    expect(outcome).toBeUndefined();
    expect(console.info).not.toHaveBeenCalledWith('[PSS:offscreen] batch received', expect.anything());

    deliver({ type: 'SETTINGS_UPDATED', settings: {} }, { id: FAKE_EXTENSION_ID });
    await vi.waitFor(() => expect(outcome).toBe('done'), { timeout: 4_000 }); // pdf.js runs now
    expect(console.info).toHaveBeenCalledWith('[PSS:offscreen] batch received', { files: 1 });
  });
});
