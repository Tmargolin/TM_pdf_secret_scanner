# Message protocol

Definitions and validators: `src/shared/messages.ts`.
Design: `DESIGN.md` §2 (message flows), §8 (validation)

| Message | From → To | Channel | Payload |
|---|---|---|---|
| (marker + port) | content → MAIN world | `window.postMessage` | `{ marker: HANDOFF_MARKER }` + one `MessagePort` |
| `File` | MAIN world → content | `MessagePort` | `File` |
| `SCAN_REQUEST` | content → offscreen | port `scan-batch` | `scanId, batchId, fileName, size, base64` or `skipped: 'FILE_TOO_LARGE'` (no bytes) |
| `BATCH_END` | content → offscreen | port `scan-batch` | `batchId, fileCount` – all files of the batch sent |
| `OFFSCREEN_READY` | offscreen → service worker | `runtime.sendMessage` | – (reply: `SETTINGS_UPDATED`) |
| `SETTINGS_UPDATED` | service worker → offscreen | `runtime.sendMessage` | settings |
| `SHOW_RESULT` | offscreen → service worker | `runtime.sendMessage` | `batchId, origin` (from `port.sender`), `results: ScanResult[]` (masked findings only) |
| `ENSURE_OFFSCREEN` | content → service worker | `runtime.sendMessage` | – (reply: `{ ok }`) |
| `SCAN_INTERRUPTED` | content → service worker | `runtime.sendMessage` | `batchId, fileNames` |

## Rules
- Every receiver validates the payload with `parseScanPortMessage` /
  `parseRuntimeMessage` and the sender with `isFromContentScript` /
  `isFromOffscreen` / `isFromExtensionContext` (`SETTINGS_UPDATED`: our id,
  no tab); invalid messages are ignored.
- Bytes: base64 must decode to exactly `size` bytes; `size` ≤ 45 MB.
- Result types (`ScanResult`, `ErrorCode`, `MaskedFinding`): `src/shared/types.ts`.
- No `externally_connectable`.
- Results never go back to the page.
- New message: add type + validator + row here, in one commit.
