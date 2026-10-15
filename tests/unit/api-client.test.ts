// Unit tests of the API client (src/scanner/api-client.ts, DESIGN.md §4, §5).
// fetch is mocked; waits between attempts are recorded instead of slept,
// except where real timing matters (request timeout, abort during a wait) –
// there fake timers are used. Never calls the real API.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abortableSleep,
  backoffMs,
  createApiClient,
  MAX_BACKOFF_MS,
  retryAfterMs,
  type ApiSettings,
} from '../../src/scanner/api-client.ts';
import { createLogger } from '../../src/shared/safe-logger.ts';
import { AWS_EXAMPLE_KEY, FAKE_APP_ID } from '../helpers/fake-secrets.ts';

const SECRET_BODY = readFileSync(new URL('../fixtures/api-secret-aws-example.json', import.meta.url), 'utf8');
const CLEAN_BODY = readFileSync(new URL('../fixtures/api-clean.json', import.meta.url), 'utf8');
const SETTINGS: ApiSettings = { apiUrl: 'https://api.example.test/api/protect', appId: FAKE_APP_ID, requestTimeoutMs: 1000, retries: 2 };
const CHUNK = `page text with ${AWS_EXAMPLE_KEY} inside`;

type Reply = (call: number, init: RequestInit) => Response | Promise<Response>;

const status = (code: number, headers: Record<string, string> = {}) => new Response(code === 413 ? null : 'error body', { status: code, headers });
const ok = (body = SECRET_BODY) => new Response(body, { status: 200 });
/** A request that never answers – it only ends when its signal aborts. */
const hanging = (init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

function setup(reply: Reply, options: { random?: () => number; realSleep?: boolean } = {}) {
  const lines: string[] = [];
  const sleeps: number[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return reply(requests.length - 1, init ?? {});
  });
  const client = createApiClient({
    fetch: fetchMock as unknown as typeof fetch,
    log: createLogger('api', { sink: (level, line, fields) => void lines.push(`${level} ${line} ${JSON.stringify(fields ?? {})}`) }),
    random: options.random ?? (() => 0),
    ...(options.realSleep
      ? {}
      : {
          sleep: async (ms: number) => {
            sleeps.push(Math.round(ms));
          },
        }),
  });
  const scan = (settings: Partial<ApiSettings> = {}, signal = new AbortController().signal) =>
    client.scanChunk(CHUNK, { ...SETTINGS, ...settings }, signal);
  return { scan, requests, sleeps, lines, fetchMock };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the request', () => {
  it('POSTs {"prompt": chunk} as JSON with the APP-ID header, no cookies, no redirects', async () => {
    const t = setup(() => ok());
    await t.scan();
    expect(t.requests).toHaveLength(1);
    const [{ url, init }] = t.requests as [{ url: string; init: RequestInit }];
    expect(url).toBe(SETTINGS.apiUrl);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'APP-ID': FAKE_APP_ID },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(JSON.parse(init.body as string)).toEqual({ prompt: CHUNK });
  });

  it('text with quotes, backslashes, control characters, Hebrew and emoji arrives unchanged', async () => {
    const text = 'say "hi" \\ \u0001 שלום\n😀';
    let sent: unknown;
    const client = createApiClient({
      fetch: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(init.body as string);
        return ok();
      }) as unknown as typeof fetch,
      log: createLogger('api', { sink: () => {} }),
    });
    await client.scanChunk(text, SETTINGS, new AbortController().signal);
    expect(sent).toEqual({ prompt: text });
  });

  it('no APP-ID: NOT_CONFIGURED, and the API is never called', async () => {
    const t = setup(() => ok());
    expect(await t.scan({ appId: '' })).toEqual({ kind: 'error', code: 'NOT_CONFIGURED' });
    expect(t.fetchMock).not.toHaveBeenCalled();
  });
});

describe('answers that are final (no retry)', () => {
  it('200 with secrets → the parsed secrets', async () => {
    expect(await setup(() => ok()).scan()).toEqual({
      kind: 'ok',
      secrets: [{ entityType: 'AWS credentials', category: 'Access Tokens', entity: AWS_EXAMPLE_KEY }],
      characters: 34,
      chunksRequired: 1,
    });
  });

  it('200 clean → no secrets', async () => {
    expect(await setup(() => ok(CLEAN_BODY)).scan()).toMatchObject({ kind: 'ok', secrets: [] });
  });

  it.each([
    ['401', () => status(401), { kind: 'error', code: 'API_UNAUTHORIZED' }],
    ['413', () => status(413), { kind: 'too-large' }],
    ['400', () => status(400), { kind: 'error', code: 'API_HTTP_ERROR', detail: '400' }],
    ['403', () => status(403), { kind: 'error', code: 'API_HTTP_ERROR', detail: '403' }],
    ['404', () => status(404), { kind: 'error', code: 'API_HTTP_ERROR', detail: '404' }],
    ['200, not JSON', () => ok('<html>maintenance</html>'), { kind: 'error', code: 'API_BAD_RESPONSE' }],
    ['200, status "failed"', () => ok('{"status":"failed","result":null}'), { kind: 'error', code: 'API_BAD_RESPONSE' }],
  ] as const)('%s → %j after one call', async (_name, reply, expected) => {
    const t = setup(reply);
    expect(await t.scan()).toEqual(expected);
    expect(t.requests).toHaveLength(1);
    expect(t.sleeps).toEqual([]);
  });
});

describe('retries (429, 5xx, network errors, timeouts)', () => {
  it.each([429, 500, 502, 503, 504, 599])('%i, then 200 → the 200 result after one retry', async (code) => {
    const t = setup((call) => (call === 0 ? status(code) : ok()));
    expect(await t.scan()).toMatchObject({ kind: 'ok', secrets: [{ entity: AWS_EXAMPLE_KEY }] });
    expect(t.requests).toHaveLength(2);
    expect(t.sleeps).toEqual([500]);
  });

  it('always 503: 1 + retries calls with doubling waits, then API_HTTP_ERROR "503"', async () => {
    const t = setup(() => status(503));
    expect(await t.scan({ retries: 3 })).toEqual({ kind: 'error', code: 'API_HTTP_ERROR', detail: '503' });
    expect(t.requests).toHaveLength(4);
    expect(t.sleeps).toEqual([500, 1000, 2000]);
  });

  it('retries 0: one call only', async () => {
    const t = setup(() => status(500));
    expect(await t.scan({ retries: 0 })).toEqual({ kind: 'error', code: 'API_HTTP_ERROR', detail: '500' });
    expect(t.requests).toHaveLength(1);
  });

  it('no connection (fetch throws) → retried, then API_UNREACHABLE', async () => {
    const t = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await t.scan()).toEqual({ kind: 'error', code: 'API_UNREACHABLE' });
    expect(t.requests).toHaveLength(3);
  });

  it('a network error, then 200 → the 200 result', async () => {
    const t = setup((call) => {
      if (call === 0) throw new TypeError('Failed to fetch');
      return ok();
    });
    expect(await t.scan()).toMatchObject({ kind: 'ok' });
  });

  it('no answer within requestTimeoutMs → the request is aborted, retried, then API_TIMEOUT', async () => {
    vi.useFakeTimers();
    const t = setup((_call, init) => hanging(init));
    const result = t.scan({ requestTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(3 * 1000);
    expect(await result).toEqual({ kind: 'error', code: 'API_TIMEOUT' });
    expect(t.requests).toHaveLength(3);
    expect(t.requests.every((r) => r.init.signal?.aborted)).toBe(true);
  });

  it('a timeout while reading the body counts as a timeout too', async () => {
    vi.useFakeTimers();
    const slowBody = (init: RequestInit) =>
      ({ status: 200, headers: new Headers(), body: null, json: () => hanging(init) }) as unknown as Response;
    const t = setup((call, init) => (call === 0 ? slowBody(init) : ok()));
    const result = t.scan({ requestTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ kind: 'ok' });
    expect(t.requests).toHaveLength(2);
  });

  it('jitter adds up to 25 % to the wait', async () => {
    const t = setup(() => status(503), { random: () => 0.999 });
    await t.scan({ retries: 2 });
    expect(t.sleeps).toEqual([625, 1250]); // 500 × 1.25 and 1000 × 1.25, rounded
  });

  it('Retry-After longer than the back-off wins; a shorter one does not', async () => {
    const longer = setup((call) => (call === 0 ? status(429, { 'Retry-After': '3' }) : ok()));
    await longer.scan();
    expect(longer.sleeps).toEqual([3000]);
    const shorter = setup((call) => (call === 0 ? status(503, { 'Retry-After': '0' }) : ok()));
    await shorter.scan();
    expect(shorter.sleeps).toEqual([500]);
  });

  it(`waits are capped at ${MAX_BACKOFF_MS} ms, whatever Retry-After says`, async () => {
    const t = setup((call) => (call === 0 ? status(429, { 'Retry-After': '3600' }) : ok()));
    await t.scan();
    expect(t.sleeps).toEqual([MAX_BACKOFF_MS]);
  });
});

describe('the job timing out (its signal aborts)', () => {
  it('during a request: the request is aborted and the call rejects', async () => {
    const t = setup((_call, init) => hanging(init));
    const job = new AbortController();
    const result = t.scan({ requestTimeoutMs: 60_000 }, job.signal);
    await vi.waitFor(() => expect(t.requests).toHaveLength(1));
    job.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.requests[0]?.init.signal?.aborted).toBe(true);
  });

  it('during the wait before a retry: rejects at once, no further request', async () => {
    vi.useFakeTimers();
    const t = setup(() => status(503), { realSleep: true });
    const job = new AbortController();
    const result = t.scan({}, job.signal);
    result.catch(() => {});
    await vi.advanceTimersByTimeAsync(100); // first answer arrived, now waiting 500 ms
    job.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.requests).toHaveLength(1);
  });

  it('already aborted: rejects without calling the API', async () => {
    const t = setup(() => ok());
    const job = new AbortController();
    job.abort();
    await expect(t.scan({}, job.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.fetchMock).not.toHaveBeenCalled();
  });
});

describe('logging', () => {
  it('codes and statuses only – never the text, the APP-ID or a secret', async () => {
    const t = setup((call) => [status(503), status(429), ok()][call] ?? ok());
    await t.scan();
    const all = t.lines.join('\n');
    expect(all).toContain('API request will be retried');
    expect(all).not.toContain(AWS_EXAMPLE_KEY);
    expect(all).not.toContain(FAKE_APP_ID);
    expect(all).not.toContain('page text');
  });

  it('warns when the server would have preferred smaller chunks (chunks_required > 1)', async () => {
    const big = JSON.parse(CLEAN_BODY) as { result: { prompt: { findings: { 'Token Limitation': { chunks_required: number }[] } } } };
    (big.result.prompt.findings['Token Limitation'][0] as { chunks_required: number }).chunks_required = 3;
    const t = setup(() => ok(JSON.stringify(big)));
    await t.scan();
    expect(t.lines).toContain('warn [PSS:api] chunk larger than the server prefers {"chunksRequired":3}');
  });

  it('a final failure is logged as a warning with its code and status', async () => {
    const t = setup(() => status(503));
    await t.scan({ retries: 1 });
    expect(t.lines).toContain('warn [PSS:api] API request failed after retries {"code":"API_HTTP_ERROR","attempts":2,"status":"503"}');
  });
});

describe('helpers', () => {
  it('retryAfterMs: seconds, an HTTP date, or nothing', () => {
    const now = Date.parse('2026-10-15T10:00:00Z');
    expect(retryAfterMs('3', now)).toBe(3000);
    expect(retryAfterMs('0', now)).toBe(0);
    expect(retryAfterMs('Thu, 15 Oct 2026 10:00:05 GMT', now)).toBe(5000);
    expect(retryAfterMs('Thu, 15 Oct 2026 09:00:00 GMT', now)).toBe(0); // in the past
    for (const bad of [null, '', '  ', '-1', 'soon']) expect(retryAfterMs(bad, now)).toBeNull();
  });

  it('backoffMs: 0.5 s doubling, + jitter, server delay if longer, at most 10 s', () => {
    const noJitter = () => 0;
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, noJitter))).toEqual([500, 1000, 2000, 4000, 8000, 10_000]);
    expect(backoffMs(1, () => 0.5)).toBe(562.5);
    expect(backoffMs(1, noJitter, 3000)).toBe(3000);
    expect(backoffMs(1, noJitter, 20_000)).toBe(MAX_BACKOFF_MS);
  });

  it('abortableSleep resolves after the time, or rejects at once on abort', async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void abortableSleep(500, new AbortController().signal).then(done);
    await vi.advanceTimersByTimeAsync(499);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();

    const controller = new AbortController();
    const waiting = abortableSleep(10_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0); // its timer was cleared

    await expect(abortableSleep(10, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
