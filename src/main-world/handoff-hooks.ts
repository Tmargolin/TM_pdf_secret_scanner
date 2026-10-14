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

/** The window whose prototypes are wrapped (the page's window, or a test frame's). */
export type HookWindow = Pick<typeof globalThis, 'HTMLInputElement' | 'DataTransfer' | 'FileList' | 'File'>;

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
 * Installs the hooks of step 4.1:
 *   HTMLInputElement.prototype.files – file inputs anywhere: in the DOM,
 *     detached, in open or closed shadow roots, folder pickers;
 *   DataTransfer.prototype.files – drag & drop and paste (clipboardData).
 * Returns the names of the APIs that were wrapped.
 */
export function installHooks(win: HookWindow, forward: ForwardFile): string[] {
  const installed: string[] = [];
  const inspect = (value: unknown) => forwardList(win, value, forward);
  if (wrapGetter(win.HTMLInputElement.prototype, 'files', inspect)) installed.push('HTMLInputElement.files');
  if (wrapGetter(win.DataTransfer.prototype, 'files', inspect)) installed.push('DataTransfer.files');
  return installed;
}
