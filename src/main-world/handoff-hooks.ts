// Hand-off hooks – run in the page's own JavaScript world (MAIN) at
// document_start (DESIGN.md §3, docs/agents/main-world-hooks.md).
//
// Principle: catch the hand-off, not the event. However a file reaches a
// page, the page's code has to obtain the File object through one of a few
// browser APIs. We wrap those APIs on their prototypes: call the original,
// pass the result to `forward`, return the original result unchanged.
//
// Wrapper rules (never break the page):
//   - return exactly what the original returned,
//   - never throw (all our work is inside try/catch),
//   - never change timing (forward is fire-and-forget, nothing is awaited).
// No chrome.* here (not available in the MAIN world), no byte reading.

/** Receives every File the page obtains. Must not throw; must return at once. */
export type ForwardFile = (file: File) => void;

/**
 * The window whose prototypes are wrapped (the page's window, or a test
 * frame's). FileSystemFileHandle only exists in secure contexts (https,
 * localhost). The entry types of folder drops (FileSystemFileEntry…) are not
 * globals in Chrome at all – they are reached through the objects (D36).
 */
export type HookWindow = Pick<typeof globalThis, 'HTMLInputElement' | 'DataTransfer' | 'DataTransferItem' | 'FileList' | 'File'> &
  Partial<Pick<typeof globalThis, 'FileSystemFileHandle'>>;

/** Forwards every File in a FileList (or nothing for null). */
function forwardList(win: HookWindow, list: unknown, forward: ForwardFile): void {
  if (!(list instanceof win.FileList)) return;
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    if (file instanceof win.File) forward(file);
  }
}

/**
 * Replaces a getter on a prototype with one that calls the original, hands the
 * value to `inspect`, and returns the value unchanged. The setter and the
 * other descriptor flags are kept. Returns false if the property cannot be
 * wrapped (missing or locked by the page).
 */
function wrapGetter(proto: object, property: string, inspect: (value: unknown) => void): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(proto, property);
  if (!descriptor?.get || !descriptor.configurable) return false;
  const originalGet = descriptor.get;
  Object.defineProperty(proto, property, {
    ...descriptor,
    get(this: unknown) {
      const value: unknown = originalGet.call(this);
      try {
        inspect(value);
      } catch {
        // Our problem, never the page's.
      }
      return value;
    },
  });
  return true;
}

/**
 * Replaces a method on a prototype with a wrapper built by `makeWrapper`
 * from the original. Descriptor flags are kept. Returns false if the method
 * is missing or locked.
 */
function wrapMethod(
  proto: object,
  name: string,
  makeWrapper: (original: (...args: unknown[]) => unknown) => (this: unknown, ...args: unknown[]) => unknown,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  if (typeof descriptor?.value !== 'function' || !descriptor.configurable) return false;
  Object.defineProperty(proto, name, { ...descriptor, value: makeWrapper(descriptor.value as (...args: unknown[]) => unknown) });
  return true;
}

/** (prototype, method) pairs wrapped through the lazy entry chain – each only once. */
const wrappedLazily = new WeakMap<object, Set<string>>();

function wrapOnce(proto: object, name: string, makeWrapper: Parameters<typeof wrapMethod>[2]): void {
  const names = wrappedLazily.get(proto) ?? new Set<string>();
  if (names.has(name)) return;
  if (wrapMethod(proto, name, makeWrapper)) {
    names.add(name);
    wrappedLazily.set(proto, names);
  }
}

/**
 * Wrapper factory for callback-style methods: the callback at `index` is
 * replaced by one that first hands its first argument to `inspect`, then calls
 * the page's callback with the same arguments. Anything that is not a function
 * is passed through untouched (the original reports the error).
 */
function withCallback(index: number, inspect: (value: unknown) => void): Parameters<typeof wrapMethod>[2] {
  return (original) =>
    function (this: unknown, ...args: unknown[]) {
      const pageCallback = args[index];
      if (typeof pageCallback === 'function') {
        args[index] = function (this: unknown, ...callbackArgs: unknown[]) {
          try {
            inspect(callbackArgs[0]);
          } catch {
            // Our problem, never the page's.
          }
          return (pageCallback as (...a: unknown[]) => unknown).apply(this, callbackArgs);
        };
      }
      return original.apply(this, args);
    };
}

/**
 * Folder drops (D36). Chrome does not expose FileSystemFileEntry & co. as
 * globals, so their prototypes are wrapped the first time an object of that
 * type passes through a hook – always before the page receives it:
 *   webkitGetAsEntry() → entry
 *   file entry        → file(success)          success(File)   → forward
 *   directory entry   → createReader()         → reader
 *                       getFile(path, o, success) / getDirectory(…) → entry
 *   reader            → readEntries(success)   success(entries) → each entry
 * All objects of a type share one prototype: each is wrapped once.
 */
function hookEntry(win: HookWindow, entry: unknown, forward: ForwardFile): void {
  try {
    if (typeof entry !== 'object' || entry === null) return;
    const proto: unknown = Object.getPrototypeOf(entry);
    if (typeof proto !== 'object' || proto === null) return;
    const kind = entry as { isFile?: unknown; isDirectory?: unknown };
    const onEntry = (value: unknown) => hookEntry(win, value, forward);
    if (kind.isFile === true) {
      wrapOnce(proto, 'file', withCallback(0, (file) => forwardIfFile(win, file, forward)));
    } else if (kind.isDirectory === true) {
      wrapOnce(proto, 'createReader', (original) =>
        function (this: unknown, ...args: unknown[]) {
          const reader = original.apply(this, args);
          hookReader(win, reader, forward);
          return reader;
        },
      );
      wrapOnce(proto, 'getFile', withCallback(2, onEntry));
      wrapOnce(proto, 'getDirectory', withCallback(2, onEntry));
    }
  } catch {
    // Our problem, never the page's.
  }
}

function hookReader(win: HookWindow, reader: unknown, forward: ForwardFile): void {
  try {
    if (typeof reader !== 'object' || reader === null) return;
    const proto: unknown = Object.getPrototypeOf(reader);
    if (typeof proto !== 'object' || proto === null) return;
    wrapOnce(
      proto,
      'readEntries',
      withCallback(0, (entries) => {
        if (Array.isArray(entries)) for (const entry of entries) hookEntry(win, entry, forward);
      }),
    );
  } catch {
    // Our problem, never the page's.
  }
}

/** Calls forward for a File, never throws. */
function forwardIfFile(win: HookWindow, value: unknown, forward: ForwardFile): void {
  try {
    if (value instanceof win.File) forward(value);
  } catch {
    // Our problem, never the page's.
  }
}

/**
 * Installs all hooks:
 *   HTMLInputElement.prototype.files – file inputs anywhere: in the DOM,
 *     detached, in open or closed shadow roots, folder pickers;
 *   DataTransfer.prototype.files – drag & drop and paste (clipboardData);
 *   DataTransferItem.prototype.getAsFile – drag & drop / paste via .items;
 *   DataTransferItem.prototype.webkitGetAsEntry – folder drops: the entry
 *     objects' own prototypes are wrapped lazily (hookEntry, D36);
 *   FileSystemFileHandle.prototype.getFile – File System Access API
 *     (showOpenFilePicker, handles from drag & drop).
 * Returns the names of the APIs that were wrapped.
 */
export function installHooks(win: HookWindow, forward: ForwardFile): string[] {
  const installed: string[] = [];
  const inspect = (value: unknown) => forwardList(win, value, forward);
  if (wrapGetter(win.HTMLInputElement.prototype, 'files', inspect)) installed.push('HTMLInputElement.files');
  if (wrapGetter(win.DataTransfer.prototype, 'files', inspect)) installed.push('DataTransfer.files');

  // Return value: forward it, return it.
  const getAsFile = wrapMethod(win.DataTransferItem.prototype, 'getAsFile', (original) =>
    function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      forwardIfFile(win, result, forward);
      return result;
    },
  );
  if (getAsFile) installed.push('DataTransferItem.getAsFile');

  // Folder drops: every entry the page gets is hooked before it is returned.
  const getAsEntry = wrapMethod(win.DataTransferItem.prototype, 'webkitGetAsEntry', (original) =>
    function (this: unknown, ...args: unknown[]) {
      const entry = original.apply(this, args);
      hookEntry(win, entry, forward);
      return entry;
    },
  );
  if (getAsEntry) installed.push('DataTransferItem.webkitGetAsEntry');

  // Promise: return the very same promise; our own .then is a side branch that
  // does not change what the page awaits (and swallows nothing of the page's).
  if (win.FileSystemFileHandle) {
    const getFile = wrapMethod(win.FileSystemFileHandle.prototype, 'getFile', (original) =>
      function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this, args);
        // A "thenable" check, not instanceof: a promise from another window has
        // a different Promise constructor.
        if (typeof (result as { then?: unknown } | null)?.then === 'function') {
          (result as PromiseLike<unknown>).then(
            (file) => forwardIfFile(win, file, forward),
            () => {},
          );
        }
        return result;
      },
    );
    if (getFile) installed.push('FileSystemFileHandle.getFile');
  }
  return installed;
}
