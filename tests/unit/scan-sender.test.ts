import { describe, expect, it } from 'vitest';
import { createScanSender, type OutgoingBatch } from '../../src/content/scan-sender.ts';
import type { ScanRequest } from '../../src/shared/messages.ts';
import { createLogger, type LogLevel } from '../../src/shared/safe-logger.ts';
import { createPortPair, type FakePort } from '../helpers/port-pair.ts';

const BATCH_ID = '6a2b3c4d-5555-4666-8777-988899990000';
const OTHER_BATCH = '7b3c4d5e-6666-4777-8888-999900001111';

const request = (n: number): ScanRequest => ({
  type: 'SCAN_REQUEST',
  scanId: `5f1c2a3e-1111-4222-8333-94445555666${n}`,
  batchId: BATCH_ID,
  fileName: `file-${n}.pdf`,
  size: 3,
  base64: 'YWJj',
});
const BATCH: OutgoingBatch = { batchId: BATCH_ID, requests: [request(1), request(2)] };

/** How the simulated offscreen document behaves on one connection. */
type Offscreen = (server: FakePort) => void;

/** Answers like the real receiver: ACCEPTED after BATCH_END, then DONE and close. */
const healthy: Offscreen = (server) => {
  server.onMessage.addListener((m) => {
    if ((m as { type?: string }).type !== 'BATCH_END') return;
    server.postMessage({ type: 'BATCH_ACCEPTED', batchId: BATCH_ID });
    setTimeout(() => {
      server.postMessage({ type: 'BATCH_DONE', batchId: BATCH_ID });
      server.disconnect();
    }, 0);
  });
};
/** No offscreen document: Chrome closes the port right away. */
const missing: Offscreen = (server) => queueMicrotask(() => server.disconnect());
/** Closing document (D42): rejects on the first message and closes. */
const closing: Offscreen = (server) => {
  server.onMessage.addListener(() => {
    server.postMessage({ type: 'BATCH_REJECTED', batchId: BATCH_ID, reason: 'closing' });
    server.disconnect();
  });
};
/** Accepts the batch, then dies before finishing it. */
const diesAfterAccept: Offscreen = (server) => {
  server.onMessage.addListener((m) => {
    if ((m as { type?: string }).type !== 'BATCH_END') return;
    server.postMessage({ type: 'BATCH_ACCEPTED', batchId: BATCH_ID });
    setTimeout(() => server.disconnect(), 0);
  });
};

function setup(connections: Offscreen[], options: { ensureOk?: boolean; reportFails?: boolean; connectThrows?: boolean } = {}) {
  const clients: FakePort[] = [];
  const servers: FakePort[] = [];
  const reports: { batchId: string; fileNames: string[] }[] = [];
  const lines: { level: LogLevel; line: string }[] = [];
  let ensureCalls = 0;
  const sender = createScanSender({
    connect() {
      if (options.connectThrows) throw new Error('Extension context invalidated.');
      const { client, server } = createPortPair();
      const behave = connections[clients.length] ?? missing;
      clients.push(client);
      servers.push(server);
      behave(server);
      return client;
    },
    async ensureOffscreen() {
      ensureCalls++;
      return options.ensureOk ?? true;
    },
    async reportInterrupted(batchId, fileNames) {
      if (options.reportFails) throw new Error('no service worker');
      reports.push({ batchId, fileNames });
    },
    log: createLogger('content', { dev: true, sink: (level, line) => void lines.push({ level, line }) }),
  });
  return { sender, clients, servers, reports, lines, ensureCalls: () => ensureCalls };
}

describe('sending a batch', () => {
  it('posts every file, then BATCH_END, on one port', async () => {
    const t = setup([healthy]);
    await t.sender.send(BATCH);
    expect(t.clients).toHaveLength(1);
    expect(t.clients[0]?.posted).toEqual([
      request(1),
      request(2),
      { type: 'BATCH_END', batchId: BATCH_ID, fileCount: 2 },
    ]);
  });

  it('finishes on BATCH_DONE without retrying or reporting', async () => {
    const t = setup([healthy]);
    expect(await t.sender.send(BATCH)).toBe('done');
    expect(t.ensureCalls()).toBe(0);
    expect(t.reports).toEqual([]);
  });

  it('closes its own end after BATCH_DONE', async () => {
    const t = setup([
      (server) =>
        server.onMessage.addListener((m) => {
          if ((m as { type?: string }).type === 'BATCH_END') {
            server.postMessage({ type: 'BATCH_ACCEPTED', batchId: BATCH_ID });
            server.postMessage({ type: 'BATCH_DONE', batchId: BATCH_ID }); // offscreen keeps the port open
          }
        }),
    ]);
    expect(await t.sender.send(BATCH)).toBe('done');
    expect(t.clients[0]?.closed).toBe(true);
  });
});

describe('self-healing (D35)', () => {
  it('port closes before BATCH_ACCEPTED → ENSURE_OFFSCREEN, then one resend succeeds', async () => {
    const t = setup([missing, healthy]);
    expect(await t.sender.send(BATCH)).toBe('done');
    expect(t.ensureCalls()).toBe(1);
    expect(t.clients).toHaveLength(2);
    expect(t.clients[1]?.posted).toHaveLength(3); // the whole batch again
    expect(t.reports).toEqual([]);
  });

  it('BATCH_REJECTED (document closing) → ENSURE_OFFSCREEN, then the resend succeeds', async () => {
    const t = setup([closing, healthy]);
    expect(await t.sender.send(BATCH)).toBe('done');
    expect(t.ensureCalls()).toBe(1);
    expect(t.clients).toHaveLength(2);
    expect(t.reports).toEqual([]);
  });

  it('never accepted after 3 resends → SCAN_INTERRUPTED, no fifth try', async () => {
    const t = setup([missing, missing, missing, missing]);
    expect(await t.sender.send(BATCH)).toBe('interrupted');
    expect(t.clients).toHaveLength(4);
    expect(t.reports).toEqual([{ batchId: BATCH_ID, fileNames: ['file-1.pdf', 'file-2.pdf'] }]);
  });

  it('service worker cannot create the document → no resend, SCAN_INTERRUPTED', async () => {
    const t = setup([missing, healthy], { ensureOk: false });
    expect(await t.sender.send(BATCH)).toBe('interrupted');
    expect(t.clients).toHaveLength(1);
    expect(t.reports).toHaveLength(1);
  });

  it('closes after BATCH_ACCEPTED but before BATCH_DONE → SCAN_INTERRUPTED without resending', async () => {
    const t = setup([diesAfterAccept, healthy]);
    expect(await t.sender.send(BATCH)).toBe('interrupted');
    expect(t.ensureCalls()).toBe(0);
    expect(t.clients).toHaveLength(1);
    expect(t.reports).toHaveLength(1);
  });

  it('a content script whose extension was reloaded (connect throws) reports instead of throwing', async () => {
    const t = setup([], { connectThrows: true });
    expect(await t.sender.send(BATCH)).toBe('interrupted');
    expect(t.ensureCalls()).toBe(3);
  });

  it('still resolves when the interruption cannot be reported', async () => {
    const t = setup([missing, missing], { reportFails: true });
    expect(await t.sender.send(BATCH)).toBe('interrupted');
  });

  it('logs the interruption with counts only', async () => {
    const t = setup([missing, missing]);
    await t.sender.send(BATCH);
    expect(t.lines.filter((l) => l.level === 'warn').map((l) => l.line)).toEqual(['[PSS:content] batch interrupted']);
    expect(JSON.stringify(t.lines)).not.toContain('file-1.pdf');
  });
});

describe('reply validation', () => {
  it('ignores malformed replies and replies for another batch', async () => {
    const t = setup([
      (server) =>
        server.onMessage.addListener((m) => {
          if ((m as { type?: string }).type !== 'BATCH_END') return;
          server.postMessage({ type: 'BATCH_DONE', batchId: OTHER_BATCH }); // not ours
          server.postMessage({ type: 'BATCH_DONE' }); // malformed
          server.postMessage('BATCH_DONE');
          server.postMessage({ type: 'BATCH_ACCEPTED', batchId: OTHER_BATCH });
          setTimeout(() => server.disconnect(), 0); // so the batch was never accepted
        }),
      healthy,
    ]);
    expect(await t.sender.send(BATCH)).toBe('done');
    expect(t.clients).toHaveLength(2); // treated as "not accepted" → resent
  });

  it('a BATCH_DONE for this batch finishes it even without BATCH_ACCEPTED', async () => {
    const t = setup([
      (server) =>
        server.onMessage.addListener((m) => {
          if ((m as { type?: string }).type === 'BATCH_END') server.postMessage({ type: 'BATCH_DONE', batchId: BATCH_ID });
        }),
    ]);
    expect(await t.sender.send(BATCH)).toBe('done');
  });

  it('a port closed by the other end at once counts as not accepted', async () => {
    const t = setup([(server) => server.disconnect(), healthy]);
    expect(await t.sender.send(BATCH)).toBe('done');
  });
});
