import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRegisteredSecrets,
  createLogger,
  MAX_DEPTH,
  MAX_STRING_LENGTH,
  REDACTED,
  registerSecret,
  sanitize,
  sanitizeString,
  type LogLevel,
  type LogSink,
} from '../../src/shared/safe-logger.ts';

const APP_ID = 'cc6a6cfc-1111-4222-8333-944455556666';
const AWS_KEY = 'AKIAZ7Q4XK2M9TPLW3VB';
const GITHUB_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlX3ZhbHVl';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';

/** Records every call so tests can inspect exactly what would be logged. */
function recordingSink() {
  const calls: { level: LogLevel; line: string; fields?: Record<string, unknown> }[] = [];
  const sink: LogSink = (level, line, fields) => {
    calls.push(fields === undefined ? { level, line } : { level, line, fields });
  };
  return { sink, calls, all: () => JSON.stringify(calls) };
}

afterEach(() => {
  clearRegisteredSecrets();
  vi.restoreAllMocks();
});

describe('sanitizeString', () => {
  it('leaves ordinary information untouched', () => {
    const s = 'report-2026.pdf: 12 pages, 3 chunks, scanId 5f1c2a3e-1111-4222-8333-944455556666, 840 ms';
    expect(sanitizeString(s)).toBe(s);
  });

  it('replaces a registered secret everywhere it appears', () => {
    registerSecret(APP_ID);
    expect(sanitizeString(`id=${APP_ID}; again ${APP_ID}`)).toBe(`id=${REDACTED}; again ${REDACTED}`);
  });

  it('ignores registered values shorter than 4 characters', () => {
    registerSecret('abc');
    expect(sanitizeString('abc abc')).toBe('abc abc');
  });

  it.each([
    ['AWS key', AWS_KEY],
    ['AWS temporary key', 'ASIAZ7Q4XK2M9TPLW3VB'],
    ['GitHub token', GITHUB_TOKEN],
    ['JWT', JWT],
    ['PEM block', PEM],
    ['long base64 run', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZn'],
    ['long hex run', 'a3f9'.repeat(12)],
  ])('replaces a %s', (_name, secret) => {
    const result = sanitizeString(`before ${secret} after`);
    expect(result).toBe(`before ${REDACTED} after`);
  });

  it('redacts everything after an unterminated PEM header', () => {
    expect(sanitizeString('before -----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA after')).toBe(`before ${REDACTED}`);
  });

  it('reduces long strings to their length', () => {
    const text = 'x '.repeat(MAX_STRING_LENGTH);
    expect(sanitizeString(text)).toBe(`[text, ${text.length} chars]`);
  });

  it('keeps strings of exactly the maximum length', () => {
    const text = 'y'.repeat(10).padEnd(MAX_STRING_LENGTH, ' ');
    expect(sanitizeString(text)).toBe(text);
  });
});

describe('sanitize', () => {
  it('passes through primitives that cannot carry text', () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize(undefined)).toBeUndefined();
    expect(sanitize(42)).toBe(42);
    expect(sanitize(false)).toBe(false);
    expect(sanitize(10n)).toBe('10');
  });

  it('summarises functions and symbols', () => {
    expect(sanitize(() => 1)).toBe('[function]');
    expect(sanitize(Symbol('s'))).toBe('[symbol]');
  });

  it('reduces errors to name and sanitised message', () => {
    expect(sanitize(new TypeError(`bad key ${AWS_KEY}`))).toEqual({ name: 'TypeError', message: `bad key ${REDACTED}` });
  });

  it('summarises binary data and blobs by size', () => {
    expect(sanitize(new ArrayBuffer(16))).toBe('[binary, 16 bytes]');
    expect(sanitize(new Uint8Array(8))).toBe('[binary, 8 bytes]');
    expect(sanitize(new Blob(['hello']))).toBe('[blob, 5 bytes]');
  });

  it.each(['text', 'body', 'prompt', 'entity', 'appId', 'APP_ID', 'App-Id', 'token', 'data', 'base64', 'Secrets'])(
    'always redacts a field named %s',
    (key) => {
      expect(sanitize({ [key]: 'harmless looking', other: 1 })).toEqual({ [key]: REDACTED, other: 1 });
    },
  );

  it('redacts sensitive fields at any depth', () => {
    const input = { result: { prompt: { findings: { Secrets: [{ entity: AWS_KEY }] } } } };
    expect(JSON.stringify(sanitize(input))).not.toContain(AWS_KEY);
  });

  it('cuts off nesting deeper than the limit', () => {
    let nested: unknown = 'deep';
    for (let i = 0; i < MAX_DEPTH + 2; i += 1) nested = { level: nested };
    expect(JSON.stringify(sanitize(nested))).toContain('[object]');
    expect(JSON.stringify(sanitize(nested))).not.toContain('deep');
  });

  it('caps arrays at 20 items', () => {
    const result = sanitize(Array.from({ length: 25 }, (_, i) => i)) as unknown[];
    expect(result).toHaveLength(21);
    expect(result.at(-1)).toBe('[+5 more]');
  });

  it('keeps short arrays complete', () => {
    expect(sanitize([1, 'a', true])).toEqual([1, 'a', true]);
  });
});

describe('createLogger', () => {
  it('prefixes lines with the context and routes each level', () => {
    const { sink, calls } = recordingSink();
    const log = createLogger('offscreen', { sink, dev: true });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(calls).toEqual([
      { level: 'debug', line: '[PSS:offscreen] d' },
      { level: 'info', line: '[PSS:offscreen] i' },
      { level: 'warn', line: '[PSS:offscreen] w' },
      { level: 'error', line: '[PSS:offscreen] e' },
    ]);
  });

  it('writes debug lines only in dev builds', () => {
    const release = recordingSink();
    createLogger('x', { sink: release.sink }).debug('hidden');
    expect(release.calls).toEqual([]);

    const dev = recordingSink();
    createLogger('x', { sink: dev.sink, dev: true }).debug('shown');
    expect(dev.calls).toHaveLength(1);
  });

  it('sanitises the message and the fields', () => {
    registerSecret(APP_ID);
    const { sink, calls, all } = recordingSink();
    createLogger('api', { sink }).warn(`request with ${APP_ID} failed`, {
      status: 401,
      appId: APP_ID,
      prompt: 'page text with AKIAZ7Q4XK2M9TPLW3VB inside',
      responseBody: '{"status":"success","result":{"action":"log"}} '.repeat(100),
      note: `header was ${APP_ID}`,
    });
    expect(calls[0]).toEqual({
      level: 'warn',
      line: `[PSS:api] request with ${REDACTED} failed`,
      fields: {
        status: 401,
        appId: REDACTED,
        prompt: REDACTED,
        responseBody: '[text, 4700 chars]',
        note: `header was ${REDACTED}`,
      },
    });
    expect(all()).not.toContain(APP_ID);
    expect(all()).not.toContain(AWS_KEY);
  });

  it('never throws, even if the sink fails', () => {
    const log = createLogger('x', {
      sink: () => {
        throw new Error('sink broken');
      },
    });
    expect(() => log.error('boom', { a: 1 })).not.toThrow();
  });

  it('writes to the console by default', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLogger('sw');
    log.info('started');
    log.warn('slow', { ms: 900 });
    expect(info).toHaveBeenCalledWith('[PSS:sw] started');
    expect(warn).toHaveBeenCalledWith('[PSS:sw] slow', { ms: 900 });
  });
});

describe('logging policy', () => {
  it('no source file except safe-logger.ts uses console', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.ts$/.test(entry.name) && !path.endsWith(join('shared', 'safe-logger.ts'))) {
          if (/\bconsole\s*[.[]/.test(readFileSync(path, 'utf8'))) offenders.push(path);
        }
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
  });
});
