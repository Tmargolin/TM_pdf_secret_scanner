// Secret value → the only form that may leave the offscreen document
// (DESIGN.md §8, docs/agents/scanner.md).
//
//   12 code points or more → first 4 + "…" + last 2   ("AKIA…LE")
//   shorter, or no value   → FULLY_MASKED ("••••••")
// Counted in code points, so an emoji is never cut in half. The result always
// passes isMaskedValue (the check every receiver applies); if it would not –
// e.g. the secret itself contains "…" where the mask keeps it – the value is
// fully masked instead.

import { FULLY_MASKED, isMaskedValue } from '../shared/messages.ts';

/** Shorter secrets are fully masked: 4 + 2 shown characters would give away too much. */
export const MIN_PARTLY_MASKED_CHARS = 12;

export function maskSecret(secret: string | null): string {
  if (secret === null) return FULLY_MASKED;
  const chars = [...secret];
  if (chars.length < MIN_PARTLY_MASKED_CHARS) return FULLY_MASKED;
  const masked = `${chars.slice(0, 4).join('')}…${chars.slice(-2).join('')}`;
  return isMaskedValue(masked) ? masked : FULLY_MASKED;
}
