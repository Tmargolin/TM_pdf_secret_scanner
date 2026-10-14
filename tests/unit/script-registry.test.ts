import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowListChanged,
  chromeScriptingApi,
  CONTENT_SCRIPT_FILE,
  CONTENT_SCRIPT_ID,
  HOOKS_SCRIPT_FILE,
  HOOKS_SCRIPT_ID,
  createScriptRegistry,
  scriptsFor,
  type ScriptingApi,
} from '../../src/background/script-registry.ts';
import { createLogger, type LogLevel } from '../../src/shared/safe-logger.ts';
import { DEV_SEED_SITE, getDefaultSettings, STORAGE_KEY } from '../../src/shared/settings.ts';
import { createChromeFake, type ChromeFake } from '../helpers/chrome-fake.ts';

const MAIL = '*://mail.google.com/*';
const SLACK = '*://*.slack.com/*';
const DRIVE = '*://drive.google.com/*';

let fake: ChromeFake;

beforeEach(() => {
  fake = createChromeFake();
  fake.install();
});

afterEach(() => fake.uninstall());

/** Stores the allow list the way the options page will (step 3). */
function allow(sites: string[], dev = true): void {
  fake.storageData[STORAGE_KEY] = { ...getDefaultSettings(dev), allowedSites: sites };
}

function setup(options: { dev?: boolean; api?: ScriptingApi } = {}) {
  const dev = options.dev ?? true;
  const lines: { level: LogLevel; line: string; fields?: Record<string, unknown> }[] = [];
  const registry = createScriptRegistry({
    api: options.api ?? chromeScriptingApi(),
    storage: fake.chrome.storage.local,
    dev,
    log: createLogger('sw', {
      dev,
      sink: (level, line, fields) => void lines.push(fields === undefined ? { level, line } : { level, line, fields }),
    }),
  });
  return { registry, lines };
}

/** Matches of the isolated content script (the hooks script always has the same – see scriptsFor). */
const registeredMatches = () => fake.registeredScripts.filter((s) => s.id === CONTENT_SCRIPT_ID).map((s) => s.matches);

describe('scriptsFor', () => {
  it('describes the MAIN-world hooks and the isolated content script with the options from DESIGN §3.1', () => {
    const common = {
      matches: [MAIL],
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true,
    };
    expect(scriptsFor([MAIL])).toEqual([
      { id: HOOKS_SCRIPT_ID, js: [HOOKS_SCRIPT_FILE], world: 'MAIN', ...common },
      { id: CONTENT_SCRIPT_ID, js: [CONTENT_SCRIPT_FILE], world: 'ISOLATED', ...common },
    ]);
  });

  it('points at the files the build produces', () => {
    expect(HOOKS_SCRIPT_FILE).toBe('main-world/hooks.js');
    expect(CONTENT_SCRIPT_FILE).toBe('content/content.js');
  });
});

describe('which sites are registered', () => {
  it('registers only sites that are both allow-listed and granted', async () => {
    allow([MAIL, SLACK, DRIVE]);
    fake.grantedOrigins.push(MAIL, DRIVE);
    await setup().registry.reconcile();
    expect(registeredMatches()).toEqual([[MAIL, DRIVE]]);
  });

  it('ignores granted sites that are not on the allow list', async () => {
    allow([MAIL]);
    fake.grantedOrigins.push(MAIL, SLACK, '*://*/*');
    await setup().registry.reconcile();
    expect(registeredMatches()).toEqual([[MAIL]]);
  });

  it('registers nothing when no allow-listed site is granted', async () => {
    allow([MAIL, SLACK]);
    await setup().registry.reconcile();
    expect(fake.registeredScripts).toEqual([]);
    expect(fake.scriptingCalls).toEqual([]);
  });

  it('dev build: registers the localhost seed once it is granted (dev manifest grants it)', async () => {
    fake.grantedOrigins.push(DEV_SEED_SITE);
    await setup({ dev: true }).registry.reconcile();
    expect(registeredMatches()).toEqual([[DEV_SEED_SITE]]);
  });

  it('release build: empty allow list by default, nothing registered', async () => {
    fake.grantedOrigins.push(DEV_SEED_SITE);
    await setup({ dev: false }).registry.reconcile();
    expect(fake.registeredScripts).toEqual([]);
  });

  it('release build: drops a stored localhost entry (not a valid site there)', async () => {
    allow([DEV_SEED_SITE, MAIL], true);
    fake.grantedOrigins.push(DEV_SEED_SITE, MAIL);
    await setup({ dev: false }).registry.reconcile();
    expect(registeredMatches()).toEqual([[MAIL]]);
  });

  it('treats a pattern Chrome cannot parse as not granted and keeps the others', async () => {
    allow([MAIL, SLACK]);
    const api: ScriptingApi = {
      ...chromeScriptingApi(),
      isGranted: async (pattern) => {
        if (pattern === SLACK) throw new Error(`Invalid url pattern '${pattern}'`);
        return true;
      },
    };
    await setup({ api }).registry.reconcile();
    expect(registeredMatches()).toEqual([[MAIL]]);
  });
});

describe('keeping the registration in step', () => {
  it('is idempotent: a second run leaves the same single registration', async () => {
    allow([MAIL]);
    fake.grantedOrigins.push(MAIL);
    const { registry } = setup();
    await registry.reconcile();
    const first = structuredClone(fake.registeredScripts);
    await registry.reconcile();
    expect(fake.registeredScripts).toEqual(first);
    expect(fake.scriptingCalls.map((c) => c.method)).toEqual(['register', 'update']);
  });

  it('overlapping runs register once (no duplicate-id error)', async () => {
    allow([MAIL]);
    fake.grantedOrigins.push(MAIL);
    const { registry, lines } = setup();
    await Promise.all([registry.reconcile(), registry.reconcile(), registry.reconcile()]);
    expect(fake.registeredScripts.map((s) => s.id)).toEqual([HOOKS_SCRIPT_ID, CONTENT_SCRIPT_ID]);
    expect(fake.scriptingCalls.filter((c) => c.method === 'register')).toHaveLength(1);
    expect(lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('updates the matches when the allow list changes', async () => {
    allow([MAIL]);
    fake.grantedOrigins.push(MAIL, SLACK);
    const { registry } = setup();
    await registry.reconcile();
    allow([MAIL, SLACK]);
    await registry.reconcile();
    expect(registeredMatches()).toEqual([[MAIL, SLACK]]);
  });

  it('unregisters when the last permission is revoked, then stays quiet', async () => {
    allow([MAIL]);
    fake.grantedOrigins.push(MAIL);
    const { registry } = setup();
    await registry.reconcile();
    fake.grantedOrigins.length = 0; // revoked in chrome://extensions
    await registry.reconcile();
    expect(fake.registeredScripts).toEqual([]);
    await registry.reconcile();
    expect(fake.scriptingCalls.map((c) => c.method)).toEqual(['register', 'unregister']);
  });

  it('registers again after a site is re-granted', async () => {
    allow([MAIL]);
    const { registry } = setup();
    await registry.reconcile();
    fake.grantedOrigins.push(MAIL);
    await registry.reconcile();
    expect(registeredMatches()).toEqual([[MAIL]]);
  });
});

describe('failures and logging', () => {
  it('logs a failure, never rejects, and the next run still works', async () => {
    allow([MAIL]);
    fake.grantedOrigins.push(MAIL);
    let failOnce = true;
    const real = chromeScriptingApi();
    const api: ScriptingApi = {
      ...real,
      register: async (scripts) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('Could not load javascript content/content.js');
        }
        return real.register(scripts);
      },
    };
    const { registry, lines } = setup({ api });
    await expect(registry.reconcile()).resolves.toBeUndefined();
    expect(lines.filter((l) => l.level === 'error').map((l) => l.line)).toEqual([
      '[PSS:sw] content scripts could not be reconciled',
    ]);
    await registry.reconcile();
    expect(registeredMatches()).toEqual([[MAIL]]);
  });

  it('logs counts only, not the site names', async () => {
    allow([MAIL, SLACK]);
    fake.grantedOrigins.push(MAIL);
    const { registry, lines } = setup();
    await registry.reconcile();
    expect(lines).toEqual([
      { level: 'info', line: '[PSS:sw] content scripts reconciled', fields: { allowed: 2, active: 1 } },
    ]);
  });
});

describe('allowListChanged (storage.onChanged filter)', () => {
  const settings = (allowedSites: string[], appId = '') => ({ ...getDefaultSettings(false), allowedSites, appId });
  it.each([
    ['a site was added', { settings: { oldValue: settings([]), newValue: settings([MAIL]) } }, 'local', true],
    ['a site was removed', { settings: { oldValue: settings([MAIL, SLACK]), newValue: settings([SLACK]) } }, 'local', true],
    ['first save ever', { settings: { newValue: settings([MAIL]) } }, 'local', true],
    ['settings were deleted', { settings: { oldValue: settings([MAIL]) } }, 'local', true],
    ['only the APP-ID changed', { settings: { oldValue: settings([MAIL]), newValue: settings([MAIL], 'id') } }, 'local', false],
    ['another key changed', { other: { oldValue: 1, newValue: 2 } }, 'local', false],
    ['another storage area', { settings: { oldValue: settings([]), newValue: settings([MAIL]) } }, 'sync', false],
  ])('%s → %s', (_name, changes, area, expected) => {
    expect(allowListChanged(changes, area)).toBe(expected);
  });
});
