// API response body → secrets found (DESIGN.md §5, docs/agents/scanner.md).
// Only the body of an HTTP 200 is parsed here; HTTP errors (401, 413, 5xx…)
// are the API client's job (6.4).
//
//   secret detected ⇔ result.prompt.findings.Secrets is a non-empty array
//   (action / passed / violations are ignored – they reflect server policy)
//   status !== "success", no result.prompt object, no findings object, or
//   Secrets present but not an array → API_BAD_RESPONSE
//
// The entities are the secrets in plain text: they stay in the offscreen
// document, are masked by aggregation and are never logged.

/** A secret as the API reported it – unmasked. */
export interface RawFinding {
  /** e.g. "AWS credentials" (at most 100 characters). */
  entityType: string;
  /** e.g. "Access Tokens" (at most 100 characters). */
  category: string;
  /** The secret itself; null if the API did not give it as a string (it is then shown fully masked). */
  entity: string | null;
}

export type ParsedResponse =
  | {
      ok: true;
      secrets: RawFinding[];
      /** Token Limitation[0].characters – how much text the API says it took; null if absent. */
      characters: number | null;
      /** Token Limitation[0].chunks_required; > 1 means our chunk is larger than the server prefers. */
      chunksRequired: number | null;
    }
  | { ok: false; code: 'API_BAD_RESPONSE' };

/** Longest entity type / category kept – the limit SHOW_RESULT accepts. */
export const LABEL_MAX_CHARS = 100;
const UNKNOWN_TYPE = 'Secret';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const label = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, LABEL_MAX_CHARS) : fallback);
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * A Secrets entry → RawFinding. A malformed entry is still a secret (the
 * array is non-empty, so the verdict stands): it is kept with what can be read.
 */
function toFinding(item: unknown): RawFinding {
  const entry = isRecord(item) ? item : {};
  const entity = typeof entry['entity'] === 'string' && entry['entity'] !== '' ? entry['entity'] : null;
  return { entityType: label(entry['entity_type'], UNKNOWN_TYPE), category: label(entry['category'], ''), entity };
}

export function parseProtectResponse(body: unknown): ParsedResponse {
  const bad = { ok: false, code: 'API_BAD_RESPONSE' } as const;
  if (!isRecord(body) || body['status'] !== 'success') return bad;
  const result = body['result'];
  if (!isRecord(result)) return bad;
  const prompt = result['prompt'];
  if (!isRecord(prompt)) return bad; // null for empty text – we never send that

  // A verdict always comes with a findings object (Token Limitation at least);
  // without one we cannot tell "clean" from "format changed" – never assume clean.
  const findings = prompt['findings'];
  if (!isRecord(findings)) return bad;
  const secrets = findings['Secrets'];
  if (secrets !== undefined && !Array.isArray(secrets)) return bad;

  const limitation = Array.isArray(findings['Token Limitation']) ? findings['Token Limitation'][0] : undefined;
  const limits = isRecord(limitation) ? limitation : {};
  return {
    ok: true,
    secrets: (secrets ?? []).map(toFinding),
    characters: count(limits['characters']),
    chunksRequired: count(limits['chunks_required']),
  };
}
