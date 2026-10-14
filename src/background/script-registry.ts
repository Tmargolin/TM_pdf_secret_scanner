// Registers the extension's content scripts for the allow-listed sites
// (DESIGN.md §3.1, D24). Only the service worker does this.
//
// reconcile() is idempotent: it computes the wanted state from scratch – the
// sites that are in the stored allow list AND granted by the user – and makes
// Chrome's registration match it. Calling it twice gives the same result as
// calling it once, so every trigger can simply call it.

import type { Logger } from '../shared/safe-logger.ts';
import { loadSettings, type SettingsStorage } from '../shared/settings.ts';

type ContentScript = chrome.scripting.RegisteredContentScript;

/** Id and built file of the isolated-world content script (see build.ts). */
export const CONTENT_SCRIPT_ID = 'pss-content';
export const CONTENT_SCRIPT_FILE = 'content/content.js';

/** The scripts we register for the given match patterns. MAIN-world hooks join in step 4. */
export function scriptsFor(matches: string[]): ContentScript[] {
  return [
    {
      id: CONTENT_SCRIPT_ID,
      js: [CONTENT_SCRIPT_FILE],
      matches,
      world: 'ISOLATED',
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true,
    },
  ];
}

/** The Chrome calls the registry needs – injected so tests can replace them. */
export interface ScriptingApi {
  isGranted(pattern: string): Promise<boolean>;
  getRegistered(ids: string[]): Promise<ContentScript[]>;
  register(scripts: ContentScript[]): Promise<void>;
  update(scripts: ContentScript[]): Promise<void>;
  unregister(ids: string[]): Promise<void>;
}

/** The real implementation, using chrome.permissions and chrome.scripting. */
export function chromeScriptingApi(): ScriptingApi {
  return {
    isGranted: (pattern) => chrome.permissions.contains({ origins: [pattern] }),
    getRegistered: (ids) => chrome.scripting.getRegisteredContentScripts({ ids }),
    register: (scripts) => chrome.scripting.registerContentScripts(scripts),
    update: (scripts) => chrome.scripting.updateContentScripts(scripts),
    unregister: (ids) => chrome.scripting.unregisterContentScripts({ ids }),
  };
}

export interface ScriptRegistryDeps {
  api: ScriptingApi;
  storage: SettingsStorage;
  dev: boolean;
  log: Logger;
}

export interface ScriptRegistry {
  /** Makes the registration match allow list ∩ granted sites. Never rejects. */
  reconcile(): Promise<void>;
}

export function createScriptRegistry(deps: ScriptRegistryDeps): ScriptRegistry {
  const { api, log } = deps;

  const grantedSites = async (sites: string[]): Promise<string[]> => {
    const granted: string[] = [];
    for (const site of sites) {
      try {
        if (await api.isGranted(site)) granted.push(site);
      } catch {
        // Chrome rejects patterns it cannot parse: treat as not granted.
      }
    }
    return granted;
  };

  const run = async (): Promise<void> => {
    const { allowedSites } = await loadSettings(deps.storage, deps.dev);
    const matches = await grantedSites(allowedSites);
    const wanted = scriptsFor(matches);
    const registered = new Set((await api.getRegistered(wanted.map((s) => s.id))).map((s) => s.id));

    if (matches.length === 0) {
      // Chrome refuses a script without matches: remove ours instead.
      if (registered.size > 0) await api.unregister([...registered]);
    } else {
      const existing = wanted.filter((s) => registered.has(s.id));
      const missing = wanted.filter((s) => !registered.has(s.id));
      if (existing.length > 0) await api.update(existing);
      if (missing.length > 0) await api.register(missing);
    }
    log.info('content scripts reconciled', { allowed: allowedSites.length, active: matches.length });
  };

  // Runs are chained one after another: two overlapping runs could both see
  // "not registered" and both try to register (Chrome: duplicate id).
  let queue: Promise<void> = Promise.resolve();

  return {
    reconcile() {
      queue = queue.then(run).catch((error: unknown) => {
        log.error('content scripts could not be reconciled', { error });
      });
      return queue;
    },
  };
}
