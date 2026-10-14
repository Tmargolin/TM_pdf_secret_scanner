# Options page

Purpose: edit settings, APP-ID and the site allow list.
Files: `src/options/options.html`, `options.ts`
Design: `DESIGN.md` §3.1, §6, §8

## Behaviour
- Reads/writes `chrome.storage.local` via `src/shared/settings.ts`.
- Add site: normalise pattern → `chrome.permissions.request` → save
  `allowedSites`. Remove: save list → `chrome.permissions.remove`.
- Does not register scripts (service worker does).
- Shows a warning when `chrome.notifications.getPermissionLevel()` is denied.
- Opens on first install.

## Rules
- APP-ID in a password field; never logged.
- API URL: `https://` and host in `host_permissions`; dev builds also
  `http://localhost:<port>`.

## Tests
`tests/unit/` with `chrome-fake`.
