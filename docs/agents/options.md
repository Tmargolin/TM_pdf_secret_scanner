# Options page

Purpose: edit settings, APP-ID and the site allow list.
Files: `src/options/options.html`, `options.ts` (DOM wiring only), `form.ts`
(pure: field list, Settings ↔ form text, defaults, error texts, save),
`sites.ts` (pure + injected `PermissionsApi`: normalise, add, remove)
Design: `DESIGN.md` §3.1, §6, §8

## Behaviour
- Reads/writes `chrome.storage.local` via `src/shared/settings.ts`.
- Save: `saveForm` re-reads stored settings and overrides only the form's
  fields (APP-ID, API URL, numeric settings) – never `allowedSites`;
  validation errors shown per field (`humanize`: labels, not keys); nothing
  written if invalid. "Restore defaults" fills defaults except the APP-ID; only
  Save stores them. Banner while not configured (no APP-ID).
- Add site: normalise input (host, `*.host`, URL or pattern → `*://host/*`;
  punycode; port/path dropped) → duplicate check against the shown list →
  `chrome.permissions.request` as the **first await** (user gesture) → save
  `allowedSites` (fresh read). Denied → nothing saved.
- Remove: save list first → `chrome.permissions.remove`, skipped when a
  remaining site overlaps (same host or sub/parent domain); errors (manifest
  permissions such as dev localhost) → warning logged, not fatal.
- Chrome may keep a removed site under Details → Site access and re-grant it
  without a prompt (observed; README) – expected, not a bug.
- Site list re-rendered on `storage.onChanged` (`local`).
- Known limit: a grant kept because of an overlap is not given back later
  (harmless – scripts run only on allow list ∩ granted).
- Does not register scripts (service worker does).
- Shows a red banner while `chrome.notifications.getPermissionLevel()` is not
  `granted` (updated on `onPermissionLevelChanged`); a help line reminds that
  OS-level blocking cannot be detected.
- Opens on first install.

## Rules
- APP-ID in a password field; never logged.
- API URL: `https://` and host in `host_permissions`; dev builds also
  `http://localhost:<port>`.

## Tests
`tests/unit/` with `chrome-fake`.
