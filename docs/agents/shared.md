# Shared modules

Files: `src/shared/settings.ts`, `messages.ts`, `types.ts`, `safe-logger.ts`, `scan-port.ts`, `notification-permission.ts`
Design: `DESIGN.md` §4 (result model), §6, §8

| Module | Holds |
|---|---|
| `settings.ts` | Settings schema, defaults, validation, load/save (single source of truth for §6) |
| `messages.ts` | Message types + runtime validators (catalogue: `docs/agents/protocol.md`) |
| `types.ts` | `ScanResult`, `ErrorCode`, job and finding types |
| `scan-port.ts` | `ScanPort`: the parts of `chrome.runtime.Port` both ends of the scan port use (tests pass fakes) |
| `notification-permission.ts` | `notificationsBlocked(level)`, `logNotificationPermission` (Chrome-level block only) |
| `safe-logger.ts` | The only logger; redacts text, bodies, secrets, APP-ID |
| `i18n.ts` | `MESSAGES` (every text key the code uses → number of substitutions; mirrors `_locales/en/messages.json`), `MessageKey`, `GetMessage`, `errorMessageKey(code)` → `error_<CODE>` |

## Rules
- New setting: add to `settings.ts` (default + validation), `DESIGN.md` §6,
  README defaults, options page.
- New error code: add to `types.ts`, its reason `error_<CODE>` in `_locales/en/messages.json` and in `MESSAGES` (`i18n.ts`) – typecheck fails until both exist.
- New text: key in `_locales/en/messages.json` and in `MESSAGES` (`i18n.ts`) with its number of substitutions; read only through `GetMessage`.
- `console.*` is not used outside `safe-logger.ts`.

## Tests
`tests/unit/`. Coverage threshold 80 %.
