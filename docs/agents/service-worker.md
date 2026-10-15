# Service worker

Purpose: configuration and display only – never on the scan path.
Files: `src/background/service-worker.ts` (wiring), `offscreen-manager.ts`,
`settings-bridge.ts`, `script-registry.ts`, `notifications.ts`, `result-notifications.ts`
Design: `DESIGN.md` §2, §3.1, §7

## Responsibilities
| Module | Does | Triggers |
|---|---|---|
| `offscreen-manager.ts` | `ensureOffscreen()` single-flight (`runtime.getContexts`); "only a single offscreen document" error = success | service-worker start, `onInstalled`, `onStartup`, `ENSURE_OFFSCREEN` (content scripts only; reply `{ ok }`) |
| `settings-bridge.ts` | Reply to `OFFSCREEN_READY` (offscreen sender only) with `SETTINGS_UPDATED`; push `SETTINGS_UPDATED` when `settings` changes in `storage.local` (no document → skipped); registers the APP-ID with the safe logger | `OFFSCREEN_READY`, `storage.onChanged` |
| `script-registry.ts` | `reconcile()`: register hooks (`pss-hooks`, `main-world/hooks.js`, MAIN) + content script (`pss-content`, `content/content.js`, ISOLATED), same matches for sites in `allowedSites` **and** granted (`permissions.contains`); none → unregister; runs chained, never rejects | `onInstalled`, `onStartup`, `permissions.onAdded/onRemoved`, `storage.onChanged` when `allowedSites` changed (`allowListChanged`) |
| `notifications.ts` | `createNotifier(api, log)`: `showResult(SHOW_RESULT)`, `showInterrupted(SCAN_INTERRUPTED)` → `chrome.notifications.create` for each spec (icon `chrome.runtime.getURL('icons/icon-128.png')` – never relative; `priority: 2`, `requireInteraction: true`); refused → logged, never throws. `onClicked(id)`: `opensSettings(id)` → `openOptionsPage()` + clear | `SHOW_RESULT` (offscreen only), `SCAN_INTERRUPTED` (content scripts only), `notifications.onClicked` |
| `result-notifications.ts` | `notificationsFor(message, getMessage)` → 0–2 specs: clean → none; secrets → `batch-<batchId>-secrets` (≤ 3 findings + "+N more", notes on unchecked text, advice); not fully checked → `batch-<batchId>-failed` (reasons; several files: one line each, ≤ 4 + "+N more"); both → both (D39); any `NOT_CONFIGURED` → one `not-configured` notification (fixed id); a rejected APP-ID → id ends in `-settings`. `interruptedNotification` (id `batch-<batchId>-failed`, so a late result replaces it). `opensSettings(id)`. `displayFileName` (no control/format chars, ≤ 60 chars, end kept), `siteName`, `reasons` | – |

## Rules
- Notifications blocked in Chrome (`getPermissionLevel` ≠ `granted`): warning
  logged at every start and on `onPermissionLevelChanged`
  (`src/shared/notification-permission.ts`). OS-level blocking is not detectable.
- `onInstalled` with reason `install` (first install only) → `runtime.openOptionsPage()`.
- Hold no scan state; every handler is a short event.
- Accept `SHOW_RESULT` / `OFFSCREEN_READY` only from the offscreen document URL;
  `ENSURE_OFFSCREEN` / `SCAN_INTERRUPTED` only from content scripts.
- Only this context registers content scripts.
- Notification texts from `_locales/en/messages.json`; file names truncated to
  60 chars, control/bidi chars stripped; site = `port.sender` origin.

## Tests
`tests/unit/` with `chrome-fake`.
