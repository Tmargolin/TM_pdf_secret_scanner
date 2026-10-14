# Content script (isolated world)

Purpose: turn forwarded files into scan batches and send them to the offscreen
document. No UI.
Files: `src/content/index.ts` (entry, built to `content/content.js`, classic script), `bridge.ts` (MessageChannel), `batcher.ts`
Design: `DESIGN.md` §3, §2 (message flows)

## Input
`File` objects from `main-world-hooks` over `MessageChannel`.

## Output
Port `chrome.runtime.connect({ name: 'scan-batch' })` → `SCAN_REQUEST` per file
(`docs/agents/protocol.md`).

## Behaviour
1. PDF = first 5 bytes `%PDF-`; others ignored.
2. Size > `maxFileSizeMB` → send name + size only, `skipped: 'FILE_TOO_LARGE'`.
3. Files within the same task / 300 ms → one batch (`batchId`), one port.
4. Bytes sent as base64.
5. Connect fails → `ENSURE_OFFSCREEN` to service worker → retry once.
   Still failing or port drops mid-scan → `SCAN_INTERRUPTED` to service worker.

## Rules
- Treat data from the MAIN world as untrusted (must be `File`, size-checked).
- Never display anything in the page.

## Tests
`tests/browser/` (filter, batching), `tests/unit/` with `chrome-fake` (port, retry).
