// MAIN-world end of the hand-off channel (DESIGN.md §3, protocol.md).
// The isolated content script posts one MessagePort to the window with
// HANDOFF_MARKER; this side takes the first such port and sends every
// forwarded File over it. Files seen before the port arrives are buffered.
// No chrome.* here; nothing is logged in the page's world.

import { isHandoffPortMessage } from '../shared/messages.ts';

/** Files kept while the port has not arrived yet (references only, no bytes). */
export const MAX_BUFFERED_FILES = 100;

export interface MainWorldChannel {
  /** Sends the File to the content script (or buffers it until the port arrives). */
  forward(file: File): void;
}

export function createMainWorldChannel(win: Window): MainWorldChannel {
  let port: MessagePort | null = null;
  const buffer: File[] = [];

  const send = (file: File) => {
    try {
      port?.postMessage(file); // structured clone: the File's data is not copied
    } catch {
      // Never the page's problem.
    }
  };

  // Capture phase, registered at document_start before any page script: the
  // port message is taken here and not passed on to the page's listeners.
  win.addEventListener(
    'message',
    (event: MessageEvent) => {
      if (port !== null || event.source !== win || !isHandoffPortMessage(event.data, event.ports)) return;
      event.stopImmediatePropagation();
      port = event.ports[0] ?? null;
      for (const file of buffer.splice(0)) send(file);
    },
    true,
  );

  return {
    forward(file) {
      if (port) send(file);
      else if (buffer.length < MAX_BUFFERED_FILES) buffer.push(file);
    },
  };
}
