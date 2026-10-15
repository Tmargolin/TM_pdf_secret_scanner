# Scanner library

Purpose: pure scan logic used by the offscreen document.
Files: `src/scanner/extract.ts`, `chunker.ts`, `api-client.ts`, `parse.ts`,
`aggregate.ts`, `mask.ts`
Design: `DESIGN.md` §4, §4.2, §5

## Modules
| Module | In → Out |
|---|---|
| `extract.ts` | PDF bytes → text per page (`extractText`, throws; `extractPages`, never throws → `{ ok, pages }` or `{ ok: false, code }`); `DOCUMENT_OPTIONS` (`isEvalSupported: false`, no fonts, no XFA, no canvas); document always destroyed; optional `worker` (shared) and `signal` (abort destroys the document). `PasswordException` → `PDF_ENCRYPTED`; any other error → `PDF_INVALID`; only whitespace → `NO_TEXT_LAYER`; owner-password-only files open and are scanned |
| `chunker.ts` | `joinPages` (pages → one text + `pageStarts`), `pageAt` / `pagesInRange` (offset → page, binary search), `chunkText(text, { chunkSize, chunkOverlap, maxRequestBytes })` → `{ start, end, text }[]`: ≤ `chunkSize` code points and ≤ `maxRequestBytes` JSON body (`requestBodyBytes`, `jsonUtf8Bytes`); ends after whitespace (blank line > line break > space, best in the window's second half), never inside a token or a PEM block (`findPemBlocks`), forced cut only for unbroken spans; overlap snapped to a word start; whitespace-only chunks dropped. `truncateText(text, maxTextChars)` → the first `maxTextChars` code points + `textChars` / `scannedChars` / `truncated` (→ `TEXT_TRUNCATED`) |
| `api-client.ts` | `createApiClient({ fetch, log, sleep?, random? }).scanChunk(text, { apiUrl, appId, requestTimeoutMs, retries }, signal)` → `{ kind: 'ok', secrets, characters, chunksRequired }` \| `{ kind: 'too-large' }` (413) \| `{ kind: 'error', code, detail? }`. Retries network errors, timeouts, 429, 5xx (back-off 0.5 s × 2ⁿ + ≤ 25 % jitter, or Retry-After, ≤ 10 s); 401 → `API_UNAUTHORIZED`, bad 200 body → `API_BAD_RESPONSE`, other status → `API_HTTP_ERROR` — no retry. Empty APP-ID → `NOT_CONFIGURED` without a call. `redirect: 'error'`, `credentials: 'omit'`. Job signal aborts → rejects. Global limiter (round-robin): 6.6; splitting: 6.5 |
| `parse.ts` | `parseProtectResponse(body)` (HTTP 200 body) → `{ ok, secrets: RawFinding[] (unmasked: entityType, category, entity \| null), characters, chunksRequired }` from `result.prompt.findings.Secrets` / `Token Limitation[0]`, or `API_BAD_RESPONSE`; a malformed Secrets entry is still a secret; labels ≤ 100 chars |
| `aggregate.ts` | `scanStatus(secretsFound, errors)`: secrets → `secrets`; else any error (text not checked, e.g. `TEXT_TRUNCATED`, failed chunk) → `error`; else `clean`. `uniqueErrors` (each code once). Findings → de-duplicated, with pages, masked: 6.7 |
| `mask.ts` | secret → first 4 + `…` + last 2; < 12 chars → `FULLY_MASKED` (`••••••`); output must pass `isMaskedValue` (`messages.ts`) |

## Rules
- pdf.js: `pdfjs-dist/legacy/build/pdf.mjs` only (D37), passed in; never log or
  store extracted text.
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
