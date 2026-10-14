// In-memory stand-in for the chrome.* APIs the extension uses (DESIGN.md §15).
// Grows with each step: only what current code calls is implemented.

import catalogue from '../../_locales/en/messages.json' with { type: 'json' };

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

type StorageChangeListener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

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
  readonly onConnect: FakeEvent<(port: chrome.runtime.Port) => void>;
  /** Contents of chrome.storage.local. */
  readonly storageData: Record<string, unknown>;
  readonly onStorageChanged: FakeEvent<StorageChangeListener>;
  /** Every message passed to chrome.runtime.sendMessage. */
  readonly sentMessages: unknown[];
  /**
   * Answers chrome.runtime.sendMessage. Default: rejects like Chrome does when
   * no other extension context is listening.
   */
  sendMessageHandler: ((message: unknown) => Promise<unknown>) | null;
  /** Origins chrome.permissions.contains reports as granted (exact pattern match). */
  readonly grantedOrigins: string[];
  /** The user's answer to the next chrome.permissions.request prompt (default: allow). */
  permissionAnswer: boolean;
  /** Every chrome.permissions.request / remove call, in order. */
  readonly permissionCalls: { method: 'request' | 'remove'; origins: string[] }[];
  /** Content scripts currently registered through chrome.scripting. */
  readonly registeredScripts: chrome.scripting.RegisteredContentScript[];
  /** Every chrome.scripting call that changes the registration, in order. */
  readonly scriptingCalls: { method: 'register' | 'update' | 'unregister'; ids: string[] }[];
  /** Notifications currently shown, by id (create with an existing id replaces). */
  readonly notifications: Map<string, chrome.notifications.NotificationCreateOptions>;
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
  const onConnect = createFakeEvent<(port: chrome.runtime.Port) => void>();
  const onStorageChanged = createFakeEvent<StorageChangeListener>();
  const storageData: Record<string, unknown> = {};
  const sentMessages: unknown[] = [];
  const grantedOrigins: string[] = [];
  const permissionCalls: ChromeFake['permissionCalls'] = [];
  const registeredScripts: chrome.scripting.RegisteredContentScript[] = [];
  const scriptingCalls: ChromeFake['scriptingCalls'] = [];
  const notifications = new Map<string, chrome.notifications.NotificationCreateOptions>();

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
    onConnect,
    storageData,
    onStorageChanged,
    sentMessages,
    sendMessageHandler: null,
    grantedOrigins,
    permissionAnswer: true,
    permissionCalls,
    registeredScripts,
    scriptingCalls,
    notifications,
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
    onConnect,
    async sendMessage(message: unknown) {
      sentMessages.push(message);
      if (fake.sendMessageHandler) return fake.sendMessageHandler(message);
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  };

  const storage = {
    local: {
      async get(key: string) {
        return key in storageData ? { [key]: structuredClone(storageData[key]) } : {};
      },
      async set(items: Record<string, unknown>) {
        const changes: Record<string, chrome.storage.StorageChange> = {};
        for (const [key, newValue] of Object.entries(items)) {
          changes[key] = { oldValue: storageData[key], newValue };
          storageData[key] = structuredClone(newValue);
        }
        onStorageChanged.dispatch(changes, 'local');
      },
    },
    onChanged: onStorageChanged,
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

  const permissions = {
    async contains({ origins = [] }: chrome.permissions.Permissions) {
      return origins.every((origin) => grantedOrigins.includes(origin));
    },
    async request({ origins = [] }: chrome.permissions.Permissions) {
      permissionCalls.push({ method: 'request', origins });
      if (!fake.permissionAnswer) return false;
      for (const origin of origins) if (!grantedOrigins.includes(origin)) grantedOrigins.push(origin);
      return true;
    },
    async remove({ origins = [] }: chrome.permissions.Permissions) {
      permissionCalls.push({ method: 'remove', origins });
      const had = origins.every((origin) => grantedOrigins.includes(origin));
      for (const origin of origins) {
        const i = grantedOrigins.indexOf(origin);
        if (i >= 0) grantedOrigins.splice(i, 1);
      }
      return had;
    },
  };

  // Mirrors Chrome's checks and error messages for the calls we make.
  const findScript = (id: string) => registeredScripts.findIndex((s) => s.id === id);
  const scripting = {
    async getRegisteredContentScripts(filter: chrome.scripting.ContentScriptFilter = {}) {
      return registeredScripts.filter((s) => !filter.ids || filter.ids.includes(s.id)).map((s) => structuredClone(s));
    },
    async registerContentScripts(scripts: chrome.scripting.RegisteredContentScript[]) {
      scriptingCalls.push({ method: 'register', ids: scripts.map((s) => s.id) });
      for (const script of scripts) {
        if (findScript(script.id) >= 0) throw new Error(`Duplicate script ID '${script.id}'`);
        if (!script.matches?.length) throw new Error(`Script with ID '${script.id}' must specify 'matches'`);
      }
      registeredScripts.push(...scripts.map((s) => structuredClone(s)));
    },
    async updateContentScripts(scripts: chrome.scripting.RegisteredContentScript[]) {
      scriptingCalls.push({ method: 'update', ids: scripts.map((s) => s.id) });
      for (const script of scripts) {
        if (findScript(script.id) < 0) {
          throw new Error(`Script with ID '${script.id}' does not exist or is not fully registered`);
        }
        if (script.matches?.length === 0) throw new Error(`Script with ID '${script.id}' must specify 'matches'`);
      }
      for (const script of scripts) {
        // Chrome changes only the fields given; we always pass whole scripts.
        const current = registeredScripts[findScript(script.id)];
        if (current) Object.assign(current, structuredClone(script));
      }
    },
    async unregisterContentScripts(filter: chrome.scripting.ContentScriptFilter = {}) {
      const ids = filter.ids ?? registeredScripts.map((s) => s.id);
      scriptingCalls.push({ method: 'unregister', ids });
      for (const id of ids) if (findScript(id) < 0) throw new Error(`Nonexistent script ID '${id}'`);
      for (const id of ids) registeredScripts.splice(findScript(id), 1);
    },
  };

  // Like Chrome: a relative or foreign iconUrl cannot be loaded, and a basic
  // notification needs an icon, a title and a message.
  const notificationsApi = {
    async create(id: string, options: chrome.notifications.NotificationCreateOptions) {
      if (!options.iconUrl?.startsWith(getURL(''))) throw new Error('Unable to download all specified images.');
      if (!options.title || !options.message) throw new Error('Some of the required properties are missing: type, iconUrl, title and message.');
      notifications.set(id, structuredClone(options));
      return id;
    },
  };

  // chrome.i18n.getMessage over the real catalogue: "" for unknown keys, $1… substitutions.
  type CatalogueEntry = { message: string; placeholders?: Record<string, { content: string }> };
  const i18n = {
    getMessage(key: string, substitutions: string[] = []) {
      const entry = (catalogue as Record<string, CatalogueEntry>)[key];
      if (!entry) return '';
      return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (whole, name: string) => {
        const content = entry.placeholders?.[name.toLowerCase()]?.content ?? whole;
        return content.replace(/\$(\d)/g, (_m, n: string) => substitutions[Number(n) - 1] ?? '');
      });
    },
  };

  (fake as { chrome: unknown }).chrome = {
    runtime,
    offscreen,
    storage,
    permissions,
    scripting,
    notifications: notificationsApi,
    i18n,
  };
  return fake;
}

/** Lets all pending promise callbacks and timers of 0 ms run. */
export const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
