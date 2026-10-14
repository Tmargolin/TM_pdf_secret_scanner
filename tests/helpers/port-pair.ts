// Two connected fake ports, like the ends of chrome.runtime.connect():
// - messages are JSON-copied (runtime messaging serialises payloads),
// - delivery is asynchronous and keeps order: messages posted before
//   disconnect() arrive before the other end's onDisconnect,
// - disconnect() fires onDisconnect on the OTHER end only,
// - posting on a closed end throws, like Chrome.

import type { ScanPort } from '../../src/shared/scan-port.ts';
import { SCAN_PORT_NAME } from '../../src/shared/messages.ts';
import { createFakeEvent } from './chrome-fake.ts';

export interface FakePort extends ScanPort {
  /** Everything this end posted, in order. */
  readonly posted: unknown[];
  /** True once this end can no longer send or receive. */
  readonly closed: boolean;
}

export function createPortPair(
  sender?: chrome.runtime.MessageSender,
  name: string = SCAN_PORT_NAME,
): { client: FakePort; server: FakePort } {
  const makeEnd = (endSender?: chrome.runtime.MessageSender) => {
    const onMessage = createFakeEvent<(message: unknown) => void>();
    const onDisconnect = createFakeEvent<() => void>();
    const state = { closed: false };
    const end = {
      name,
      sender: endSender,
      posted: [] as unknown[],
      get closed() {
        return state.closed;
      },
      onMessage,
      onDisconnect,
      other: undefined as unknown as { state: { closed: boolean }; onMessage: typeof onMessage; onDisconnect: typeof onDisconnect },
      state,
      postMessage(message: unknown) {
        if (state.closed) throw new Error('Attempting to use a disconnected port object');
        end.posted.push(message);
        const copy: unknown = JSON.parse(JSON.stringify(message));
        const other = end.other;
        queueMicrotask(() => {
          if (!other.state.closed) other.onMessage.dispatch(copy);
        });
      },
      disconnect() {
        if (state.closed) return;
        state.closed = true;
        const other = end.other;
        queueMicrotask(() => {
          if (other.state.closed) return;
          other.state.closed = true;
          other.onDisconnect.dispatch();
        });
      },
    };
    return end;
  };
  const client = makeEnd();
  const server = makeEnd(sender);
  client.other = server;
  server.other = client;
  return { client, server };
}
