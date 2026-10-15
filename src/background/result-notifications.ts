// SHOW_RESULT → the notifications to show (DESIGN.md §7, D39, README
// "Notifications – what each one means"). Pure: texts come from getMessage,
// nothing is shown here.
//
//   clean files                  → nothing
//   files with secrets           → one "secrets" notification
//   files not (fully) checked    → one "failed" notification
//   both in one batch (D39)      → both notifications
//   no APP-ID (NOT_CONFIGURED)   → one "isn't set up" notification (always the
//                                  same id, so batches don't pile them up)
//   scan interrupted (from the content script) → a "failed" notification
// "isn't set up" and "APP-ID rejected" open the settings when clicked
// (opensSettings(id)) – the id carries this, as the service worker keeps no state.
// A file with secrets whose text was only partly checked belongs to the
// secrets notification, with notes on what was not checked.
//
// Everything page-controlled is cleaned: file names lose control and
// invisible formatting characters (e.g. bidi overrides that could make
// "fdp.exe" read as "exe.pdf") and are cut to 60 characters; the site is the
// origin Chrome reported for the port, never a page-supplied value.

import type { GetMessage } from '../shared/i18n.ts';
import { errorMessageKey } from '../shared/i18n.ts';
import type { ScanInterrupted, ShowResult } from '../shared/messages.ts';
import type { MaskedFinding, ScanResult } from '../shared/types.ts';

export const FILE_NAME_MAX_CHARS = 60;
/** Findings listed in a secrets notification before "+N more" (the OS truncates long messages). */
export const MAX_FINDINGS_SHOWN = 3;
/** Failed files listed before "+N more". */
export const MAX_FILES_SHOWN = 4;
/** Page numbers listed per finding before "…". */
export const MAX_PAGES_SHOWN = 5;

export interface NotificationSpec {
  id: string;
  kind: 'secrets' | 'failed' | 'not-configured';
  title: string;
  message: string;
}

/** One for all batches: a second unconfigured upload replaces it instead of adding one. */
export const NOT_CONFIGURED_ID = 'not-configured';
const SETTINGS_SUFFIX = '-settings';

/** True for the notifications whose click opens the settings. */
export function opensSettings(notificationId: string): boolean {
  return notificationId === NOT_CONFIGURED_ID || notificationId.endsWith(SETTINGS_SUFFIX);
}

/** The site as people read it: "mail.google.com" (port kept if any). */
export function siteName(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** A page-supplied file name made safe to show: no control or format characters, at most 60 characters (end kept). */
export function displayFileName(name: string): string {
  const chars = [...name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()];
  if (chars.length === 0) return 'PDF';
  if (chars.length <= FILE_NAME_MAX_CHARS) return chars.join('');
  const tail = 8; // keeps ".pdf" and a few characters before it
  return `${chars.slice(0, FILE_NAME_MAX_CHARS - tail - 1).join('')}…${chars.slice(-tail).join('')}`;
}

const formatNumber = (n: number) => n.toLocaleString('en-US');

function pagesText(pages: readonly number[]): string {
  const shown = pages.slice(0, MAX_PAGES_SHOWN).join(', ');
  return pages.length > MAX_PAGES_SHOWN ? `${shown}, …` : shown;
}

function findingText(finding: MaskedFinding, t: GetMessage): string {
  return finding.pages.length > 0
    ? t('findingWithPages', [finding.entityType, pagesText(finding.pages), finding.masked])
    : t('findingNoPages', [finding.entityType, finding.masked]);
}

/** Why a file was not (fully) checked – one sentence per distinct problem. */
export function reasons(result: ScanResult, t: GetMessage): string[] {
  const lines: string[] = [];
  const failedChunks = result.stats?.failedChunks ?? 0;
  for (const error of result.errors) {
    if (error.code === 'TEXT_TRUNCATED') {
      const stats = result.stats;
      lines.push(
        stats
          ? t(errorMessageKey('TEXT_TRUNCATED'), [formatNumber(stats.scannedChars), formatNumber(stats.textChars)])
          : t(errorMessageKey('TEXT_TRUNCATED'), ['?', '?']),
      );
    } else if (failedChunks > 0 && result.stats && result.stats.chunks > failedChunks && isChunkError(error.code)) {
      // Some parts were checked: say how many were not, once.
      const line = t('partsNotScanned', [String(failedChunks), String(result.stats.chunks)]);
      if (!lines.includes(line)) lines.push(line);
    } else {
      lines.push(t(errorMessageKey(error.code)));
    }
  }
  return lines;
}

/** Codes that come from individual chunks (some parts of the text may have been checked). */
const isChunkError = (code: string) => code.startsWith('API_') || code === 'CHUNK_TOO_LARGE';

function secretsNotification(message: ShowResult, files: ScanResult[], t: GetMessage): NotificationSpec {
  const several = files.length > 1;
  const first = files[0] as ScanResult;
  const title = several
    ? t('titleSecretsMany', [String(files.length), String(message.results.length)])
    : t('titleSecretsOne', [displayFileName(first.fileName)]);

  const lines = [t(several ? 'secretsAddedMany' : 'secretsAddedOne', [siteName(message.origin)])];
  const findings = files.flatMap((file) =>
    file.findings.map((finding) => (several ? t('fileReason', [displayFileName(file.fileName), findingText(finding, t)]) : findingText(finding, t))),
  );
  lines.push(...findings.slice(0, MAX_FINDINGS_SHOWN));
  if (findings.length > MAX_FINDINGS_SHOWN) lines.push(t('findingsMore', [String(findings.length - MAX_FINDINGS_SHOWN)]));
  for (const file of files) {
    for (const reason of reasons(file, t)) lines.push(several ? t('fileReason', [displayFileName(file.fileName), reason]) : reason);
  }
  lines.push(t('secretsAdvice'));
  return { id: `batch-${message.batchId}-secrets`, kind: 'secrets', title, message: lines.join('\n') };
}

function failedNotification(message: ShowResult, files: ScanResult[], t: GetMessage): NotificationSpec {
  const first = files[0] as ScanResult;
  // A rejected APP-ID is fixed in the settings: that notification opens them.
  const unauthorized = files.some((file) => file.errors.some((e) => e.code === 'API_UNAUTHORIZED'));
  const id = `batch-${message.batchId}-failed${unauthorized ? SETTINGS_SUFFIX : ''}`;
  if (files.length === 1) {
    const title = t(unauthorized ? 'titleUnauthorized' : 'titleFailedOne', [displayFileName(first.fileName)]);
    return { id, kind: 'failed', title, message: reasons(first, t).join('\n') };
  }
  const title = t('titleFailedMany', [String(files.length), String(message.results.length)]);
  const lines = files
    .slice(0, MAX_FILES_SHOWN)
    .map((file) => t('fileReason', [displayFileName(file.fileName), reasons(file, t)[0] ?? '']));
  if (files.length > MAX_FILES_SHOWN) lines.push(t('findingsMore', [String(files.length - MAX_FILES_SHOWN)]));
  return { id, kind: 'failed', title, message: lines.join('\n') };
}

function notConfiguredNotification(t: GetMessage): NotificationSpec {
  return { id: NOT_CONFIGURED_ID, kind: 'not-configured', title: t('titleNotConfigured'), message: t('notConfiguredMessage') };
}

/** The 0, 1 or 2 notifications for one batch. */
export function notificationsFor(message: ShowResult, t: GetMessage): NotificationSpec[] {
  const notConfigured = (r: ScanResult) => r.errors.some((e) => e.code === 'NOT_CONFIGURED');
  const withSecrets = message.results.filter((r) => r.status === 'secrets');
  const failed = message.results.filter((r) => r.status === 'error' && !notConfigured(r));
  const specs: NotificationSpec[] = [];
  if (withSecrets.length > 0) specs.push(secretsNotification(message, withSecrets, t));
  if (failed.length > 0) specs.push(failedNotification(message, failed, t));
  if (message.results.some(notConfigured)) specs.push(notConfiguredNotification(t));
  return specs;
}

/**
 * The scan port dropped before the batch finished (content script → SCAN_INTERRUPTED):
 * those files were not checked. Same id as the batch's "failed" notification, so a
 * result that still arrives replaces it.
 */
export function interruptedNotification(message: ScanInterrupted, t: GetMessage): NotificationSpec {
  const names = message.fileNames.map(displayFileName);
  const reason = t('error_SCAN_INTERRUPTED');
  if (names.length === 1) {
    return { id: `batch-${message.batchId}-failed`, kind: 'failed', title: t('titleInterrupted', [names[0] as string]), message: reason };
  }
  const lines = names.slice(0, MAX_FILES_SHOWN).map((name) => t('fileReason', [name, reason]));
  if (names.length > MAX_FILES_SHOWN) lines.push(t('findingsMore', [String(names.length - MAX_FILES_SHOWN)]));
  return {
    id: `batch-${message.batchId}-failed`,
    kind: 'failed',
    title: t('titleFailedMany', [String(names.length), String(names.length)]),
    message: lines.join('\n'),
  };
}
