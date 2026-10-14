// In-memory stand-in for the chrome.* APIs the extension uses (DESIGN.md §15).
// Grows with each step: only what current code calls is implemented.

type Listener = (...args: never[]) => unknown;

/** A chrome.events.Event look-alike whose listeners tests can trigger. */
export interface FakeEvent<L extends Listener> {
  addListener(listener: L): void;
  removeListener(listener: L): void;
  hasListener(listener: L): boolean;
  readonly listeners: readonly L[];
  /** Calls every listener like Chrome would; returns their return values. */
  dispatch(...args: Parameters<L>): unknown[];
}

export function createFakeEvent<L extends Listener>(): FakeEvent<L> {
  const listeners: L[] = [];
  return {
    addListener: (l) => void listeners.push(l),
    removeListener: (l) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (l) => listeners.includes(l),
    get listeners() {
      return listeners;
    },
    dispatch: (...args) => listeners.map((l) => (l as (...a: Parameters<L>) => unknown)(...args)),
  };
}

export const FAKE_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined | void;

interface ContextFilter {
  contextTypes?: string[];
  documentUrls?: string[];
}

export interface ChromeFake {
  /** The object installed as globalThis.chrome. */
  readonly chrome: typeof chrome;
  /** Full URLs of the offscreen documents that currently exist. */
  readonly offscreenDocuments: string[];
  readonly getContextsCalls: ContextFilter[];
  readonly createDocumentCalls: chrome.offscreen.CreateParameters[];
  /** When set, the next createDocument call fails with this error. */
  failNextCreate: Error | null;
  readonly onInstalled: FakeEvent<() => void>;
  readonly onStartup: FakeEvent<() => void>;
  readonly onMessage: FakeEvent<MessageListener>;
  /** Puts the fake on globalThis.chrome. */
  install(): void;
  /** Removes globalThis.chrome. */
  uninstall(): void;
}

export function createChromeFake(): ChromeFake {
  const offscreenDocuments: string[] = [];
  const getContextsCalls: ContextFilter[] = [];
  const createDocumentCalls: chrome.offscreen.CreateParameters[] = [];
  const onInstalled = createFakeEvent<() => void>();
  const onStartup = createFakeEvent<() => void>();
  const onMessage = createFakeEvent<MessageListener>();

  const getURL = (path: string) => `chrome-extension://${FAKE_EXTENSION_ID}/${path.replace(/^\//, '')}`;

  const fake: ChromeFake = {
    chrome: undefined as unknown as typeof chrome,
    offscreenDocuments,
    getContextsCalls,
    createDocumentCalls,
    failNextCreate: null,
    onInstalled,
    onStartup,
    onMessage,
    install: () => void Reflect.set(globalThis, 'chrome', fake.chrome),
    uninstall: () => void Reflect.deleteProperty(globalThis, 'chrome'),
  };

  const runtime = {
    id: FAKE_EXTENSION_ID,
    getURL,
    ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
    async getContexts(filter: ContextFilter) {
      getContextsCalls.push(filter);
      const wantsOffscreen = !filter.contextTypes || filter.contextTypes.includes('OFFSCREEN_DOCUMENT');
      return offscreenDocuments
        .filter((url) => wantsOffscreen && (!filter.documentUrls || filter.documentUrls.includes(url)))
        .map((documentUrl) => ({ contextType: 'OFFSCREEN_DOCUMENT', documentUrl }));
    },
    onInstalled,
    onStartup,
    onMessage,
  };

  const offscreen = {
    Reason: { WORKERS: 'WORKERS' },
    async createDocument(params: chrome.offscreen.CreateParameters) {
      createDocumentCalls.push(params);
      await Promise.resolve(); // creation is asynchronous in Chrome too
      if (fake.failNextCreate) {
        const error = fake.failNextCreate;
        fake.failNextCreate = null;
        throw error;
      }
      if (offscreenDocuments.length > 0) throw new Error('Only a single offscreen document may be created.');
      offscreenDocuments.push(getURL(params.url));
    },
  };

  (fake as { chrome: unknown }).chrome = { runtime, offscreen };
  return fake;
}

/** Lets all pending promise callbacks and timers of 0 ms run. */
export const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
