# Message protocol

Definitions and validators: `src/shared/messages.ts`.
Design: `DESIGN.md` §2 (message flows), §8 (validation)

| Message | From → To | Channel | Payload |
|---|---|---|---|
| (marker + port) | content → MAIN world | `window.postMessage` | `MessagePort` |
| `File` | MAIN world → content | `MessagePort` | `File` |
| `SCAN_REQUEST` | content → offscreen | port `scan-batch` | `scanId, batchId, fileName, size, base64 \| skipped` |
| `OFFSCREEN_READY` | offscreen → service worker | `runtime.sendMessage` | – (reply: settings) |
| `SETTINGS_UPDATED` | service worker → offscreen | `runtime.sendMessage` | settings |
| `SHOW_RESULT` | offscreen → service worker | `runtime.sendMessage` | batch: origin, per-file status, masked findings, errors |
| `ENSURE_OFFSCREEN` | content → service worker | `runtime.sendMessage` | – |
| `SCAN_INTERRUPTED` | content → service worker | `runtime.sendMessage` | batchId, file names |

## Rules
- Every receiver validates sender and payload with `messages.ts` validators.
- No `externally_connectable`.
- Results never go back to the page.
- New message: add type + validator + row here, in one commit.
