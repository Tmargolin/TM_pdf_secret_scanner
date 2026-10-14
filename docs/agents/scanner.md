# Scanner library

Purpose: pure scan logic used by the offscreen document.
Files: `src/scanner/extract.ts`, `chunker.ts`, `api-client.ts`, `parse.ts`,
`aggregate.ts`, `mask.ts`
Design: `DESIGN.md` §4, §4.2, §5

## Modules
| Module | In → Out |
|---|---|
| `extract.ts` | PDF bytes → text per page; errors `PDF_ENCRYPTED`, `PDF_INVALID`, `NO_TEXT_LAYER` |
| `chunker.ts` | page texts → chunks with page map; truncation at `maxTextChars` |
| `api-client.ts` | chunk → API response; timeout, retries, global limiter (round-robin), bounded splitting |
| `parse.ts` | API JSON → findings (`result.prompt.findings.Secrets`) |
| `aggregate.ts` | findings → de-duplicated findings with pages + `ScanResult` status |
| `mask.ts` | secret → first 4 + `…` + last 2; < 12 chars fully masked |

## Rules
- Chunk ends only at whitespace (blank line > line break > space); never inside
  a token or a PEM block.
- Bounded splitting when a chunk is cut short (response
  `Token Limitation[0].characters` < characters sent, or HTTP 413): shrink
  only, floor `MIN_CHUNK_CHARS` (500), never above `chunkSize`; failure →
  `CHUNK_TOO_LARGE`.
- `chunkSize` ≤ `MAX_CHUNK_CHARS` (50,000): the API silently stops scanning
  long texts (`DESIGN.md` §5).
- Never send empty or whitespace-only chunks.
- HTTP 401 → `API_UNAUTHORIZED`; `status !== "success"` or
  `result.prompt === null` → `API_BAD_RESPONSE`.
- Ignore `action` / `passed` / `violations`.
- Never log text, bodies or entities.

## Settings used
`chunkSize`, `chunkOverlap`, `maxRequestBytes`, `maxTextChars`,
`maxConcurrency`, `requestTimeoutMs`, `retries`, `apiUrl`, `appId`.

## Tests
`tests/unit/` – fixtures `tests/fixtures/api-*.json`, mocked `fetch`, fake
timers. Coverage threshold 80 %.
