# MAIN-world hooks

Purpose: see every `File` a page obtains; forward it to the content script.
Files: `src/main-world/handoff-hooks.ts`
Design: `DESIGN.md` §3

## Wrapped APIs
- `HTMLInputElement.prototype.files` (getter)
- `DataTransfer.prototype.files` (getter)
- `DataTransferItem.prototype.getAsFile`
- `FileSystemFileEntry.prototype.file`
- `FileSystemFileHandle.prototype.getFile`

## Output
`File` objects → content script over the `MessageChannel` port received at
`document_start` (marker message from the content script). Buffer until the
port arrives.

## Rules
- Call the original, return its result unchanged, never throw, never await.
- Forward each `File` object once (`WeakSet`).
- No `chrome.*` (not available), no byte reading, no parsing.
- Injected by registration from the service worker (`docs/agents/service-worker.md`),
  `world: MAIN`, `runAt: document_start`, `allFrames`, `matchOriginAsFallback`.

## Tests
`tests/browser/` (Vitest browser mode). `FileSystemFileHandle` via OPFS;
`FileSystemFileEntry` via stand-in.
