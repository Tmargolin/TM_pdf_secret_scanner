# Offscreen document

Purpose: owns every scan – jobs, limits, extraction, scanning, results.
Files: `src/offscreen/offscreen.html`, `offscreen.ts` (wiring), `jobs.ts`
(`createJobRegistry`: admission, queue cap, FIFO start by size, timeout,
isolation), `results.ts` (`toShowResult`, `placeholderOutcome`), `batch-receiver.ts` (scan port: collect batch, `BATCH_ACCEPTED`,
`runBatch`, `BATCH_DONE`, close), `settings-client.ts` (settings cache); uses
`src/scanner/*`
Design: `DESIGN.md` §2, §4, §4.1

## Inputs
- Ports named `scan-batch` from content scripts only (`isFromContentScript`,
  origin from `port.sender`) → `SCAN_REQUEST`… `BATCH_END`. Invalid message,
  mixed batch ids, duplicate scan id, > 100 files or a count mismatch → port
  closed, batch dropped. Page closes before `BATCH_END` → batch dropped; after
  it → batch keeps running.
- Settings (`settings-client.ts`): sends `OFFSCREEN_READY` on load, retries
  after 0.5 / 2 / 5 s; accepts `SETTINGS_UPDATED` only from our own non-tab
  contexts (`isFromExtensionContext`). Jobs wait on `ready()`; APP-ID is
  registered with the safe logger.

## Outputs
- On the scan port: `BATCH_ACCEPTED` after `BATCH_END` with all files
  received; `BATCH_DONE` when every job of the batch ended, then
  `port.disconnect()`.
- `SHOW_RESULT` (one per batch, masked findings only) → service worker, sent
  before `BATCH_DONE`. Built in `results.ts` (step 2: `placeholderResults` –
  too-large files `FILE_TOO_LARGE`, others unscanned).
- `fetch` to the API (via `src/scanner/api-client.ts`).

## Job model
`{ scanId, batchId, fileName, size, origin, tabId, frameId, state }`,
states `queued → running → done | failed`. `submitBatch(batch)` → one
`ScanResult` per file in batch order (never rejects) → one `SHOW_RESULT`.

## Limits (global, read from settings on every decision)
- Arrival: `skipped` → `FILE_TOO_LARGE` at once; pending bytes + file >
  `maxQueuedMB` → `QUEUE_FULL` at once (bytes dropped).
- Start (FIFO): running bytes + file ≤ `maxInFlightMB`, or nothing running.
- `jobTimeoutMs` from the job's start (D38) → `SCAN_TIMEOUT`, `AbortSignal`
  aborted; the work must stop.
- Exception in a job → `SCAN_INTERRUPTED` for that job only (D38).
- Bytes released when the job starts work / ends.
- `maxParallelExtractions`, one shared pdf.js worker: 5.4.

## Rules
- Only `chrome.runtime` is available here (no `chrome.storage`, no notifications).
- Page disconnect does not stop jobs.
- Drop PDF text and API responses when a job ends.
- pdf.js: `isEvalSupported: false`.
- No secret is reported clean if any part was unchecked (status rules: `DESIGN.md` §4).

## Tests
`tests/unit/` (job registry, limits, timeouts; `chrome-fake`), extraction tests
on `tests/fixtures/*.pdf`.
