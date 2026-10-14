// Isolated-world end of the hand-off channel (DESIGN.md §3, protocol.md).
// Creates a MessageChannel, keeps port1 and hands port2 to the MAIN-world
// hooks with HANDOFF_MARKER. Data arriving from the page's world is untrusted:
// only real File objects (of this world, after structured cloning) pass.

import { HANDOFF_MARKER } from '../shared/messages.ts';

export interface Bridge {
  /** Stops receiving files. */
  close(): void;
}

export function openBridge(win: Window, onFile: (file: File) => void): Bridge {
  const channel = new MessageChannel();
  channel.port1.onmessage = (event: MessageEvent) => {
    if (event.data instanceof File) onFile(event.data);
  };
  // '*' because the same window may have an opaque origin (about:blank, srcdoc frames).
  win.postMessage({ marker: HANDOFF_MARKER }, '*', [channel.port2]);
  return {
    close: () => channel.port1.close(),
  };
}
