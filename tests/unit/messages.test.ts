import { describe, expect, it } from 'vitest';
import { AWS_EXAMPLE_KEY, fakeAwsKeyId } from '../helpers/fake-secrets.ts';
import {
  base64DecodedLength,
  FULLY_MASKED,
  HANDOFF_MARKER,
  isFromContentScript,
  isFromExtensionContext,
  isFromOffscreen,
  isHandoffPortMessage,
  isMaskedValue,
  LIMITS,
  parseRuntimeMessage,
  parseScanPortMessage,
  parseScanPortReply,
  SCAN_PORT_NAME,
} from '../../src/shared/messages.ts';
import { getDefaultSettings } from '../../src/shared/settings.ts';
import { ERROR_CODES } from '../../src/shared/types.ts';

const SCAN_ID = '5f1c2a3e-1111-4222-8333-944455556666';
const BATCH_ID = '6a2b3c4d-5555-4666-8777-988899990000';
const PDF_BYTES = Buffer.from('%PDF-1.7 minimal test content');
const PDF_B64 = PDF_BYTES.toString('base64');

const request = (overrides: Record<string, unknown> = {}) => ({
  type: 'SCAN_REQUEST',
  scanId: SCAN_ID,
  batchId: BATCH_ID,
  fileName: 'report.pdf',
  size: PDF_BYTES.length,
  base64: PDF_B64,
  ...overrides,
});

const finding = (overrides: Record<string, unknown> = {}) => ({
  entityType: 'AWS credentials',
  category: 'Access Tokens',
  masked: 'AKIA…B1',
  pages: [3],
  ...overrides,
});

const stats = (overrides: Record<string, unknown> = {}) => ({
  pages: 5,
  chunks: 1,
  failedChunks: 0,
  textChars: 9_000,
  scannedChars: 9_000,
  truncated: false,
  ms: 840,
  ...overrides,
});

const result = (overrides: Record<string, unknown> = {}) => ({
  scanId: SCAN_ID,
  batchId: BATCH_ID,
  fileName: 'report.pdf',
  status: 'secrets',
  findings: [finding()],
  errors: [],
  stats: stats(),
  ...overrides,
});

const showResult = (overrides: Record<string, unknown> = {}) => ({
  type: 'SHOW_RESULT',
  batchId: BATCH_ID,
  origin: 'https://mail.google.com',
  results: [result()],
  ...overrides,
});

describe('constants', () => {
  it('match the protocol', () => {
    expect(SCAN_PORT_NAME).toBe('scan-batch');
    expect(HANDOFF_MARKER).toBe('__pss_handoff_v1__');
    expect(LIMITS.fileBytes).toBe(45 * 1024 * 1024);
  });

  it('list every error code once, including those added by probing', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES).toContain('API_UNAUTHORIZED');
    expect(ERROR_CODES).toContain('QUEUE_FULL');
    expect(ERROR_CODES).toHaveLength(15);
  });
});

describe('base64DecodedLength', () => {
  it('matches the real byte count for every padding case', () => {
    for (let size = 0; size <= 12; size += 1) {
      expect(base64DecodedLength(Buffer.alloc(size).toString('base64'))).toBe(size);
    }
  });

  it('returns -1 when the length is not a multiple of 4', () => {
    expect(base64DecodedLength('abc')).toBe(-1);
    expect(base64DecodedLength('abcde')).toBe(-1);
  });
});

describe('isMaskedValue', () => {
  it('accepts the two masked forms', () => {
    expect(isMaskedValue('AKIA…B1')).toBe(true);
    expect(isMaskedValue('ghp_…9x')).toBe(true);
    expect(isMaskedValue(FULLY_MASKED)).toBe(true);
  });

  it('rejects anything else, including short unmasked secrets', () => {
    for (const v of [AWS_EXAMPLE_KEY, fakeAwsKeyId(), 'AKIA…B12', 'AKI…B1', 'AKIA...B1', '…', '', '•••••', 'pass1234', 7, null]) {
      expect(isMaskedValue(v)).toBe(false);
    }
  });
});

describe('parseScanPortMessage – SCAN_REQUEST', () => {
  it('accepts a valid request and returns a clean copy without extra fields', () => {
    const parsed = parseScanPortMessage({ ...request(), injected: '<script>' });
    expect(parsed).toEqual(request());
  });

  it('accepts an empty file', () => {
    expect(parseScanPortMessage(request({ size: 0, base64: '' }))).not.toBeNull();
  });

  it('accepts a skipped (too large) file without bytes', () => {
    const skipped = { type: 'SCAN_REQUEST', scanId: SCAN_ID, batchId: BATCH_ID, fileName: 'big.pdf', size: 99_000_000, skipped: 'FILE_TOO_LARGE' };
    expect(parseScanPortMessage(skipped)).toEqual(skipped);
  });

  const invalid: [string, unknown][] = [
    ['not an object', 'SCAN_REQUEST'],
    ['null', null],
    ['an array', [request()]],
    ['unknown type', request({ type: 'SCAN_REQUESTED' })],
    ['bad scanId', request({ scanId: 'not-a-uuid' })],
    ['bad batchId', request({ batchId: 42 })],
    ['file name too long', request({ fileName: 'x'.repeat(LIMITS.fileNameChars + 1) })],
    ['file name not text', request({ fileName: ['a.pdf'] })],
    ['negative size', request({ size: -1 })],
    ['fractional size', request({ size: 1.5 })],
    ['bytes over the size limit', request({ size: LIMITS.fileBytes + 1 })],
    ['missing bytes', request({ base64: undefined })],
    ['bytes not text', request({ base64: 123 })],
    ['base64 for a different size', request({ size: PDF_BYTES.length + 1 })],
    ['base64 with invalid characters', request({ base64: `${PDF_B64.slice(0, -4)}!!!!` })],
    ['base64 of wrong length', request({ base64: PDF_B64.slice(1) })],
    ['both bytes and skipped', request({ skipped: 'FILE_TOO_LARGE' })],
    ['unknown skip reason', { ...request({ skipped: 'TOO_BORING' }), base64: undefined }],
  ];
  for (const [name, data] of invalid) {
    it(`rejects ${name}`, () => {
      expect(parseScanPortMessage(data)).toBeNull();
    });
  }
});

describe('parseScanPortMessage – BATCH_END', () => {
  it('accepts a valid batch end without extra fields', () => {
    expect(parseScanPortMessage({ type: 'BATCH_END', batchId: BATCH_ID, fileCount: 3, x: 1 })).toEqual({
      type: 'BATCH_END',
      batchId: BATCH_ID,
      fileCount: 3,
    });
  });

  for (const fileCount of [0, LIMITS.filesPerBatch + 1, 2.5, '3']) {
    it(`rejects fileCount ${String(fileCount)}`, () => {
      expect(parseScanPortMessage({ type: 'BATCH_END', batchId: BATCH_ID, fileCount })).toBeNull();
    });
  }

  it('rejects a bad batchId', () => {
    expect(parseScanPortMessage({ type: 'BATCH_END', batchId: 'b', fileCount: 1 })).toBeNull();
  });
});

describe('parseScanPortReply – BATCH_ACCEPTED / BATCH_DONE', () => {
  for (const type of ['BATCH_ACCEPTED', 'BATCH_DONE'] as const) {
    it(`accepts ${type} and keeps only type and batchId`, () => {
      expect(parseScanPortReply({ type, batchId: BATCH_ID, results: [{ masked: 'AKIA…B1' }], x: 1 })).toEqual({
        type,
        batchId: BATCH_ID,
      });
    });

    for (const batchId of [undefined, 'b', 42, `${BATCH_ID} `]) {
      it(`${type}: rejects batchId ${JSON.stringify(batchId)}`, () => {
        expect(parseScanPortReply({ type, batchId })).toBeNull();
      });
    }
  }

  for (const data of [
    null,
    'BATCH_DONE',
    [],
    { batchId: BATCH_ID },
    { type: 'batch_done', batchId: BATCH_ID },
    { type: 'BATCH_END', batchId: BATCH_ID, fileCount: 1 },
    { type: 'SHOW_RESULT', batchId: BATCH_ID },
  ]) {
    it(`rejects ${JSON.stringify(data)}`, () => {
      expect(parseScanPortReply(data)).toBeNull();
    });
  }

  it('accepts BATCH_REJECTED with reason closing, keeping only its fields', () => {
    expect(parseScanPortReply({ type: 'BATCH_REJECTED', batchId: BATCH_ID, reason: 'closing', x: 1 })).toEqual({
      type: 'BATCH_REJECTED',
      batchId: BATCH_ID,
      reason: 'closing',
    });
  });

  it.each([undefined, 'busy', 42])('rejects BATCH_REJECTED with reason %s', (reason) => {
    expect(parseScanPortReply({ type: 'BATCH_REJECTED', batchId: BATCH_ID, reason })).toBeNull();
  });

  it('BATCH_REJECTED needs a valid batchId', () => {
    expect(parseScanPortReply({ type: 'BATCH_REJECTED', batchId: 'b', reason: 'closing' })).toBeNull();
  });

  it('replies and requests are not interchangeable', () => {
    expect(parseScanPortMessage({ type: 'BATCH_ACCEPTED', batchId: BATCH_ID })).toBeNull();
    expect(parseScanPortMessage({ type: 'BATCH_DONE', batchId: BATCH_ID })).toBeNull();
    expect(parseScanPortMessage({ type: 'BATCH_REJECTED', batchId: BATCH_ID, reason: 'closing' })).toBeNull();
  });
});

describe('parseRuntimeMessage – simple messages', () => {
  it('accepts OFFSCREEN_READY, OFFSCREEN_IDLE and ENSURE_OFFSCREEN, dropping extra fields', () => {
    expect(parseRuntimeMessage({ type: 'OFFSCREEN_READY', x: 1 }, false)).toEqual({ type: 'OFFSCREEN_READY' });
    expect(parseRuntimeMessage({ type: 'OFFSCREEN_IDLE', x: 1 }, false)).toEqual({ type: 'OFFSCREEN_IDLE' });
    expect(parseRuntimeMessage({ type: 'ENSURE_OFFSCREEN', x: 1 }, false)).toEqual({ type: 'ENSURE_OFFSCREEN' });
  });

  it('rejects unknown types and non-objects', () => {
    expect(parseRuntimeMessage({ type: 'DELETE_EVERYTHING' }, false)).toBeNull();
    expect(parseRuntimeMessage('OFFSCREEN_READY', false)).toBeNull();
    expect(parseRuntimeMessage(undefined, false)).toBeNull();
  });
});

describe('parseRuntimeMessage – SETTINGS_UPDATED', () => {
  it('returns complete, normalised settings', () => {
    const parsed = parseRuntimeMessage({ type: 'SETTINGS_UPDATED', settings: { appId: 'abc', retries: 99 } }, false);
    expect(parsed).toEqual({ type: 'SETTINGS_UPDATED', settings: { ...getDefaultSettings(false), appId: 'abc' } });
  });

  it('applies the dev / release rules', () => {
    const settings = { apiUrl: 'http://localhost:8787/api/protect' };
    const dev = parseRuntimeMessage({ type: 'SETTINGS_UPDATED', settings }, true);
    const release = parseRuntimeMessage({ type: 'SETTINGS_UPDATED', settings }, false);
    expect(dev?.type === 'SETTINGS_UPDATED' && dev.settings.apiUrl).toBe('http://localhost:8787/api/protect');
    expect(release?.type === 'SETTINGS_UPDATED' && release.settings.apiUrl).toBe('https://eu.prompt.security/api/protect');
  });

  it('rejects settings that are not an object', () => {
    expect(parseRuntimeMessage({ type: 'SETTINGS_UPDATED', settings: 'x' }, false)).toBeNull();
    expect(parseRuntimeMessage({ type: 'SETTINGS_UPDATED' }, false)).toBeNull();
  });
});

describe('parseRuntimeMessage – SCAN_INTERRUPTED', () => {
  it('accepts a valid message', () => {
    const msg = { type: 'SCAN_INTERRUPTED', batchId: BATCH_ID, fileNames: ['a.pdf', 'b.pdf'] };
    expect(parseRuntimeMessage(msg, false)).toEqual(msg);
  });

  const invalid: [string, unknown][] = [
    ['bad batchId', 'x'],
    ['fileNames not a list', 'a.pdf'],
    ['no file names', []],
    ['too many file names', Array.from({ length: LIMITS.filesPerBatch + 1 }, () => 'a.pdf')],
    ['a non-text file name', ['a.pdf', 7]],
    ['a too long file name', ['x'.repeat(LIMITS.fileNameChars + 1)]],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => {
      const msg =
        name === 'bad batchId'
          ? { type: 'SCAN_INTERRUPTED', batchId: value, fileNames: ['a.pdf'] }
          : { type: 'SCAN_INTERRUPTED', batchId: BATCH_ID, fileNames: value };
      expect(parseRuntimeMessage(msg, false)).toBeNull();
    });
  }
});

describe('parseRuntimeMessage – SHOW_RESULT', () => {
  it('accepts a valid batch result', () => {
    expect(parseRuntimeMessage(showResult(), false)).toEqual(showResult());
  });

  it('accepts a fully masked finding', () => {
    expect(parseRuntimeMessage(showResult({ results: [result({ findings: [finding({ masked: FULLY_MASKED })] })] }), false)).not.toBeNull();
  });

  it('accepts results without stats and errors with or without detail', () => {
    const r = result({
      status: 'error',
      findings: [],
      errors: [{ code: 'API_HTTP_ERROR', detail: '503' }, { code: 'TEXT_TRUNCATED' }],
      stats: undefined,
    });
    const parsed = parseRuntimeMessage(showResult({ results: [r] }), false);
    expect(parsed).not.toBeNull();
    expect(parsed?.type === 'SHOW_RESULT' && parsed.results[0]).toEqual({
      scanId: SCAN_ID,
      batchId: BATCH_ID,
      fileName: 'report.pdf',
      status: 'error',
      findings: [],
      errors: [{ code: 'API_HTTP_ERROR', detail: '503' }, { code: 'TEXT_TRUNCATED' }],
    });
  });

  it('returns copies, not the original arrays', () => {
    const msg = showResult();
    const parsed = parseRuntimeMessage(msg, false);
    msg.results[0]?.findings[0]?.pages.push(99);
    expect(parsed?.type === 'SHOW_RESULT' && parsed.results[0]?.findings[0]?.pages).toEqual([3]);
  });

  const invalid: [string, Record<string, unknown>][] = [
    ['bad batchId', showResult({ batchId: 'x' })],
    ['origin too long', showResult({ origin: 'h'.repeat(513) })],
    ['results not a list', showResult({ results: result() })],
    ['no results', showResult({ results: [] })],
    ['too many results', showResult({ results: Array.from({ length: LIMITS.filesPerBatch + 1 }, () => result()) })],
    ['a result from another batch', showResult({ results: [result({ batchId: SCAN_ID })] })],
    ['a result that is not an object', showResult({ results: ['clean'] })],
    ['a bad scanId', showResult({ results: [result({ scanId: 1 })] })],
    ['an unknown status', showResult({ results: [result({ status: 'maybe' })] })],
    ['findings not a list', showResult({ results: [result({ findings: {} })] })],
    ['errors not a list', showResult({ results: [result({ errors: 'none' })] })],
    ['too many findings', showResult({ results: [result({ findings: Array.from({ length: LIMITS.findingsPerFile + 1 }, () => finding()) })] })],
    ['a finding that is not an object', showResult({ results: [result({ findings: ['AKIA'] })] })],
    ['an unmasked secret', showResult({ results: [result({ findings: [finding({ masked: fakeAwsKeyId() })] })] })],
    ['a wrongly masked value', showResult({ results: [result({ findings: [finding({ masked: 'AKIA…B12' })] })] })],
    ['a non-text entity type', showResult({ results: [result({ findings: [finding({ entityType: 5 })] })] })],
    ['a non-text category', showResult({ results: [result({ findings: [finding({ category: null })] })] })],
    ['page numbers not a list', showResult({ results: [result({ findings: [finding({ pages: 3 })] })] })],
    ['page number 0', showResult({ results: [result({ findings: [finding({ pages: [0] })] })] })],
    ['a fractional page number', showResult({ results: [result({ findings: [finding({ pages: [1.5] })] })] })],
    ['an unknown error code', showResult({ results: [result({ errors: [{ code: 'OOPS' }] })] })],
    ['an error that is not an object', showResult({ results: [result({ errors: ['API_TIMEOUT'] })] })],
    ['a too long error detail', showResult({ results: [result({ errors: [{ code: 'API_HTTP_ERROR', detail: 'd'.repeat(201) }] })] })],
    ['a non-text error detail', showResult({ results: [result({ errors: [{ code: 'API_HTTP_ERROR', detail: 503 }] })] })],
    ['stats not an object', showResult({ results: [result({ stats: 'fast' })] })],
    ['stats with a missing number', showResult({ results: [result({ stats: stats({ chunks: undefined }) })] })],
    ['stats with a negative number', showResult({ results: [result({ stats: stats({ ms: -1 }) })] })],
    ['stats with a non-boolean truncated', showResult({ results: [result({ stats: stats({ truncated: 'no' }) })] })],
  ];
  for (const [name, msg] of invalid) {
    it(`rejects ${name}`, () => {
      expect(parseRuntimeMessage(msg, false)).toBeNull();
    });
  }
});

describe('isHandoffPortMessage', () => {
  const { port1, port2 } = new MessageChannel();
  it('accepts the marker with exactly one port', () => {
    expect(isHandoffPortMessage({ marker: HANDOFF_MARKER }, [port1])).toBe(true);
  });
  it('rejects a wrong marker, no port or several ports', () => {
    expect(isHandoffPortMessage({ marker: 'other' }, [port1])).toBe(false);
    expect(isHandoffPortMessage({ marker: HANDOFF_MARKER }, [])).toBe(false);
    expect(isHandoffPortMessage({ marker: HANDOFF_MARKER }, [port1, port2])).toBe(false);
    expect(isHandoffPortMessage(HANDOFF_MARKER, [port1])).toBe(false);
  });
  port1.close();
  port2.close();
});

describe('sender checks', () => {
  const EXT = 'abcdefghijklmnopabcdefghijklmnop';
  const OFFSCREEN_URL = `chrome-extension://${EXT}/offscreen/offscreen.html`;

  it('isFromContentScript needs our extension id and a tab', () => {
    expect(isFromContentScript({ id: EXT, tab: { id: 1 } }, EXT)).toBe(true);
    expect(isFromContentScript({ id: 'other', tab: { id: 1 } }, EXT)).toBe(false);
    expect(isFromContentScript({ id: EXT }, EXT)).toBe(false);
    expect(isFromContentScript({}, EXT)).toBe(false);
  });

  it('isFromExtensionContext needs our extension id and no tab', () => {
    expect(isFromExtensionContext({ id: EXT }, EXT)).toBe(true);
    expect(isFromExtensionContext({ id: EXT, url: `chrome-extension://${EXT}/background/service-worker.js` }, EXT)).toBe(true);
    expect(isFromExtensionContext({ id: EXT, tab: { id: 1 } }, EXT)).toBe(false);
    expect(isFromExtensionContext({ id: 'other' }, EXT)).toBe(false);
    expect(isFromExtensionContext({}, EXT)).toBe(false);
  });

  it('isFromOffscreen needs our extension id, no tab and the exact URL', () => {
    expect(isFromOffscreen({ id: EXT, url: OFFSCREEN_URL }, EXT, OFFSCREEN_URL)).toBe(true);
    expect(isFromOffscreen({ id: EXT, url: OFFSCREEN_URL, tab: { id: 1 } }, EXT, OFFSCREEN_URL)).toBe(false);
    expect(isFromOffscreen({ id: EXT, url: `${OFFSCREEN_URL}?x` }, EXT, OFFSCREEN_URL)).toBe(false);
    expect(isFromOffscreen({ id: 'other', url: OFFSCREEN_URL }, EXT, OFFSCREEN_URL)).toBe(false);
  });
});
