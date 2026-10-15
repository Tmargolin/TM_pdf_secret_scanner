// Scan outcome → ScanResult fields (DESIGN.md §4 step 5, docs/agents/scanner.md).
//
//   raw secrets from every chunk ──aggregateFindings──▶ MaskedFinding[]
//     - de-duplicated: same entity type + same value (overlapping chunks and
//       split halves report the same secret more than once)
//     - pages: every place the value occurs in the page texts; [] if the
//       API's value cannot be found verbatim (the finding is still kept)
//     - masked (mask.ts) – the plain value never leaves this function
//     - in reading order (first occurrence); not-located ones last
//   status: scanStatus (below)

import type { ErrorCode, MaskedFinding, ScanError, ScanStatus } from '../shared/types.ts';
import { pageAt, type PagedText } from './chunker.ts';
import { maskSecret } from './mask.ts';
import type { RawFinding } from './parse.ts';

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

/** Page numbers (sorted, each once) of every occurrence of `value` in the text. */
export function pagesOf(paged: PagedText, value: string): number[] {
  const pages = new Set<number>();
  for (let at = paged.text.indexOf(value); at >= 0; at = paged.text.indexOf(value, at + value.length)) {
    pages.add(pageAt(paged, at));
  }
  return [...pages].sort((a, b) => a - b);
}

/** Raw secrets (unmasked, possibly repeated) → findings ready for a SHOW_RESULT. */
export function aggregateFindings(secrets: readonly RawFinding[], paged: PagedText): MaskedFinding[] {
  const unique = new Map<string, RawFinding>();
  for (const secret of secrets) {
    // A secret without a value cannot be told apart from another of its kind: one per type and category.
    const key = JSON.stringify([secret.entityType, secret.entity ?? null, secret.entity === null ? secret.category : null]);
    if (!unique.has(key)) unique.set(key, secret);
  }
  const located = [...unique.values()].map((secret) => {
    const first = secret.entity === null ? -1 : paged.text.indexOf(secret.entity);
    return {
      first: first < 0 ? Number.POSITIVE_INFINITY : first,
      finding: {
        entityType: secret.entityType,
        category: secret.category,
        masked: maskSecret(secret.entity),
        pages: secret.entity === null ? [] : pagesOf(paged, secret.entity),
      },
    };
  });
  // Array.prototype.sort is stable: equal positions keep the order the API reported them in.
  return located.sort((a, b) => a.first - b.first).map((entry) => entry.finding);
}
