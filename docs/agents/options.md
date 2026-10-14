# Options page

Purpose: edit settings, APP-ID and the site allow list.
Files: `src/options/options.html`, `options.ts` (DOM wiring only), `form.ts`
(pure: field list, Settings ↔ form text, defaults, error texts, save)
Design: `DESIGN.md` §3.1, §6, §8

## Behaviour
- Reads/writes `chrome.storage.local` via `src/shared/settings.ts`.
- Save: `saveForm` re-reads stored settings and overrides only the form's
  fields (APP-ID, API URL, numeric settings) – never `allowedSites`;
  validation errors shown per field (`humanize`: labels, not keys); nothing
  written if invalid. "Restore defaults" fills defaults except the APP-ID; only
  Save stores them. Banner while not configured (no APP-ID).
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
