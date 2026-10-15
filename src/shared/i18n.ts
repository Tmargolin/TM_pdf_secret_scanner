// The texts the extension shows (DESIGN.md §7). Every string lives in
// _locales/<lang>/messages.json and is read with chrome.i18n.getMessage, so a
// language (e.g. Hebrew) can be added without code changes. This file lists
// every key the code may use, with the number of substitutions ($1, $2 …) it
// takes – a test checks the list against messages.json in both directions.

import type { ErrorCode } from './types.ts';

/** Message key → number of substitutions. */
export const MESSAGES = {
  // Manifest (__MSG_extName__, __MSG_extDescription__)
  extName: 0,
  extDescription: 0,
  // Notification titles
  titleSecretsOne: 1,
  titleSecretsMany: 2,
  titleFailedOne: 1,
  titleFailedMany: 2,
  titleUnauthorized: 1,
  titleNotConfigured: 0,
  titleInterrupted: 1,
  // Notification message parts
  secretsAddedOne: 1,
  secretsAddedMany: 1,
  findingWithPages: 3,
  findingNoPages: 2,
  findingsMore: 1,
  secretsAdvice: 0,
  partsNotScanned: 2,
  fileReason: 2,
  notConfiguredMessage: 0,
  // One reason per ErrorCode
  error_NOT_CONFIGURED: 0,
  error_FILE_TOO_LARGE: 0,
  error_PDF_ENCRYPTED: 0,
  error_PDF_INVALID: 0,
  error_NO_TEXT_LAYER: 0,
  error_API_UNREACHABLE: 0,
  error_API_TIMEOUT: 0,
  error_API_HTTP_ERROR: 0,
  error_API_BAD_RESPONSE: 0,
  error_API_UNAUTHORIZED: 0,
  error_SCAN_INTERRUPTED: 0,
  error_SCAN_TIMEOUT: 0,
  error_TEXT_TRUNCATED: 2,
  error_CHUNK_TOO_LARGE: 0,
  error_QUEUE_FULL: 0,
} as const satisfies Record<`error_${ErrorCode}`, number> & Record<string, number>;

export type MessageKey = keyof typeof MESSAGES;

/** chrome.i18n.getMessage, typed to the keys above. */
export type GetMessage = (key: MessageKey, substitutions?: string[]) => string;

/** The reason text for an error code. */
export function errorMessageKey(code: ErrorCode): MessageKey {
  return `error_${code}`;
}
