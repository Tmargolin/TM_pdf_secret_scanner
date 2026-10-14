# MAIN-world hooks

Purpose: see every `File` a page obtains; forward it to the content script.
Files: `src/main-world/handoff-hooks.ts` (`installHooks(win, forward)` – wraps
the prototypes of `win`; returns the wrapped API names). Entry script,
MessageChannel hand-over and registration: step 4.4.
Design: `DESIGN.md` §3

## Wrapped APIs
- `HTMLInputElement.prototype.files` (getter)
- `DataTransfer.prototype.files` (getter)
- `DataTransferItem.prototype.getAsFile`
- `DataTransferItem.prototype.webkitGetAsEntry` → lazily (D36): file entry
  `file`, directory entry `createReader` / `getFile` / `getDirectory`, reader
  `readEntries` – their prototypes are not globals in Chrome
- `FileSystemFileHandle.prototype.getFile`

## Output
`File` objects → content script over the `MessageChannel` port received at
`document_start` (marker message from the content script). Buffer until the
port arrives.

## Rules
- Wrap getters with `Object.defineProperty` keeping the setter and flags;
  skip properties that are missing or non-configurable.
- Methods (`wrapMethod`): return value → forward and return it (`getAsFile`);
  callback → wrap only the success callback, same arguments, original return
  (`withCallback`: entry `file`, `readEntries`, `getFile`/`getDirectory`);
  Promise → return the **same** promise, forward from a side `.then` that also
  swallows its rejection (`FileSystemFileHandle.getFile`; thenable check, not
  `instanceof`).
- Entry prototypes are wrapped once each, when the first object of that type
  passes a hook, before the page receives it (`wrapOnce`, `WeakMap`).
- `FileSystemFileHandle` may be missing (secure contexts only) → skipped.
- Call the original, return its result unchanged, never throw, never await.
- Forward each `File` object once (`forwardOnce`, a `WeakSet` per
  `installHooks` call): repeated reads and the same File through two hooks
  count once; choosing the file again (new File object) is forwarded again.
- No `chrome.*` (not available), no byte reading, no parsing.
- Injected by registration from the service worker (`docs/agents/service-worker.md`),
  `world: MAIN`, `runAt: document_start`, `allFrames`, `matchOriginAsFallback`.

## Tests
`tests/browser/` (Vitest browser mode). `FileSystemFileHandle` via OPFS;
entry chain (D36) via stand-ins; real folder drops: manual.
