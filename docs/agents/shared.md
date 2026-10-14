# Shared modules

Files: `src/shared/settings.ts`, `messages.ts`, `types.ts`, `safe-logger.ts`, `scan-port.ts`
Design: `DESIGN.md` §4 (result model), §6, §8

| Module | Holds |
|---|---|
| `settings.ts` | Settings schema, defaults, validation, load/save (single source of truth for §6) |
| `messages.ts` | Message types + runtime validators (catalogue: `docs/agents/protocol.md`) |
| `types.ts` | `ScanResult`, `ErrorCode`, job and finding types |
| `scan-port.ts` | `ScanPort`: the parts of `chrome.runtime.Port` both ends of the scan port use (tests pass fakes) |
| `safe-logger.ts` | The only logger; redacts text, bodies, secrets, APP-ID |

## Rules
- New setting: add to `settings.ts` (default + validation), `DESIGN.md` §6,
  README defaults, options page.
- New error code: add to `types.ts`, notification text in `_locales`.
- `console.*` is not used outside `safe-logger.ts`.

## Tests
`tests/unit/`. Coverage threshold 80 %.
