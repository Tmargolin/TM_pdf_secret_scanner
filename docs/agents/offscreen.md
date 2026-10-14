# Offscreen document

Purpose: owns every scan – jobs, limits, extraction, scanning, results.
Files: `src/offscreen/offscreen.html`, `offscreen.ts` (wiring, ports, job
registry, limits), `settings-client.ts` (settings cache); uses `src/scanner/*`
Design: `DESIGN.md` §2, §4, §4.1

## Inputs
- Ports named `scan-batch` from content scripts only (`sender.tab` set) →
  `SCAN_REQUEST`.
- Settings (`settings-client.ts`): sends `OFFSCREEN_READY` on load, retries
  after 0.5 / 2 / 5 s; accepts `SETTINGS_UPDATED` only from our own non-tab
  contexts (`isFromExtensionContext`). Jobs wait on `ready()`; APP-ID is
  registered with the safe logger.

## Outputs
- `SHOW_RESULT` (one per batch, masked findings only) → service worker.
- `fetch` to the API (via `src/scanner/api-client.ts`).

## Job model
`{ scanId, batchId, tabId, frameId, origin, fileName, size, state }`,
states `queued → extracting → scanning → done | failed`.

## Limits (global)
`maxConcurrency`, `maxParallelExtractions`, `maxInFlightMB`, `maxQueuedMB`
(→ `QUEUE_FULL`), `jobTimeoutMs` (→ `SCAN_TIMEOUT`). One shared pdf.js worker;
destroy loading task when a job ends.

## Rules
- Only `chrome.runtime` is available here (no `chrome.storage`, no notifications).
- Page disconnect does not stop jobs.
- Drop PDF text and API responses when a job ends.
- pdf.js: `isEvalSupported: false`.
- No secret is reported clean if any part was unchecked (status rules: `DESIGN.md` §4).

## Tests
`tests/unit/` (job registry, limits, timeouts; `chrome-fake`), extraction tests
on `tests/fixtures/*.pdf`.
