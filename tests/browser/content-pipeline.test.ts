// Browser-mode test (real Chromium) of the content-script wiring
// (pipeline.ts): files arriving from the MAIN world → what is sent for
// scanning. The test plays the MAIN world: it takes the port the bridge posts
// to the window and sends File objects into it, as the hooks do.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutgoingBatch } from '../../src/content/scan-sender.ts';
import { startContentScript } from '../../src/content/pipeline.ts';
import { HANDOFF_MARKER, LIMITS, parseScanPortMessage } from '../../src/shared/messages.ts';
import { createLogger, type LogLevel } from '../../src/shared/safe-logger.ts';
import { getDefaultSettings, STORAGE_KEY, type SettingsStorage } from '../../src/shared/settings.ts';

const WINDOW_MS = 30;
const MB = 1024 * 1024;

let frame: HTMLIFrameElement;
let win: Window & typeof globalThis;
let batches: OutgoingBatch[];
let lines: { level: LogLevel; line: string }[];

beforeEach(() => {
  frame = document.createElement('iframe');
  document.body.append(frame);
  win = frame.contentWindow as Window & typeof globalThis;
  batches = [];
  lines = [];
});

afterEach(() => frame.remove());

/** Starts the content script; resolves with the port the MAIN world would receive. */
async function start(options: { maxFileSizeMB?: number; storageFails?: boolean; senderFails?: boolean } = {}) {
  const stored: Record<string, unknown> = { [STORAGE_KEY]: { ...getDefaultSettings(false), maxFileSizeMB: options.maxFileSizeMB ?? 25 } };
  const storage: SettingsStorage = {
    get: async (key) => {
      if (options.storageFails) throw new Error('storage unavailable');
      return { [key]: stored[key] };
    },
    set: async () => {},
  };
  const port = new Promise<MessagePort>((resolve) => {
    win.addEventListener('message', (event) => {
      const p = event.ports[0];
      if (p && (event.data as { marker?: unknown } | null)?.marker === HANDOFF_MARKER) resolve(p);
    });
  });
  startContentScript({
    win,
    storage,
    sender: {
      send: async (batch) => {
        if (options.senderFails) throw new Error('offscreen document gone');
        batches.push(batch);
      },
    },
    dev: true,
    log: createLogger('content', { dev: true, sink: (level, line) => void lines.push({ level, line }) }),
    windowMs: WINDOW_MS,
  });
  return port;
}

const pdf = (name: string, size = 0) =>
  new File(['%PDF-1.7 ' + name + (size > 0 ? 'x'.repeat(size) : '')], `${name}.pdf`);
const text = (name: string) => new File(['plain text'], `${name}.txt`);
/** Waits until `check` passes (deliveries are asynchronous; a fixed delay is flaky on busy runs). */
const until = (check: () => void) => vi.waitFor(check, { timeout: 2_000 });
const batchCount = (n: number) => until(() => expect(batches).toHaveLength(n));
/** For "nothing is sent" checks: several batch windows with nothing arriving. */
const quietPeriod = () => new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 150));
const names = (batch: OutgoingBatch | undefined) => batch?.requests.map((r) => r.fileName);

describe('content script: page files → scan batches', () => {
  it('a PDF from the page becomes one valid SCAN_REQUEST batch, with its bytes', async () => {
    const port = await start();
    const file = pdf('report');
    port.postMessage(file);
    await batchCount(1);
    const [request] = batches[0]?.requests ?? [];
    expect(request).toMatchObject({ type: 'SCAN_REQUEST', fileName: 'report.pdf', size: file.size, batchId: batches[0]?.batchId });
    expect(parseScanPortMessage(JSON.parse(JSON.stringify(request)))).not.toBeNull();
    expect(atob((request as { base64: string }).base64)).toBe(await file.text());
  });

  it('files of one action form one batch; non-PDFs are left out', async () => {
    const port = await start();
    for (const file of [pdf('a'), text('notes'), pdf('b'), new File(['fake'], 'fake.pdf')]) port.postMessage(file);
    await batchCount(1);
    expect(batches.map(names)).toEqual([['a.pdf', 'b.pdf']]);
  });

  it('an action without any PDF sends nothing', async () => {
    const port = await start();
    port.postMessage(text('notes'));
    await quietPeriod();
    expect(batches).toEqual([]);
  });

  it('two separate actions become two batches with different ids', async () => {
    const port = await start();
    port.postMessage(pdf('first'));
    await batchCount(1);
    port.postMessage(pdf('second'));
    await batchCount(2);
    expect(batches.map(names)).toEqual([['first.pdf'], ['second.pdf']]);
    expect(batches[0]?.batchId).not.toBe(batches[1]?.batchId);
    const scanIds = batches.flatMap((b) => b.requests.map((r) => r.scanId));
    expect(new Set(scanIds).size).toBe(scanIds.length);
  });

  it('a PDF above maxFileSizeMB is sent without bytes (FILE_TOO_LARGE)', async () => {
    const port = await start({ maxFileSizeMB: 1 });
    port.postMessage(pdf('big', 2 * MB));
    port.postMessage(pdf('small'));
    await batchCount(1);
    const [big, small] = batches[0]?.requests ?? [];
    expect(big).toMatchObject({ fileName: 'big.pdf', skipped: 'FILE_TOO_LARGE' });
    expect(big && 'base64' in big).toBe(false);
    expect(small && 'base64' in small).toBe(true);
  });

  it('storage unreadable: falls back to the protocol limit, still sends', async () => {
    const port = await start({ storageFails: true });
    port.postMessage(pdf('big', 2 * MB));
    await batchCount(1);
    const [request] = batches[0]?.requests ?? [];
    expect(request && 'base64' in request).toBe(true);
    expect(LIMITS.fileBytes).toBeGreaterThan(2 * MB);
  });

  it('anything that is not a File is ignored', async () => {
    const port = await start();
    port.postMessage('text');
    port.postMessage({ name: 'evil.pdf', size: 1 });
    port.postMessage(new Blob(['%PDF-1.7']));
    await quietPeriod();
    expect(batches).toEqual([]);
  });

  it('a failing send is logged, never thrown into the page', async () => {
    const port = await start({ senderFails: true });
    port.postMessage(pdf('x'));
    await until(() =>
      expect(lines.some((l) => l.level === 'error' && l.line === '[PSS:content] files could not be sent for scanning')).toBe(true),
    );
  });

  it('logs counts only, never file names', async () => {
    const port = await start();
    port.postMessage(pdf('secret-plans'));
    port.postMessage(text('notes'));
    await batchCount(1);
    expect(JSON.stringify(lines)).not.toContain('secret-plans');
    expect(lines).toContainEqual({ level: 'debug', line: '[PSS:content] batch from the page' });
  });
});
