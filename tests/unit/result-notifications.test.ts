// Unit tests of what the notifications say (src/background/result-notifications.ts,
// DESIGN.md §7, D39, README "Notifications – what each one means"). Texts come
// from the real catalogue, rendered the way chrome.i18n renders them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  displayFileName,
  FILE_NAME_MAX_CHARS,
  MAX_FILES_SHOWN,
  MAX_FINDINGS_SHOWN,
  notificationsFor,
} from '../../src/background/result-notifications.ts';
import { errorMessageKey, type GetMessage } from '../../src/shared/i18n.ts';
import type { ShowResult } from '../../src/shared/messages.ts';
import { ERROR_CODES, type ErrorCode, type MaskedFinding, type ScanResult, type ScanStats } from '../../src/shared/types.ts';

type Entry = { message: string; placeholders?: Record<string, { content: string }> };
const catalogue = JSON.parse(readFileSync(new URL('../../_locales/en/messages.json', import.meta.url), 'utf8')) as Record<string, Entry>;
const t: GetMessage = (key, substitutions = []) => {
  const entry = catalogue[key] as Entry;
  return entry.message.replace(/\$(\w+)\$/g, (_m, name: string) =>
    (entry.placeholders?.[name.toLowerCase()]?.content ?? '').replace(/\$(\d)/g, (_n, i: string) => substitutions[Number(i) - 1] ?? ''),
  );
};

const BATCH = '6a2b3c4d-5555-4666-8777-988899990000';
const finding = (pages: number[] = [3], entityType = 'AWS credentials'): MaskedFinding => ({ entityType, category: 'Access Tokens', masked: 'AKIA…LE', pages });
const stats = (over: Partial<ScanStats> = {}): ScanStats => ({
  pages: 3, chunks: 4, failedChunks: 0, textChars: 1000, scannedChars: 1000, truncated: false, ms: 10, ...over,
});
let n = 0;
const file = (fileName: string, status: ScanResult['status'], over: Partial<ScanResult> = {}): ScanResult => ({
  scanId: `5f1c2a3e-1111-4222-8333-${String(++n).padStart(12, '0')}`,
  batchId: BATCH,
  fileName,
  status,
  findings: [],
  errors: [],
  ...over,
});
const secrets = (fileName: string, findings = [finding()], over: Partial<ScanResult> = {}) => file(fileName, 'secrets', { findings, stats: stats(), ...over });
const failed = (fileName: string, code: ErrorCode, over: Partial<ScanResult> = {}) => file(fileName, 'error', { errors: [{ code }], ...over });
const clean = (fileName: string) => file(fileName, 'clean', { stats: stats() });
const batch = (...results: ScanResult[]): ShowResult => ({ type: 'SHOW_RESULT', batchId: BATCH, origin: 'https://mail.google.com', results });
const one = (message: ShowResult) => {
  const specs = notificationsFor(message, t);
  expect(specs).toHaveLength(1);
  return specs[0] as NonNullable<(typeof specs)[0]>;
};

describe('clean', () => {
  it('a batch of clean files shows nothing', () => {
    expect(notificationsFor(batch(clean('a.pdf'), clean('b.pdf')), t)).toEqual([]);
  });
});

describe('secrets – one file', () => {
  it('title, site, the finding with its page and masked value, advice', () => {
    expect(one(batch(secrets('report.pdf')))).toEqual({
      id: `batch-${BATCH}-secrets`,
      kind: 'secrets',
      title: 'Secrets found in report.pdf',
      message: 'You added it to mail.google.com.\nAWS credentials (p. 3) AKIA…LE\nRemove the file and rotate the credentials.',
    });
  });

  it(`at most ${MAX_FINDINGS_SHOWN} findings, then "+N more"`, () => {
    const lines = one(batch(secrets('r.pdf', Array.from({ length: 5 }, (_, i) => finding([i + 1]))))).message.split('\n');
    expect(lines.filter((l) => l.startsWith('AWS credentials'))).toHaveLength(MAX_FINDINGS_SHOWN);
    expect(lines).toContain('+2 more');
  });

  it('a finding whose page is unknown is shown without "(p. …)"; long page lists end in "…"', () => {
    const message = one(batch(secrets('r.pdf', [finding([]), finding([1, 2, 3, 4, 5, 6, 7])]))).message;
    expect(message).toContain('\nAWS credentials AKIA…LE\n');
    expect(message).toContain('AWS credentials (p. 1, 2, 3, 4, 5, …) AKIA…LE');
  });

  it('partly checked: notes on truncation and failed parts, still a secrets notification', () => {
    const result = secrets('r.pdf', [finding()], {
      errors: [{ code: 'API_TIMEOUT' }, { code: 'API_HTTP_ERROR', detail: '503' }, { code: 'TEXT_TRUNCATED' }],
      stats: stats({ chunks: 4, failedChunks: 2, textChars: 3_500_000, scannedChars: 2_000_000, truncated: true }),
    });
    const lines = one(batch(result)).message.split('\n');
    expect(lines).toEqual([
      'You added it to mail.google.com.',
      'AWS credentials (p. 3) AKIA…LE',
      '2 of 4 parts could not be scanned.', // once, though two API codes caused it
      'Only the first 2,000,000 of 3,500,000 characters were checked.',
      'Remove the file and rotate the credentials.',
    ]);
  });
});

describe('secrets – several files', () => {
  it('"N of M files contain secrets", "You added them", each finding with its file', () => {
    const spec = one(batch(secrets('a.pdf'), secrets('b.pdf', [finding([7], 'GitHub token')]), clean('c.pdf')));
    expect(spec.title).toBe('2 of 3 files contain secrets');
    expect(spec.message.split('\n')).toEqual([
      'You added them to mail.google.com.',
      'a.pdf: AWS credentials (p. 3) AKIA…LE',
      'b.pdf: GitHub token (p. 7) AKIA…LE',
      'Remove the file and rotate the credentials.',
    ]);
  });

  it(`the ${MAX_FINDINGS_SHOWN}-finding limit counts across all files`, () => {
    const spec = one(batch(secrets('a.pdf', [finding(), finding()]), secrets('b.pdf', [finding(), finding()])));
    expect(spec.message.split('\n').filter((l) => l.includes('AKIA…LE'))).toHaveLength(MAX_FINDINGS_SHOWN);
    expect(spec.message).toContain('+1 more');
  });
});

describe('not fully checked – one file', () => {
  // NOT_CONFIGURED has its own notification (7.3).
  const plain = ERROR_CODES.filter((code) => !['TEXT_TRUNCATED', 'API_UNAUTHORIZED', 'NOT_CONFIGURED'].includes(code));

  it.each(plain)('%s: "Couldn\'t fully scan", with its reason', (code: ErrorCode) => {
    const spec = one(batch(failed('report.pdf', code)));
    expect(spec).toMatchObject({ id: `batch-${BATCH}-failed`, kind: 'failed', title: "Couldn't fully scan report.pdf" });
    expect(spec.message).toBe(t(errorMessageKey(code)));
  });

  it('API_UNAUTHORIZED: "Couldn\'t scan" and the APP-ID reason', () => {
    expect(one(batch(failed('report.pdf', 'API_UNAUTHORIZED')))).toMatchObject({
      title: "Couldn't scan report.pdf",
      message: 'Your APP-ID was rejected – check the extension settings.',
    });
  });

  it('TEXT_TRUNCATED: the numbers from the stats', () => {
    const result = failed('r.pdf', 'TEXT_TRUNCATED', { stats: stats({ textChars: 12_345_678, scannedChars: 10_000_000, truncated: true }) });
    expect(one(batch(result)).message).toBe('Only the first 10,000,000 of 12,345,678 characters were checked.');
  });

  it('every part failed: the API reason; some parts failed: how many', () => {
    const allFailed = failed('a.pdf', 'API_UNREACHABLE', { stats: stats({ chunks: 3, failedChunks: 3 }) });
    expect(one(batch(allFailed)).message).toBe(t('error_API_UNREACHABLE'));
    const someFailed = failed('a.pdf', 'API_UNREACHABLE', { stats: stats({ chunks: 3, failedChunks: 1 }) });
    expect(one(batch(someFailed)).message).toBe('1 of 3 parts could not be scanned.');
  });
});

describe('not fully checked – several files', () => {
  it('"N of M files", one line per file with its reason', () => {
    const spec = one(batch(failed('a.pdf', 'PDF_ENCRYPTED'), failed('b.pdf', 'FILE_TOO_LARGE'), clean('c.pdf')));
    expect(spec.title).toBe("Couldn't fully scan 2 of 3 files");
    expect(spec.message.split('\n')).toEqual([
      'a.pdf: The PDF is password-protected – it was not checked.',
      'b.pdf: The file is larger than the size limit – it was not checked.',
    ]);
  });

  it(`at most ${MAX_FILES_SHOWN} files listed, then "+N more"`, () => {
    const files = Array.from({ length: 7 }, (_, i) => failed(`f${i}.pdf`, 'QUEUE_FULL'));
    const lines = one(batch(...files)).message.split('\n');
    expect(lines).toHaveLength(MAX_FILES_SHOWN + 1);
    expect(lines.at(-1)).toBe('+3 more');
  });
});

describe('secrets and failures in one batch (D39)', () => {
  it('two notifications with their own ids; clean files in neither; totals count the whole batch', () => {
    const specs = notificationsFor(batch(secrets('a.pdf'), failed('b.pdf', 'PDF_INVALID'), clean('c.pdf'), failed('d.pdf', 'NO_TEXT_LAYER')), t);
    expect(specs.map((s) => [s.id, s.kind, s.title])).toEqual([
      [`batch-${BATCH}-secrets`, 'secrets', 'Secrets found in a.pdf'],
      [`batch-${BATCH}-failed`, 'failed', "Couldn't fully scan 2 of 4 files"],
    ]);
    expect(specs.map((s) => s.message).join('\n')).not.toContain('c.pdf');
  });
});

describe('page-controlled text is cleaned', () => {
  it('the site is the origin Chrome reported (host and port)', () => {
    const spec = one({ ...batch(secrets('a.pdf')), origin: 'http://localhost:8080' });
    expect(spec.message).toContain('You added it to localhost:8080.');
  });

  it('file names in titles and lines go through displayFileName', () => {
    const name = `evil‮fdp.exe\n${'x'.repeat(100)}.pdf`;
    const specs = notificationsFor(batch(secrets(name), failed(name, 'PDF_INVALID'), failed('b.pdf', 'PDF_INVALID')), t);
    const all = specs.map((s) => `${s.title}\n${s.message}`).join('\n');
    expect(all).not.toMatch(/[‮\u0000-\u0009\u000B-\u001F]/);
    expect(all).toContain(displayFileName(name));
  });
});

describe('displayFileName', () => {
  it('an ordinary name is unchanged', () => {
    expect(displayFileName('Q3 report (final).pdf')).toBe('Q3 report (final).pdf');
  });

  it.each([
    ['right-to-left override', 'invoice‮fdp.exe', 'invoicefdp.exe'],
    ['isolates', 'a⁦b⁩c.pdf', 'abc.pdf'],
    ['marks', 'a‎b‏c؜.pdf', 'abc.pdf'],
    ['zero-width', 'a​b﻿.pdf', 'ab.pdf'],
    ['control characters and line breaks', 'a\u0000b\nc\td .pdf', 'abcd.pdf'],
  ])('%s are removed', (_name, input, expected) => {
    expect(displayFileName(input)).toBe(expected);
  });

  it(`at most ${FILE_NAME_MAX_CHARS} characters, the end (".pdf") kept`, () => {
    const shown = displayFileName(`${'a'.repeat(100)}-final.pdf`);
    expect([...shown]).toHaveLength(FILE_NAME_MAX_CHARS);
    expect(shown.endsWith('inal.pdf')).toBe(true);
    expect(shown).toContain('…');
  });

  it(`exactly ${FILE_NAME_MAX_CHARS} characters are kept whole; emoji count as one`, () => {
    const exact = `${'b'.repeat(FILE_NAME_MAX_CHARS - 4)}.pdf`;
    expect(displayFileName(exact)).toBe(exact);
    const emoji = `${'😀'.repeat(FILE_NAME_MAX_CHARS - 4)}.pdf`;
    expect(displayFileName(emoji)).toBe(emoji);
  });

  it('a name that is empty after cleaning is shown as "PDF"', () => {
    expect(displayFileName('‮\u0000  ')).toBe('PDF');
  });
});
