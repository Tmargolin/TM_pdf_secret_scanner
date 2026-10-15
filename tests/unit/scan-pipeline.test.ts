// End-to-end test of the scan pipeline in Node (DESIGN.md §4, §4.1):
// real job registry, real pdf.js extraction, real scan job, chunker,
// splitter, limiter and API client – only fetch is mocked (a fake API that
// behaves like the recorded one: finds AWS-format keys, reports how many
// characters it took, can be told to scan less, fail or hang).
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPdf } from '../../scripts/make-fixtures.ts';
import type { ReceivedBatch } from '../../src/offscreen/batch-receiver.ts';
import { createExtractor } from '../../src/offscreen/extractor.ts';
import { createJobRegistry } from '../../src/offscreen/jobs.ts';
import { outcomeCode } from '../../src/offscreen/results.ts';
import { createScanJob } from '../../src/offscreen/scan-job.ts';
import { createApiClient } from '../../src/scanner/api-client.ts';
import { createApiLimiter } from '../../src/scanner/api-limiter.ts';
import { createChunkSizer } from '../../src/scanner/splitter.ts';
import type { ScanRequest } from '../../src/shared/messages.ts';
import { createLogger } from '../../src/shared/safe-logger.ts';
import { getDefaultSettings, type Settings } from '../../src/shared/settings.ts';
import type { ScanResult } from '../../src/shared/types.ts';
import { AWS_EXAMPLE_KEY, FAKE_APP_ID } from '../helpers/fake-secrets.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

interface FakeApiOptions {
  /** The API scans (and reports) only this many characters of each request. */
  cap?: number;
  /** Answer every request with this status instead. */
  status?: number;
  /** Never answer (until the request is aborted). */
  hang?: boolean;
  /** Delay before answering, ms. */
  latencyMs?: number;
}

/** A fake of the Prompt Security API on top of a mocked fetch. */
function fakeApi(options: FakeApiOptions = {}) {
  const state = { calls: 0, inFlight: 0, peak: 0, aborted: 0, bodies: [] as string[] };
  const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    state.calls++;
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      const body = String(init?.body);
      state.bodies.push(body);
      if (options.hang || options.latencyMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = options.hang ? undefined : setTimeout(resolve, options.latencyMs);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            state.aborted++;
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      if (options.status) return new Response('error', { status: options.status });
      const prompt = (JSON.parse(body) as { prompt: string }).prompt;
      const scanned = [...prompt].slice(0, options.cap ?? Number.POSITIVE_INFINITY).join('');
      const keys = [...new Set(scanned.match(/\bAKIA[A-Z2-7]{16}\b/g) ?? [])];
      const findings = {
        ...(keys.length > 0 ? { Secrets: keys.map((entity) => ({ category: 'Access Tokens', entity, entity_type: 'AWS credentials' })) } : {}),
        'Token Limitation': [{ characters: [...scanned].length, chunks_required: 1 }],
      };
      return new Response(JSON.stringify({ status: 'success', result: { prompt: { findings } } }), { status: 200 });
    } finally {
      state.inFlight--;
    }
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, state };
}

const workers: InstanceType<typeof pdfjs.PDFWorker>[] = [];
afterEach(() => {
  workers.splice(0).forEach((w) => w.destroy());
});

/** The offscreen document's wiring (offscreen.ts), with a fake API and adjustable settings. */
function pipeline(api: ReturnType<typeof fakeApi>, overrides: Partial<Settings> = {}, limits: { jobTimeoutMs?: number } = {}) {
  const lines: string[] = [];
  const log = createLogger('offscreen', { sink: (level, line, fields) => void lines.push(`${level} ${line} ${JSON.stringify(fields ?? {})}`) });
  const settings: Settings = { ...getDefaultSettings(false), appId: FAKE_APP_ID, retries: 0, ...overrides };
  const extractor = createExtractor({
    pdfjs,
    createWorker: () => {
      const worker = new pdfjs.PDFWorker({ verbosity: 0 });
      workers.push(worker);
      return worker;
    },
    maxParallel: () => settings.maxParallelExtractions,
  });
  let extractions = 0;
  const sizer = createChunkSizer();
  const runJob = createScanJob({
    extract: (bytes, signal) => {
      extractions++;
      return extractor.extract(bytes, signal);
    },
    api: createApiClient({ fetch: api.fetch, log, sleep: async () => {} }),
    limiter: createApiLimiter(() => settings.maxConcurrency),
    sizer,
    settings: () => settings,
    log,
  });
  const jobs = createJobRegistry({ limits: () => ({ ...settings, ...limits }), runJob, log });
  let next = 0;
  const id = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
  const submit = (files: [string, Uint8Array][], tabId = 1): Promise<ScanResult[]> => {
    const batchId = id();
    const requests: ScanRequest[] = files.map(([fileName, bytes]) => ({
      type: 'SCAN_REQUEST',
      scanId: id(),
      batchId,
      fileName,
      size: bytes.length,
      base64: Buffer.from(bytes).toString('base64'),
    }));
    const batch: ReceivedBatch = { batchId, origin: 'https://site.example', tabId, frameId: 0, requests };
    return jobs.submitBatch(batch);
  };
  return { submit, settings, sizer, lines, extractions: () => extractions };
}

/**
 * A PDF of `pages` pages with ~`chars` characters of words each, in lines of
 * ~60 characters (pdf.js drops text drawn past the page edge, so no long
 * lines; ≤ 50 lines fit a page); the key on its own line on page `keyPage`.
 */
function bigPdf(pages: number, chars: number, keyPage?: number): Uint8Array {
  return buildPdf(
    Array.from({ length: pages }, (_, p) => {
      const lines = Array.from({ length: Math.min(50, Math.ceil(chars / 60)) }, (_, l) =>
        Array.from({ length: 6 }, (_, w) => `p${p}l${l}w${w}`).join(' '),
      );
      return p + 1 === keyPage ? [...lines.slice(0, -1), `key ${AWS_EXAMPLE_KEY}`] : lines;
    }),
  );
}

describe('the pipeline on the sample PDFs', () => {
  it('each file gets its own outcome, in the batch order', async () => {
    const p = pipeline(fakeApi());
    const names = ['one-page.pdf', 'multi-page.pdf', 'encrypted.pdf', 'no-text.pdf', 'split-token.pdf', 'owner-password-only.pdf'];
    const results = await p.submit(names.map((name) => [name, fixture(name)]));
    expect(results.map((r) => r.fileName)).toEqual(names);
    expect(results.map(outcomeCode)).toEqual(['clean', 'secrets:1', 'PDF_ENCRYPTED', 'NO_TEXT_LAYER', 'secrets:1', 'clean']);
  });

  it('a secret: masked value, its page, and stats', async () => {
    const [result] = await pipeline(fakeApi()).submit([['multi-page.pdf', fixture('multi-page.pdf')]]);
    expect(result).toMatchObject({
      status: 'secrets',
      findings: [{ entityType: 'AWS credentials', category: 'Access Tokens', masked: 'AKIA…LE', pages: [2] }],
      errors: [],
      stats: { pages: 3, chunks: 1, failedChunks: 0, truncated: false },
    });
    expect(result?.stats?.textChars).toBe(result?.stats?.scannedChars);
  });

  it('a clean file: status clean, no notification-worthy errors, stats present', async () => {
    const [result] = await pipeline(fakeApi()).submit([['one-page.pdf', fixture('one-page.pdf')]]);
    expect(result).toMatchObject({ status: 'clean', findings: [], errors: [], stats: { pages: 1, chunks: 1 } });
  });

  it('no plain secret and no page text ever appears in a result or a log line', async () => {
    const p = pipeline(fakeApi());
    const results = await p.submit([['multi-page.pdf', fixture('multi-page.pdf')], ['split-token.pdf', fixture('split-token.pdf')]]);
    const everything = JSON.stringify(results) + p.lines.join('\n');
    expect(everything).not.toContain(AWS_EXAMPLE_KEY);
    expect(everything).not.toContain('configuration');
    expect(p.lines.some((l) => l.includes('file scanned {"pageCount":3'))).toBe(true);
  });
});

describe('not configured', () => {
  it('no APP-ID: NOT_CONFIGURED for every file – nothing extracted, nothing sent', async () => {
    const api = fakeApi();
    const p = pipeline(api, { appId: '' });
    const results = await p.submit([['multi-page.pdf', fixture('multi-page.pdf')], ['one-page.pdf', fixture('one-page.pdf')]]);
    expect(results.map(outcomeCode)).toEqual(['NOT_CONFIGURED', 'NOT_CONFIGURED']);
    expect(results[0]?.stats).toBeUndefined();
    expect(api.state.calls).toBe(0);
    expect(p.extractions()).toBe(0);
  });
});

describe('concurrent jobs', () => {
  it('many chunks from several tabs never exceed maxConcurrency calls in flight', async () => {
    const api = fakeApi({ latencyMs: 5 });
    const p = pipeline(api, { maxConcurrency: 3, chunkSize: 500 });
    const tabs = [1, 2, 3].map((tab) => p.submit([[`big-${tab}.pdf`, bigPdf(6, 900)], [`one-${tab}.pdf`, fixture('one-page.pdf')]], tab));
    const results = (await Promise.all(tabs)).flat();
    expect(results.every((r) => r.status === 'clean')).toBe(true);
    expect(api.state.calls).toBeGreaterThan(20);
    expect(api.state.peak).toBe(3);
  });

  it('a small file sent after a big one is not stuck behind it (round-robin)', async () => {
    const api = fakeApi({ latencyMs: 3 });
    const p = pipeline(api, { maxConcurrency: 2, chunkSize: 500 });
    const finished: string[] = [];
    const big = p.submit([['big.pdf', bigPdf(40, 900)]], 1).then(() => finished.push('big')); // ~120 calls
    await new Promise((resolve) => setTimeout(resolve, 30)); // the big file is being scanned
    const small = p.submit([['small.pdf', fixture('multi-page.pdf')]], 2).then((r) => {
      finished.push('small');
      return r;
    });
    const [[smallResult]] = await Promise.all([small, big]);
    expect(finished).toEqual(['small', 'big']);
    expect(smallResult?.status).toBe('secrets');
  });

  it('one file whose API calls fail does not affect the others', async () => {
    const good = fakeApi();
    const flaky: typeof globalThis.fetch = async (url, init) =>
      String(init?.body).includes('Page two') ? new Response('error', { status: 500 }) : good.fetch(url, init);
    const p = pipeline({ fetch: flaky, state: good.state });
    const results = await p.submit([['multi-page.pdf', fixture('multi-page.pdf')], ['one-page.pdf', fixture('one-page.pdf')]]);
    expect(results.map(outcomeCode)).toEqual(['API_HTTP_ERROR', 'clean']);
  });
});

describe('partial scans are never clean', () => {
  it('text above maxTextChars: the key beyond the limit is missed → TEXT_TRUNCATED, status error', async () => {
    const p = pipeline(fakeApi(), { maxTextChars: 10_000 });
    const [result] = await p.submit([['long.pdf', bigPdf(30, 900, 30)]]);
    expect(result).toMatchObject({ status: 'error', errors: [{ code: 'TEXT_TRUNCATED' }], findings: [], stats: { truncated: true, scannedChars: 10_000 } });
    expect(result?.stats?.textChars).toBeGreaterThan(20_000);
  });

  it('a key before the limit is still reported: secrets + TEXT_TRUNCATED', async () => {
    const [result] = await pipeline(fakeApi(), { maxTextChars: 10_000 }).submit([['long.pdf', bigPdf(30, 900, 2)]]);
    expect(result).toMatchObject({ status: 'secrets', errors: [{ code: 'TEXT_TRUNCATED' }], findings: [{ masked: 'AKIA…LE', pages: [2] }] });
  });

  it('API errors: failed chunks are counted, the file is not clean', async () => {
    const [result] = await pipeline(fakeApi({ status: 503 })).submit([['one-page.pdf', fixture('one-page.pdf')]]);
    expect(result).toMatchObject({ status: 'error', errors: [{ code: 'API_HTTP_ERROR', detail: '503' }], stats: { failedChunks: 1 } });
  });

  it('a rejected APP-ID → API_UNAUTHORIZED', async () => {
    const [result] = await pipeline(fakeApi({ status: 401 })).submit([['one-page.pdf', fixture('one-page.pdf')]]);
    expect(outcomeCode(result as ScanResult)).toBe('API_UNAUTHORIZED');
  });
});

describe('the API scanning less than it was sent', () => {
  it('chunks are split until fully scanned; the key at the end is found; later files use the smaller size', async () => {
    const api = fakeApi({ cap: 4_000 });
    const p = pipeline(api, { chunkSize: 20_000 });
    const [first] = await p.submit([['long.pdf', bigPdf(12, 900, 12)]]);
    expect(first).toMatchObject({ status: 'secrets', errors: [], findings: [{ pages: [12] }] });
    expect(p.sizer.effective(20_000)).toBeLessThanOrEqual(4_000);
    const callsBefore = api.state.calls;
    const [second] = await p.submit([['long-again.pdf', bigPdf(12, 900, 12)]]);
    expect(second?.status).toBe('secrets');
    const bodies = api.state.bodies.slice(callsBefore).map((b) => [...(JSON.parse(b) as { prompt: string }).prompt].length);
    expect(Math.max(...bodies)).toBeLessThanOrEqual(4_000); // no cut-short calls any more
  });

  it('below the floor: CHUNK_TOO_LARGE, never clean', async () => {
    const [result] = await pipeline(fakeApi({ cap: 300 })).submit([['one-page.pdf', bigPdf(1, 1500)]]);
    expect(result).toMatchObject({ status: 'error', errors: [{ code: 'CHUNK_TOO_LARGE' }] });
  });
});

describe('job timeout', () => {
  it('a hanging API: SCAN_TIMEOUT for that file, its requests aborted, the other file finishes', async () => {
    const hanging = fakeApi({ hang: true });
    const good = fakeApi();
    const routed: typeof globalThis.fetch = (url, init) => (String(init?.body).includes('Page two') ? hanging.fetch(url, init) : good.fetch(url, init));
    // 2 s: room for pdf.js to start in a slow test run; the hanging file can never finish.
    const p = pipeline({ fetch: routed, state: good.state }, { requestTimeoutMs: 60_000 }, { jobTimeoutMs: 2_000 });
    const results = await p.submit([['multi-page.pdf', fixture('multi-page.pdf')], ['one-page.pdf', fixture('one-page.pdf')]]);
    expect(results.map(outcomeCode)).toEqual(['SCAN_TIMEOUT', 'clean']);
    await expect.poll(() => hanging.state.aborted).toBe(1);
  }, 10_000);
});
