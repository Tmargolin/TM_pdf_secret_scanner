import { describe, expect, it } from 'vitest';
import { FAKE_APP_ID } from '../helpers/fake-secrets.ts';
import {
  checkApiUrl,
  checkAppId,
  checkNumber,
  checkSitePattern,
  DEFAULT_API_URL,
  DEV_SEED_SITE,
  getDefaultSettings,
  isConfigured,
  loadSettings,
  normalizeSettings,
  NUMERIC_LIMITS,
  saveSettings,
  STORAGE_KEY,
  validateSettings,
  type NumericSettingKey,
  type Settings,
  type SettingsStorage,
} from '../../src/shared/settings.ts';

/** In-memory stand-in for chrome.storage.local. */
function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  let writes = 0;
  const storage: SettingsStorage = {
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => {
      writes += 1;
      Object.assign(data, items);
    },
  };
  return { storage, data, writes: () => writes };
}

const release = getDefaultSettings(false);
const dev = getDefaultSettings(true);

describe('defaults', () => {
  it('match DESIGN.md §6', () => {
    expect(release).toEqual({
      allowedSites: [],
      apiUrl: 'https://eu.prompt.security/api/protect',
      appId: '',
      chunkSize: 32_000,
      chunkOverlap: 200,
      maxRequestBytes: 65_536,
      maxTextChars: 2_000_000,
      maxConcurrency: 4,
      maxParallelExtractions: 2,
      maxInFlightMB: 60,
      maxQueuedMB: 200,
      jobTimeoutMs: 120_000,
      requestTimeoutMs: 15_000,
      retries: 2,
      maxFileSizeMB: 25,
    });
  });

  it('dev builds differ only by the localhost allow-list seed', () => {
    expect(dev.allowedSites).toEqual([DEV_SEED_SITE]);
    expect({ ...dev, allowedSites: [] }).toEqual(release);
  });

  it('are valid in both builds', () => {
    expect(validateSettings(release, false).ok).toBe(true);
    expect(validateSettings(dev, true).ok).toBe(true);
  });

  it('return a fresh object each time', () => {
    const a = getDefaultSettings(false);
    a.allowedSites.push('*://example.com/*');
    expect(getDefaultSettings(false).allowedSites).toEqual([]);
  });

  it('are within the numeric limits', () => {
    for (const key of Object.keys(NUMERIC_LIMITS) as NumericSettingKey[]) {
      expect(checkNumber(key, release[key]), key).toBeNull();
    }
  });
});

describe('isConfigured', () => {
  it('is false without an APP-ID and true with one', () => {
    expect(isConfigured(release)).toBe(false);
    expect(isConfigured({ ...release, appId: 'abc-123' })).toBe(true);
  });
});

describe('checkSitePattern', () => {
  it.each(['*://mail.google.com/*', '*://*.slack.com/*', '*://a-b.example.co.il/*'])('accepts %s', (p) => {
    expect(checkSitePattern(p, false)).toBeNull();
  });

  it.each([
    'mail.google.com',
    'https://mail.google.com/*',
    '*://mail.google.com/inbox/*',
    '*://*/*',
    '*://localhost/*',
    '*://MAIL.google.com/*',
    '',
  ])('rejects %s', (p) => {
    expect(checkSitePattern(p, false)).toMatch(/not a valid site pattern/);
  });

  it('accepts the localhost seed only in dev builds', () => {
    expect(checkSitePattern(DEV_SEED_SITE, true)).toBeNull();
    expect(checkSitePattern(DEV_SEED_SITE, false)).not.toBeNull();
  });
});

describe('checkApiUrl', () => {
  it('accepts the real endpoint in both builds', () => {
    expect(checkApiUrl(DEFAULT_API_URL, false)).toBeNull();
    expect(checkApiUrl(DEFAULT_API_URL, true)).toBeNull();
  });

  it.each([
    'http://eu.prompt.security/api/protect',
    'https://evil.example.com/api/protect',
    'https://eu.prompt.security.evil.com/api/protect',
    'https://eu.prompt.security:8443/api/protect',
  ])('rejects %s', (url) => {
    expect(checkApiUrl(url, false)).toMatch(/must be https:\/\/eu\.prompt\.security/);
  });

  it('rejects text that is not a URL', () => {
    expect(checkApiUrl('not a url', false)).toBe('API URL is not a valid URL');
  });

  it.each(['http://localhost:8787/api/protect', 'http://127.0.0.1:8787/api/protect'])(
    'accepts %s only in dev builds',
    (url) => {
      expect(checkApiUrl(url, true)).toBeNull();
      expect(checkApiUrl(url, false)).not.toBeNull();
    },
  );

  it('rejects https localhost and other http hosts even in dev builds', () => {
    expect(checkApiUrl('http://example.com/api/protect', true)).toMatch(/or http:\/\/localhost/);
    expect(checkApiUrl('https://localhost:8787/api/protect', true)).not.toBeNull();
  });
});

describe('checkAppId', () => {
  it('accepts empty (not configured) and normal values', () => {
    expect(checkAppId('')).toBeNull();
    expect(checkAppId(FAKE_APP_ID)).toBeNull();
  });

  it('rejects spaces and overly long values', () => {
    expect(checkAppId('abc def')).toMatch(/spaces/);
    expect(checkAppId(' abc')).toMatch(/spaces/);
    expect(checkAppId('x'.repeat(201))).toMatch(/too long/);
  });
});

describe('checkNumber', () => {
  it('accepts the exact limits', () => {
    expect(checkNumber('chunkSize', 500)).toBeNull();
    expect(checkNumber('chunkSize', 50_000)).toBeNull();
  });

  it.each([499, 50_001, -1])('rejects chunkSize %d', (n) => {
    expect(checkNumber('chunkSize', n)).toBe('chunkSize must be between 500 and 50000');
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, '1000', null, undefined])('rejects non-integer %s', (v) => {
    expect(checkNumber('chunkSize', v)).toBe('chunkSize must be a whole number');
  });

  it('limits maxFileSizeMB to 45 (base64 in one 64 MB message)', () => {
    expect(checkNumber('maxFileSizeMB', 45)).toBeNull();
    expect(checkNumber('maxFileSizeMB', 46)).not.toBeNull();
  });
});

describe('validateSettings', () => {
  it('reports every invalid field', () => {
    const bad: Settings = { ...release, apiUrl: 'https://evil.example.com', appId: 'a b', chunkSize: 1, retries: 9 };
    const result = validateSettings(bad, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.field).sort()).toEqual(['apiUrl', 'appId', 'chunkSize', 'retries']);
    }
  });

  it('rejects invalid and duplicate allow-list entries', () => {
    const result = validateSettings({ ...release, allowedSites: ['*://a.com/*', '*://a.com/*', 'bad'] }, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.message)).toEqual([
        '"bad" is not a valid site pattern',
        'allowedSites contains duplicates',
      ]);
    }
  });

  it('rejects wrong types coming from untyped data', () => {
    const corrupt = { ...release, allowedSites: 'x', apiUrl: 5, appId: null, maxConcurrency: '4' } as unknown as Settings;
    const result = validateSettings(corrupt, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.field).sort()).toEqual(['allowedSites', 'apiUrl', 'appId', 'maxConcurrency']);
    }
  });

  it('rejects non-text allow-list entries', () => {
    const corrupt = { ...release, allowedSites: [42] } as unknown as Settings;
    expect(validateSettings(corrupt, false).ok).toBe(false);
  });

  it('requires overlap below half of the chunk size', () => {
    expect(validateSettings({ ...release, chunkSize: 1_000, chunkOverlap: 499 }, false).ok).toBe(true);
    const result = validateSettings({ ...release, chunkSize: 1_000, chunkOverlap: 500 }, false);
    expect(result).toEqual({
      ok: false,
      errors: [{ field: 'chunkOverlap', message: 'chunkOverlap must be less than half of chunkSize' }],
    });
  });

  it('requires maxQueuedMB to be at least maxInFlightMB', () => {
    expect(validateSettings({ ...release, maxInFlightMB: 100, maxQueuedMB: 100 }, false).ok).toBe(true);
    const result = validateSettings({ ...release, maxInFlightMB: 100, maxQueuedMB: 99 }, false);
    expect(result).toEqual({
      ok: false,
      errors: [{ field: 'maxQueuedMB', message: 'maxQueuedMB must be at least maxInFlightMB' }],
    });
  });

  it('accepts the localhost API URL only in dev builds', () => {
    const local = { ...release, apiUrl: 'http://localhost:8787/api/protect' };
    expect(validateSettings(local, true).ok).toBe(true);
    expect(validateSettings(local, false).ok).toBe(false);
  });
});

describe('normalizeSettings', () => {
  it.each([undefined, null, 'text', 42])('returns defaults for %s', (raw) => {
    expect(normalizeSettings(raw, false)).toEqual(release);
  });

  it('keeps valid fields and fills in missing ones', () => {
    const result = normalizeSettings({ appId: 'abc', chunkSize: 16_000 }, false);
    expect(result).toEqual({ ...release, appId: 'abc', chunkSize: 16_000 });
  });

  it('replaces invalid fields with defaults and drops unknown keys', () => {
    const result = normalizeSettings(
      { apiUrl: 'https://evil.example.com', appId: 'a b', retries: 99, chunkSize: '8000', legacyOption: true },
      false,
    );
    expect(result).toEqual(release);
    expect(result).not.toHaveProperty('legacyOption');
  });

  it('keeps only valid, unique allow-list entries', () => {
    const result = normalizeSettings({ allowedSites: ['*://a.com/*', 'bad', 7, '*://a.com/*', '*://*.b.org/*'] }, false);
    expect(result.allowedSites).toEqual(['*://a.com/*', '*://*.b.org/*']);
  });

  it('drops the localhost seed when loading in a release build', () => {
    expect(normalizeSettings({ allowedSites: [DEV_SEED_SITE] }, false).allowedSites).toEqual([]);
    expect(normalizeSettings({ allowedSites: [DEV_SEED_SITE] }, true).allowedSites).toEqual([DEV_SEED_SITE]);
  });

  it('falls back to the default allow list when the stored value is not a list', () => {
    expect(normalizeSettings({ allowedSites: '*://a.com/*' }, true).allowedSites).toEqual([DEV_SEED_SITE]);
  });

  it('repairs an overlap that is too large for the chunk size', () => {
    const result = normalizeSettings({ chunkSize: 500, chunkOverlap: 2_000 }, false);
    expect(result.chunkSize).toBe(500);
    expect(result.chunkOverlap).toBe(200);
    expect(validateSettings(result, false).ok).toBe(true);

    const tight = normalizeSettings({ chunkSize: 500, chunkOverlap: 300 }, false);
    expect(tight.chunkOverlap * 2).toBeLessThan(tight.chunkSize);
  });

  it('repairs a queue cap below the in-flight cap', () => {
    const result = normalizeSettings({ maxInFlightMB: 300, maxQueuedMB: 100 }, false);
    expect(result.maxQueuedMB).toBe(300);
    expect(validateSettings(result, false).ok).toBe(true);
  });

  it('always returns settings that pass strict validation', () => {
    const samples: unknown[] = [
      {},
      { chunkSize: 500, chunkOverlap: 249 },
      { maxInFlightMB: 500, maxQueuedMB: 10 },
      { allowedSites: [DEV_SEED_SITE, '*://x.io/*'], apiUrl: 'http://localhost:1/x' },
    ];
    for (const raw of samples) {
      expect(validateSettings(normalizeSettings(raw, false), false).ok).toBe(true);
      expect(validateSettings(normalizeSettings(raw, true), true).ok).toBe(true);
    }
  });
});

describe('loadSettings / saveSettings', () => {
  it('loads defaults when nothing is stored', async () => {
    const { storage } = fakeStorage();
    expect(await loadSettings(storage, false)).toEqual(release);
  });

  it('round-trips valid settings', async () => {
    const { storage, data } = fakeStorage();
    const wanted: Settings = { ...release, appId: 'abc', allowedSites: ['*://mail.google.com/*'] };
    expect(await saveSettings(storage, wanted, false)).toEqual({ ok: true, settings: wanted });
    expect(data[STORAGE_KEY]).toEqual(wanted);
    expect(await loadSettings(storage, false)).toEqual(wanted);
  });

  it('writes nothing when validation fails', async () => {
    const { storage, data, writes } = fakeStorage({ [STORAGE_KEY]: { appId: 'old' } });
    const result = await saveSettings(storage, { ...release, chunkSize: 1 }, false);
    expect(result.ok).toBe(false);
    expect(writes()).toBe(0);
    expect(data[STORAGE_KEY]).toEqual({ appId: 'old' });
  });

  it('normalises whatever is stored', async () => {
    const { storage } = fakeStorage({ [STORAGE_KEY]: { appId: 'abc', retries: 'many' } });
    expect(await loadSettings(storage, false)).toEqual({ ...release, appId: 'abc' });
  });
});
