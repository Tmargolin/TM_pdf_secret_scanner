// Browser-mode tests (real Chromium) for the hand-off channel: MAIN-world end
// (channel.ts) and isolated end (bridge.ts). A real extension runs them in two
// worlds of one page; here both run in one fresh iframe per test – the window
// messages, ports and structured cloning are the same.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openBridge } from '../../src/content/bridge.ts';
import { createMainWorldChannel, MAX_BUFFERED_FILES } from '../../src/main-world/channel.ts';
import { HANDOFF_MARKER } from '../../src/shared/messages.ts';

type FrameWindow = Window & typeof globalThis;

let frame: HTMLIFrameElement;
let win: FrameWindow;
let received: File[];

/**
 * In the extension, the content script and the hooks belong to the same page
 * window, so the port message's event.source is that window – which the
 * channel requires. Here the bridge code belongs to the test runner's page, so
 * Chrome would report the runner as the source. This routes the bridge's
 * postMessage through a function created inside the iframe, so the iframe is
 * the source again, as in the real extension.
 */
function postAsFrameItself(target: FrameWindow): void {
  const original = target.postMessage.bind(target);
  const relay = new target.Function('post', 'return (message, transfer) => post(message, "*", transfer);')(original) as (
    message: unknown,
    transfer: Transferable[],
  ) => void;
  Object.defineProperty(target, 'postMessage', {
    value: (message: unknown, _origin: string, transfer: Transferable[] = []) => relay(message, transfer),
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  frame = document.createElement('iframe');
  document.body.append(frame);
  win = frame.contentWindow as FrameWindow;
  received = [];
});

afterEach(() => frame.remove());

const file = (name: string) => new win.File([`%PDF-1.7 ${name}`], `${name}.pdf`);
// Window messages and port messages are delivered in later tasks. Never wait a
// fixed time for something to arrive (flaky on a busy machine): wait until it
// has arrived. Only "nothing arrives" checks use a fixed quiet period.
const names = () => received.map((f) => f.name);
/** Waits (up to 2 s) until the content script has received exactly these files. */
const receivedNames = (expected: string[]) => vi.waitFor(() => expect(names()).toEqual(expected), { timeout: 2_000 });
const quietPeriod = () => new Promise((resolve) => setTimeout(resolve, 150));
const bridge = () => {
  postAsFrameItself(win);
  return openBridge(win, (f) => void received.push(f));
};

describe('handshake – either script may start first', () => {
  it('content script first: files reach the content script', async () => {
    bridge();
    const channel = createMainWorldChannel(win);
    channel.forward(file('a'));
    await receivedNames(['a.pdf']);
  });

  it('hooks first: files reach the content script', async () => {
    const channel = createMainWorldChannel(win);
    bridge();
    channel.forward(file('a'));
    await receivedNames(['a.pdf']);
  });

  it('a received file is a File of the content script\'s world, with the same content', async () => {
    const channel = createMainWorldChannel(win);
    bridge();
    channel.forward(file('content'));
    await receivedNames(['content.pdf']);
    expect(received[0]).toBeInstanceOf(File);
    expect(await received[0]?.text()).toBe('%PDF-1.7 content');
  });
});

describe('buffering before the port arrives', () => {
  it('files seen early are delivered in order once the port arrives, then later ones', async () => {
    const channel = createMainWorldChannel(win);
    bridge(); // port message still on its way
    channel.forward(file('early-1'));
    channel.forward(file('early-2'));
    await receivedNames(['early-1.pdf', 'early-2.pdf']);
    channel.forward(file('late'));
    await receivedNames(['early-1.pdf', 'early-2.pdf', 'late.pdf']);
  });

  it(`keeps at most ${MAX_BUFFERED_FILES} files while waiting`, async () => {
    const channel = createMainWorldChannel(win);
    for (let i = 0; i < MAX_BUFFERED_FILES + 20; i++) channel.forward(file(`f${i}`));
    bridge();
    await receivedNames(Array.from({ length: MAX_BUFFERED_FILES }, (_, i) => `f${i}.pdf`));
    await quietPeriod();
    expect(received).toHaveLength(MAX_BUFFERED_FILES); // the 20 extra never come
  });
});

describe('the page cannot easily interfere', () => {
  it('page listeners registered later never see our port message', async () => {
    const channel = createMainWorldChannel(win);
    let pageSawPort = false;
    win.addEventListener('message', (event) => {
      if (event.ports.length > 0) pageSawPort = true;
    });
    bridge();
    channel.forward(file('probe'));
    await receivedNames(['probe.pdf']); // the port message has certainly been dispatched
    expect(pageSawPort).toBe(false);
  });

  it('a second marked port is ignored – the first one wins', async () => {
    const channel = createMainWorldChannel(win);
    bridge();
    channel.forward(file('first'));
    await receivedNames(['first.pdf']); // our port is in place
    const intruder = new MessageChannel();
    const intruderGot: unknown[] = [];
    intruder.port1.onmessage = (event) => void intruderGot.push(event.data);
    win.postMessage({ marker: HANDOFF_MARKER }, '*', [intruder.port2]); // relayed: from the page itself
    await quietPeriod();
    channel.forward(file('ours'));
    await receivedNames(['first.pdf', 'ours.pdf']);
    expect(intruderGot).toEqual([]);
  });

  it('a marked port posted from another window is ignored', async () => {
    const channel = createMainWorldChannel(win);
    const other = new MessageChannel();
    win.postMessage({ marker: HANDOFF_MARKER }, '*', [other.port2]); // not relayed yet: source is the test runner's window
    await quietPeriod();
    bridge();
    channel.forward(file('ours'));
    await receivedNames(['ours.pdf']);
  });

  it('a message without our marker is not taken', async () => {
    const channel = createMainWorldChannel(win);
    const decoy = new MessageChannel();
    postAsFrameItself(win);
    win.postMessage({ marker: 'something-else' }, '*', [decoy.port2]);
    bridge();
    channel.forward(file('ours'));
    await receivedNames(['ours.pdf']);
  });
});

describe('bridge – only real Files pass', () => {
  /** Grabs the port the bridge posts, as the MAIN world would, to send arbitrary data. */
  async function portToBridge(): Promise<MessagePort> {
    const port = new Promise<MessagePort>((resolve) => {
      win.addEventListener('message', (event) => {
        const p = event.ports[0];
        if (p) resolve(p);
      });
    });
    bridge();
    return port;
  }

  it('ignores anything that is not a File', async () => {
    const port = await portToBridge();
    port.postMessage('text');
    port.postMessage({ name: 'fake.pdf', size: 3 });
    port.postMessage(new win.Blob(['blob']));
    port.postMessage(file('real'));
    await receivedNames(['real.pdf']); // sent last, so the others were already handled
  });

  it('close() stops receiving', async () => {
    const port = new Promise<MessagePort>((resolve) => {
      win.addEventListener('message', (event) => {
        const p = event.ports[0];
        if (p) resolve(p);
      });
    });
    const opened = bridge();
    const mainEnd = await port;
    opened.close();
    mainEnd.postMessage(file('after-close'));
    await quietPeriod();
    expect(received).toEqual([]);
  });
});
