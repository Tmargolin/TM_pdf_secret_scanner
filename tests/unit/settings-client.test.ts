import { afterEach, describe, expect, it } from 'vitest';
import { createSettingsClient, DEFAULT_RETRY_DELAYS_MS } from '../../src/offscreen/settings-client.ts';
import { clearRegisteredSecrets, createLogger, sanitizeString, type LogLevel } from '../../src/shared/safe-logger.ts';
import { getDefaultSettings } from '../../src/shared/settings.ts';

const reply = (settings: Record<string, unknown> = {}) => ({ type: 'SETTINGS_UPDATED', settings });

/** Client with a scripted service worker: each request returns or throws the next item. */
function setup(answers: unknown[], retryDelaysMs?: readonly number[]) {
  const lines: { level: LogLevel; line: string; fields?: Record<string, unknown> }[] = [];
  const slept: number[] = [];
  let requests = 0;
  const client = createSettingsClient({
    dev: true,
    log: createLogger('offscreen', {
      sink: (level, line, fields) => void lines.push(fields ? { level, line, fields } : { level, line }),
    }),
    sleep: async (ms) => void slept.push(ms),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    requestSettings: async () => {
      const answer = answers[requests];
      requests += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { client, lines, slept, requests: () => requests };
}

afterEach(() => clearRegisteredSecrets());

describe('start', () => {
  it('uses the first valid reply and makes the settings ready', async () => {
    const { client, lines, requests } = setup([reply({ appId: 'abc' })]);
    const ready = client.ready();
    expect(client.current()).toBeNull();
    await client.start();
    expect(await ready).toEqual({ ...getDefaultSettings(true), appId: 'abc' });
    expect(client.current()?.appId).toBe('abc');
    expect(requests()).toBe(1);
    expect(lines).toEqual([
      { level: 'info', line: '[PSS:offscreen] settings received', fields: { configured: true, sites: 1 } },
    ]);
  });

  it('retries after 0.5, 2 and 5 seconds by default', async () => {
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([500, 2_000, 5_000]);
    const { client, slept, requests } = setup([new Error('no service worker'), undefined, { junk: true }, reply()]);
    await client.start();
    expect(slept).toEqual([500, 2_000, 5_000]);
    expect(requests()).toBe(4);
    expect(client.current()).not.toBeNull();
  });

  it('logs an error and stays not-ready when every attempt fails', async () => {
    const { client, lines, requests } = setup([undefined, new Error('x'), { type: 'SHOW_RESULT' }], [1, 1]);
    await client.start();
    expect(requests()).toBe(3);
    expect(client.current()).toBeNull();
    expect(lines).toEqual([{ level: 'error', line: '[PSS:offscreen] no settings received from the service worker' }]);
  });

  it('stops asking once a pushed update has arrived', async () => {
    let client: ReturnType<typeof createSettingsClient>;
    let requests = 0;
    client = createSettingsClient({
      dev: true,
      log: createLogger('offscreen', { sink: () => {} }),
      retryDelaysMs: [1, 1],
      // The push arrives while the first request is still unanswered.
      sleep: async () => void client.accept(reply({ appId: 'pushed' })),
      requestSettings: async () => {
        requests += 1;
        return undefined;
      },
    });
    await client.start();
    expect(requests).toBe(1);
    expect(client.current()?.appId).toBe('pushed');
  });

  it('works with the real timer-based sleep', async () => {
    const client = createSettingsClient({
      dev: false,
      log: createLogger('offscreen', { sink: () => {} }),
      retryDelaysMs: [1],
      requestSettings: async () => undefined,
    });
    await expect(client.start()).resolves.toBeUndefined();
  });
});

describe('accept', () => {
  it('rejects anything that is not a valid SETTINGS_UPDATED', () => {
    const { client } = setup([]);
    for (const message of [undefined, 'SETTINGS_UPDATED', { type: 'OFFSCREEN_READY' }, { type: 'SETTINGS_UPDATED' }]) {
      expect(client.accept(message)).toBe(false);
    }
    expect(client.current()).toBeNull();
  });

  it('keeps ready() at the first settings and current() at the latest', async () => {
    const { client, lines } = setup([]);
    expect(client.accept(reply({ appId: 'first' }))).toBe(true);
    expect(client.accept(reply({ appId: 'second', allowedSites: [] }))).toBe(true);
    expect((await client.ready()).appId).toBe('first');
    expect(client.current()?.appId).toBe('second');
    expect(lines.map((l) => l.line)).toEqual(['[PSS:offscreen] settings received', '[PSS:offscreen] settings updated']);
    expect(lines[1]?.fields).toEqual({ configured: true, sites: 0 });
  });

  it('lets several waiting jobs continue when settings arrive', async () => {
    const { client } = setup([]);
    const jobs = [client.ready(), client.ready(), client.ready()];
    client.accept(reply({ appId: 'go' }));
    const results = await Promise.all(jobs);
    expect(results.map((s) => s.appId)).toEqual(['go', 'go', 'go']);
  });

  it('registers the APP-ID so it never appears in logs', () => {
    const { client } = setup([]);
    client.accept(reply({ appId: 'cc6a6cfc-1111-4222-8333-944455556666' }));
    expect(sanitizeString('cc6a6cfc-1111-4222-8333-944455556666')).toBe('[redacted]');
  });
});
