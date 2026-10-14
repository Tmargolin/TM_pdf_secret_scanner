import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSite,
  chromePermissionsApi,
  normalizeSiteInput,
  overlaps,
  removeSite,
  type PermissionsApi,
} from '../../src/options/sites.ts';
import { createLogger, type LogLevel } from '../../src/shared/safe-logger.ts';
import { DEV_SEED_SITE, getDefaultSettings, STORAGE_KEY, type Settings, type SettingsStorage } from '../../src/shared/settings.ts';
import { createChromeFake, type ChromeFake } from '../helpers/chrome-fake.ts';

const MAIL = '*://mail.google.com/*';
const SLACK = '*://*.slack.com/*';
const TEAM = '*://team.slack.com/*';

/** Storage + permissions fakes that record every call in one ordered list. */
function setup(options: { sites?: string[]; grant?: boolean | 'throw'; removeResult?: boolean | 'throw'; dev?: boolean } = {}) {
  const dev = options.dev ?? false;
  const calls: string[] = [];
  const data: Record<string, unknown> = { [STORAGE_KEY]: { ...getDefaultSettings(dev), allowedSites: options.sites ?? [] } };
  const storage: SettingsStorage = {
    get: async (key) => {
      calls.push('storage.get');
      return { [key]: structuredClone(data[key]) };
    },
    set: async (items) => {
      calls.push('storage.set');
      Object.assign(data, structuredClone(items));
    },
  };
  const permissions: PermissionsApi = {
    request: async (pattern) => {
      calls.push(`request ${pattern}`);
      if (options.grant === 'throw') throw new Error('This function must be called during a user gesture');
      return options.grant ?? true;
    },
    remove: async (pattern) => {
      calls.push(`remove ${pattern}`);
      if (options.removeResult === 'throw') throw new Error('You cannot remove required permissions.');
      return options.removeResult ?? true;
    },
  };
  const lines: { level: LogLevel; line: string }[] = [];
  const log = createLogger('options', { dev, sink: (level, line) => void lines.push({ level, line }) });
  return {
    deps: { storage, permissions, dev, log },
    calls,
    lines,
    stored: () => (data[STORAGE_KEY] as Settings).allowedSites,
    setStored: (sites: string[]) => {
      (data[STORAGE_KEY] as Settings).allowedSites = sites;
    },
  };
}

describe('normalizeSiteInput', () => {
  it.each([
    ['mail.google.com', MAIL],
    ['  MAIL.Google.COM  ', MAIL],
    ['*.slack.com', SLACK],
    ['https://mail.google.com/mail/u/0?x=1#y', MAIL],
    ['http://mail.google.com:8443/', MAIL],
    ['*://drive.google.com/*', '*://drive.google.com/*'],
    ['münchen.de', '*://xn--mnchen-3ya.de/*'],
    ['10.0.0.5', '*://10.0.0.5/*'],
  ])('%s → %s', (input, pattern) => {
    expect(normalizeSiteInput(input, false)).toEqual({ ok: true, pattern });
  });

  it.each(['', '   ', 'google', 'localhost', '*.com', '*', '*://*/*', 'not a site', 'http://', 'mail.google.com.'])(
    'refuses %j with a hint',
    (input) => {
      const result = normalizeSiteInput(input, false);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('mail.google.com or *.slack.com');
    },
  );

  it('accepts the localhost seed only in the dev build', () => {
    expect(normalizeSiteInput(DEV_SEED_SITE, true)).toEqual({ ok: true, pattern: DEV_SEED_SITE });
    expect(normalizeSiteInput(DEV_SEED_SITE, false).ok).toBe(false);
  });
});

describe('overlaps', () => {
  it.each([
    [MAIL, MAIL, true],
    [SLACK, TEAM, true],
    [TEAM, SLACK, true],
    ['*://a.b.c.com/*', '*://c.com/*', true],
    [MAIL, '*://drive.google.com/*', false],
    ['*://ab.com/*', '*://b.com/*', false], // a suffix, but not a subdomain
  ])('%s / %s → %s', (a, b, expected) => {
    expect(overlaps(a, b)).toBe(expected);
  });
});

describe('addSite', () => {
  it('asks Chrome for permission synchronously, before any storage access (user gesture)', async () => {
    const t = setup();
    const pending = addSite('mail.google.com', [], t.deps);
    expect(t.calls).toEqual([`request ${MAIL}`]); // already called, before the first await returned
    await pending;
    expect(t.calls).toEqual([`request ${MAIL}`, 'storage.get', 'storage.set']);
  });

  it('saves the site once access is granted', async () => {
    const t = setup({ sites: [SLACK] });
    expect(await addSite('mail.google.com', [SLACK], t.deps)).toEqual({ ok: true, pattern: MAIL, sites: [SLACK, MAIL] });
    expect(t.stored()).toEqual([SLACK, MAIL]);
  });

  it.each([
    ['denied', false],
    ['refused by Chrome', 'throw'],
  ] as const)('saves nothing when access is %s', async (_name, grant) => {
    const t = setup({ grant });
    const result = await addSite('mail.google.com', [], t.deps);
    expect(result).toEqual({ ok: false, error: `Access to ${MAIL} was not granted – the site was not added.` });
    expect(t.calls).toEqual([`request ${MAIL}`]);
    expect(t.stored()).toEqual([]);
  });

  it('does not ask for invalid input', async () => {
    const t = setup();
    expect((await addSite('google', [], t.deps)).ok).toBe(false);
    expect(t.calls).toEqual([]);
  });

  it('does not ask again for a site already shown', async () => {
    const t = setup({ sites: [MAIL] });
    expect(await addSite('https://mail.google.com/x', [MAIL], t.deps)).toEqual({
      ok: false,
      error: `${MAIL} is already on the list.`,
    });
    expect(t.calls).toEqual([]);
  });

  it('keeps sites saved elsewhere since the page loaded, and never stores a duplicate', async () => {
    const t = setup();
    t.setStored([SLACK, MAIL]); // another options tab added both
    const result = await addSite('mail.google.com', [], t.deps); // this page still shows an empty list
    expect(result).toEqual({ ok: true, pattern: MAIL, sites: [SLACK, MAIL] });
    expect(t.stored()).toEqual([SLACK, MAIL]);
  });
});

describe('removeSite', () => {
  it('saves the shorter list first, then gives the access back', async () => {
    const t = setup({ sites: [MAIL, SLACK] });
    expect(await removeSite(MAIL, t.deps)).toEqual({ ok: true, pattern: MAIL, sites: [SLACK] });
    expect(t.calls).toEqual(['storage.get', 'storage.set', `remove ${MAIL}`]);
    expect(t.stored()).toEqual([SLACK]);
  });

  it('keeps the access while an overlapping site is still listed', async () => {
    const t = setup({ sites: [SLACK, TEAM] });
    await removeSite(SLACK, t.deps);
    expect(t.stored()).toEqual([TEAM]);
    expect(t.calls).not.toContain(`remove ${SLACK}`);
  });

  it.each([
    ['returns false', false],
    ['throws (manifest permission, e.g. dev localhost)', 'throw'],
  ] as const)('still removes the site when giving access back %s, and logs a warning', async (_name, removeResult) => {
    const t = setup({ sites: [MAIL], removeResult });
    expect((await removeSite(MAIL, t.deps)).ok).toBe(true);
    expect(t.stored()).toEqual([]);
    expect(t.lines).toEqual([
      { level: 'warn', line: '[PSS:options] site access could not be given back to Chrome (kept by Chrome or from the manifest)' },
    ]);
  });

  it('removing a site that is not listed changes nothing else', async () => {
    const t = setup({ sites: [SLACK] });
    expect(await removeSite(MAIL, t.deps)).toEqual({ ok: true, pattern: MAIL, sites: [SLACK] });
  });
});

describe('chromePermissionsApi (the real chrome.permissions calls)', () => {
  let fake: ChromeFake;
  beforeEach(() => {
    fake = createChromeFake();
    fake.install();
  });
  afterEach(() => fake.uninstall());

  it('requests and removes exactly one origin pattern', async () => {
    const api = chromePermissionsApi();
    expect(await api.request(MAIL)).toBe(true);
    expect(fake.grantedOrigins).toEqual([MAIL]);
    expect(await api.remove(MAIL)).toBe(true);
    expect(fake.grantedOrigins).toEqual([]);
    expect(fake.permissionCalls).toEqual([
      { method: 'request', origins: [MAIL] },
      { method: 'remove', origins: [MAIL] },
    ]);
  });

  it('reports a denied prompt as false', async () => {
    fake.permissionAnswer = false;
    expect(await chromePermissionsApi().request(MAIL)).toBe(false);
    expect(fake.grantedOrigins).toEqual([]);
  });

  it('works end to end with addSite and removeSite', async () => {
    const deps = {
      storage: fake.chrome.storage.local,
      permissions: chromePermissionsApi(),
      dev: false,
      log: createLogger('options', { sink: () => {} }),
    };
    expect((await addSite('mail.google.com', [], deps)).ok).toBe(true);
    expect(fake.grantedOrigins).toEqual([MAIL]);
    await removeSite(MAIL, deps);
    expect(fake.grantedOrigins).toEqual([]);
    expect((fake.storageData[STORAGE_KEY] as Settings).allowedSites).toEqual([]);
  });
});
