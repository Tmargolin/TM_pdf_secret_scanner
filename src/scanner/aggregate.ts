// Scan outcome → ScanResult fields (DESIGN.md §4, docs/agents/scanner.md).
// So far: the status rules. De-duplication, page numbers and masking of
// findings follow in 6.7.

import type { ErrorCode, ScanError, ScanStatus } from '../shared/types.ts';

/**
 * DESIGN.md §4 status rules:
 *   any secret found                           → 'secrets' (the errors are still reported:
 *                                                 "N of M parts could not be scanned",
 *                                                 "only the first X characters were checked")
 *   no secret, and every part of the text checked → 'clean'
 *   no secret, but something was not checked    → 'error' – a clean result is never claimed
 *                                                 for text we did not check
 * Every ErrorCode means some text was not checked (TEXT_TRUNCATED, a failed
 * chunk, an extraction failure, …), so any error rules out 'clean'.
 */
export function scanStatus(secretsFound: number, errors: readonly ScanError[]): ScanStatus {
  if (secretsFound > 0) return 'secrets';
  return errors.length > 0 ? 'error' : 'clean';
}

/** The errors of a scan, each code once, in the order first seen. */
export function uniqueErrors(errors: readonly ScanError[]): ScanError[] {
  const seen = new Set<ErrorCode>();
  return errors.filter((error) => !seen.has(error.code) && seen.add(error.code));
}
