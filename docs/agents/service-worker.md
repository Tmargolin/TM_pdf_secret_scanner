# Service worker

Purpose: configuration and display only – never on the scan path.
Files: `src/background/service-worker.ts` (wiring), `offscreen-manager.ts`,
`settings-bridge.ts`, `script-registry.ts`, `notifications.ts`
Design: `DESIGN.md` §2, §3.1, §7

## Responsibilities
| Module | Does | Triggers |
|---|---|---|
| `offscreen-manager.ts` | `ensureOffscreen()` single-flight (`runtime.getContexts`); "only a single offscreen document" error = success | service-worker start, `onInstalled`, `onStartup`, `ENSURE_OFFSCREEN` (content scripts only; reply `{ ok }`) |
| `settings-bridge.ts` | Reply to `OFFSCREEN_READY` (offscreen sender only) with `SETTINGS_UPDATED`; push `SETTINGS_UPDATED` when `settings` changes in `storage.local` (no document → skipped); registers the APP-ID with the safe logger | `OFFSCREEN_READY`, `storage.onChanged` |
| `script-registry.ts` | `reconcile()`: register hooks + content script (id `pss-content`, `content/content.js`) for sites in `allowedSites` **and** granted (`permissions.contains`); none → unregister; runs chained, never rejects | `onInstalled` (step 2); `onStartup`, `storage.onChanged`, `permissions.onAdded/onRemoved` (step 3) |
| `notifications.ts` | `chrome.notifications.create` (id `batch-<batchId>`, icon `chrome.runtime.getURL('icons/icon-128.png')` – never relative, texts via `chrome.i18n`) from `SHOW_RESULT`, `SCAN_INTERRUPTED`, not-configured; click → options page. Step 2: one skeleton notification per `SHOW_RESULT` ("received, not checked") | messages |

## Rules
- Hold no scan state; every handler is a short event.
- Accept `SHOW_RESULT` / `OFFSCREEN_READY` only from the offscreen document URL;
  `ENSURE_OFFSCREEN` / `SCAN_INTERRUPTED` only from content scripts.
- Only this context registers content scripts.
- Notification texts from `_locales/en/messages.json`; file names truncated to
  60 chars, control/bidi chars stripped; site = `port.sender` origin.

## Tests
`tests/unit/` with `chrome-fake`.
