import { describe, expect, it } from 'vitest';
import { createBatchReceiver, type ReceivedBatch } from '../../src/offscreen/batch-receiver.ts';
import { LIMITS, type ScanRequest } from '../../src/shared/messages.ts';
import { createLogger, type LogLevel } from '../../src/shared/safe-logger.ts';
import { FAKE_EXTENSION_ID, flushAsync } from '../helpers/chrome-fake.ts';
import { createPortPair } from '../helpers/port-pair.ts';

const BATCH_ID = '6a2b3c4d-5555-4666-8777-988899990000';
const OTHER_BATCH = '7b3c4d5e-6666-4777-8888-999900001111';
const scanId = (n: number) => `5f1c2a3e-1111-4222-8333-${String(n).padStart(12, '0')}`;
const request = (n: number, batchId = BATCH_ID): ScanRequest => ({
  type: 'SCAN_REQUEST',
  scanId: scanId(n),
  batchId,
  fileName: `file-${n}.pdf`,
  size: 3,
  base64: 'YWJj',
});
const end = (fileCount: number) => ({ type: 'BATCH_END', batchId: BATCH_ID, fileCount });

const CONTENT_SCRIPT = {
  id: FAKE_EXTENSION_ID,
  tab: { id: 7 } as chrome.tabs.Tab,
  frameId: 2,
  origin: 'https://mail.google.com',
  url: 'https://mail.google.com/mail/u/0/',
};

/** A receiver with a controllable runBatch, and a client port connected to it. */
function setup(options: { sender?: chrome.runtime.MessageSender | null; name?: string } = {}) {
  const sender = options.sender === undefined ? CONTENT_SCRIPT : (options.sender ?? undefined);
  const runs: ReceivedBatch[] = [];
  const lines: { level: LogLevel; line: string; fields?: Record<string, unknown> }[] = [];
  let finishRun: () => void = () => {};
  let failRun = false;
  const receiver = createBatchReceiver({
    extensionId: FAKE_EXTENSION_ID,
    log: createLogger('offscreen', {
      dev: true,
      sink: (level, line, fields) => void lines.push(fields === undefined ? { level, line } : { level, line, fields }),
    }),
    activity: { begin: () => () => {}, isClosing: () => false },
    runBatch: (batch) => {
      runs.push(batch);
      return new Promise<void>((resolve, reject) => {
        finishRun = () => (failRun ? reject(new Error('extraction failed')) : resolve());
      });
    },
  });
  const { client, server } = createPortPair(sender, options.name);
  const replies: unknown[] = [];
  client.onMessage.addListener((m) => void replies.push(m));
  let clientSawDisconnect = false;
  client.onDisconnect.addListener(() => {
    clientSawDisconnect = true;
  });
  receiver.onConnect(server);
  return {
    client,
    server,
    runs,
    lines,
    replies,
    finish: async () => {
      finishRun();
      await flushAsync();
    },
    failNextRun: () => {
      failRun = true;
    },
    disconnected: () => clientSawDisconnect,
    send: async (...messages: unknown[]) => {
      for (const m of messages) client.postMessage(m);
      await flushAsync();
    },
  };
}

describe('who may connect', () => {
  it('ignores ports with another name (not ours to handle)', async () => {
    const t = setup({ name: 'something-else' });
    await t.send(request(1), end(1));
    expect(t.disconnected()).toBe(false);
    expect(t.runs).toEqual([]);
  });

  it.each([
    ['another extension', { ...CONTENT_SCRIPT, id: 'otherextensionidotherextensionid' }],
    ['an extension page (no tab)', { id: FAKE_EXTENSION_ID, url: `chrome-extension://${FAKE_EXTENSION_ID}/options.html` }],
    ['an unknown sender', null],
    ['a frame without a usable origin', { id: FAKE_EXTENSION_ID, tab: { id: 7 } as chrome.tabs.Tab, origin: 'null' }],
    ['a frame whose URL cannot be parsed', { id: FAKE_EXTENSION_ID, tab: { id: 7 } as chrome.tabs.Tab, url: 'not a url' }],
  ])('refuses %s: closes the port, runs nothing', async (_name, sender) => {
    const t = setup({ sender });
    await t.send(request(1), end(1));
    expect(t.disconnected()).toBe(true);
    expect(t.runs).toEqual([]);
    expect(t.lines).toContainEqual({ level: 'warn', line: '[PSS:offscreen] scan port refused: not from our content script' });
  });

  it('takes tab, frame and origin from port.sender', async () => {
    const t = setup();
    await t.send(request(1), end(1));
    expect(t.runs[0]).toMatchObject({ batchId: BATCH_ID, origin: 'https://mail.google.com', tabId: 7, frameId: 2 });
  });

  it('falls back to the URL when Chrome gives no origin', async () => {
    const { origin: _omit, ...withoutOrigin } = CONTENT_SCRIPT;
    const t = setup({ sender: { ...withoutOrigin, url: 'https://drive.google.com/drive/my-drive' } });
    await t.send(request(1), end(1));
    expect(t.runs[0]?.origin).toBe('https://drive.google.com');
  });
});

describe('a well-formed batch', () => {
  it('answers BATCH_ACCEPTED and runs the batch with all its files', async () => {
    const t = setup();
    await t.send(request(1), request(2), end(2));
    expect(t.replies).toEqual([{ type: 'BATCH_ACCEPTED', batchId: BATCH_ID }]);
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]?.requests).toEqual([request(1), request(2)]);
  });

  it('answers BATCH_DONE only after the run ends, then closes the port', async () => {
    const t = setup();
    await t.send(request(1), end(1));
    expect(t.disconnected()).toBe(false);
    await t.finish();
    expect(t.replies).toEqual([
      { type: 'BATCH_ACCEPTED', batchId: BATCH_ID },
      { type: 'BATCH_DONE', batchId: BATCH_ID },
    ]);
    expect(t.disconnected()).toBe(true);
  });

  it('still answers BATCH_DONE when the run fails, and logs the failure', async () => {
    const t = setup();
    t.failNextRun();
    await t.send(request(1), end(1));
    await t.finish();
    expect(t.replies.at(-1)).toEqual({ type: 'BATCH_DONE', batchId: BATCH_ID });
    expect(t.lines.some((l) => l.level === 'error' && l.line === '[PSS:offscreen] batch failed')).toBe(true);
  });

  it('ignores anything sent after BATCH_END', async () => {
    const t = setup();
    await t.send(request(1), end(1), request(2), end(2));
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]?.requests).toHaveLength(1);
    expect(t.disconnected()).toBe(false);
  });

  it('logs counts only, never file names', async () => {
    const t = setup();
    await t.send(request(1), end(1));
    await t.finish();
    expect(JSON.stringify(t.lines)).not.toContain('file-1.pdf');
  });
});

describe('protocol violations close the port and drop the batch', () => {
  const many = Array.from({ length: LIMITS.filesPerBatch + 1 }, (_, i) => request(i + 1));
  it.each([
    ['an invalid message', [{ type: 'SCAN_REQUEST', batchId: BATCH_ID }], 'invalid message'],
    ['a reply type sent by the page', [{ type: 'BATCH_DONE', batchId: BATCH_ID }], 'invalid message'],
    ['mixed batch ids', [request(1), request(2, OTHER_BATCH)], 'mixed batch ids'],
    ['a repeated scan id', [request(1), request(1)], 'duplicate scan id'],
    ['more than 100 files', many, 'too many files'],
    ['a file count that does not match', [request(1), request(2), end(3)], 'file count mismatch'],
  ])('%s', async (_name, messages, reason) => {
    const t = setup();
    await t.send(...messages);
    expect(t.disconnected()).toBe(true);
    expect(t.runs).toEqual([]);
    expect(t.replies).toEqual([]);
    expect(t.lines).toContainEqual({ level: 'warn', line: '[PSS:offscreen] scan port closed', fields: { reason } });
  });
});

describe('the page goes away', () => {
  it('before BATCH_END: the incomplete batch is dropped', async () => {
    const t = setup();
    await t.send(request(1));
    t.client.disconnect();
    await flushAsync();
    expect(t.runs).toEqual([]);
  });

  it('after BATCH_END: the batch keeps running and finishes quietly', async () => {
    const t = setup();
    await t.send(request(1), end(1));
    t.client.disconnect();
    await flushAsync();
    expect(t.runs).toHaveLength(1);
    await expect(t.finish()).resolves.toBeUndefined(); // BATCH_DONE to a closed port does not throw
    expect(t.server.posted).toEqual([{ type: 'BATCH_ACCEPTED', batchId: BATCH_ID }]); // nobody left to tell
    expect(t.lines.filter((l) => l.level === 'error')).toEqual([]);
  });
});
