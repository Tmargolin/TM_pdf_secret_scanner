# Offscreen document

Purpose: owns every scan – jobs, limits, extraction, scanning, results.
Files: `src/offscreen/offscreen.html`, `offscreen.ts` (wiring), `jobs.ts`
(`createJobRegistry`: admission, queue cap, FIFO start by size, timeout,
isolation), `extractor.ts` (`createExtractor`: `maxParallelExtractions`, one
shared pdf.js worker), `limiter.ts` (`createLimiter`: FIFO concurrency
limit, abortable wait), `scan-job.ts` (`createScanJob`: the work per job – the
scan pipeline), `results.ts` (`toShowResult`, `outcomeCode` for the dev log), `batch-receiver.ts` (scan port: collect batch, `BATCH_ACCEPTED`,
`runBatch`, `BATCH_DONE`, close; `BATCH_REJECTED` while closing),
`idle-monitor.ts` (`createIdleMonitor`: idle timer, closing state, safety
valve), `settings-client.ts` (settings cache); uses
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

## Idle close (D42)
- Work = a scan port from open until its batch is dropped, refused or done
  (`BatchActivity.begin()` → end function, idempotent). A batch that keeps
  running after the page closed still counts until `runBatch` settles.
- No work for `offscreenIdleTimeoutSec` (`0` = never; timer starts once the
  settings arrive and restarts on every `SETTINGS_UPDATED`) → **closing**:
  `OFFSCREEN_IDLE` to the service worker, in the same task.
- While closing, a new port gets `BATCH_REJECTED {batchId, reason:'closing'}`
  on its first valid message and is closed; nothing is accepted.
- Still open `CLOSE_GRACE_MS` (5 s) later → closing ends, idle timer restarts.

## Outputs
- On the scan port: `BATCH_ACCEPTED` after `BATCH_END` with all files
  received; `BATCH_DONE` when every job of the batch ended, then
  `port.disconnect()`.
- `SHOW_RESULT` (one per batch, masked findings only) → service worker, sent
  before `BATCH_DONE`. Built in `results.ts` from the job results.
- `fetch` to the API (via `src/scanner/api-client.ts`), at most
  `maxConcurrency` at once across all jobs.

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
- Work per job (`scan-job.ts`, settings read once per job): empty APP-ID →
  `NOT_CONFIGURED` (nothing extracted or sent); extract → PDF error code;
  `joinPages` → `truncateText` (`TEXT_TRUNCATED`) → `chunkText` at the
  session's effective size (`createChunkSizer`) → every chunk at once through
  `scanWithSplitting` → the one shared `createApiLimiter(maxConcurrency)` (key:
  `scanId`) → `scanChunk` → `aggregateFindings` → `scanStatus` + stats. The
  text and plain secrets never leave the call; logs carry counts only.
- `maxParallelExtractions` PDFs parsed at once (`limiter.ts`, FIFO, read at
  every start); a job that times out while waiting leaves the queue, one that
  times out while parsing has its pdf.js document destroyed.
- One shared `PDFWorker` (`verbosity` 0), created on first use, re-created
  only if destroyed; `GlobalWorkerOptions.workerSrc` =
  `chrome.runtime.getURL('offscreen/pdf.worker.mjs')`.

## Rules
- Only `chrome.runtime` is available here (no `chrome.storage`, no notifications).
- Page disconnect does not stop jobs.
- Drop PDF text and API responses when a job ends.
- pdf.js: `isEvalSupported: false`.
- No secret is reported clean if any part was unchecked (status rules: `DESIGN.md` §4).

## Tests
`tests/unit/` (job registry, limits, timeouts; `chrome-fake`), extraction tests
on `tests/fixtures/*.pdf`.
