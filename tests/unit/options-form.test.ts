import { describe, expect, it } from 'vitest';
import {
  defaultFormValues,
  errorsByField,
  fromFormValues,
  humanize,
  NUMERIC_FIELDS,
  saveForm,
  toFormValues,
  type FormValues,
} from '../../src/options/form.ts';
import {
  getDefaultSettings,
  NUMERIC_LIMITS,
  STORAGE_KEY,
  type Settings,
  type SettingsStorage,
} from '../../src/shared/settings.ts';

const DEFAULTS = getDefaultSettings(false);
const SITES = ['*://mail.google.com/*', '*://*.slack.com/*'];

/** In-memory storage that can also change "behind the page's back". */
function memoryStorage(stored?: Settings) {
  const data: Record<string, unknown> = stored ? { [STORAGE_KEY]: structuredClone(stored) } : {};
  let writes = 0;
  const storage: SettingsStorage = {
    get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (items) => {
      writes++;
      Object.assign(data, structuredClone(items));
    },
  };
  return { storage, stored: () => data[STORAGE_KEY] as Settings | undefined, writes: () => writes };
}

const form = (changes: Partial<FormValues> = {}): FormValues => ({ ...toFormValues(DEFAULTS), ...changes });

describe('field list', () => {
  it('has every numeric setting exactly once, in DESIGN §6 order', () => {
    expect(NUMERIC_FIELDS.map((f) => f.key)).toEqual(Object.keys(NUMERIC_LIMITS));
  });

  it('gives every field a label', () => {
    for (const field of NUMERIC_FIELDS) expect(field.label.length).toBeGreaterThan(0);
  });
});

describe('Settings ↔ form text', () => {
  it('shows every value as text', () => {
    const values = toFormValues({ ...DEFAULTS, appId: 'abc', chunkSize: 8_000 });
    expect(values.appId).toBe('abc');
    expect(values.apiUrl).toBe(DEFAULTS.apiUrl);
    expect(values.chunkSize).toBe('8000');
    expect(Object.keys(values)).toHaveLength(2 + NUMERIC_FIELDS.length);
  });

  it('round-trips unchanged', () => {
    const settings = { ...DEFAULTS, appId: 'abc', allowedSites: SITES, retries: 0 };
    expect(fromFormValues(toFormValues(settings), settings)).toEqual(settings);
  });

  it('trims the APP-ID, the API URL and numbers', () => {
    const settings = fromFormValues(form({ appId: '  id-1 ', apiUrl: ` ${DEFAULTS.apiUrl}\n`, chunkSize: ' 9000 ' }), DEFAULTS);
    expect(settings).toMatchObject({ appId: 'id-1', apiUrl: DEFAULTS.apiUrl, chunkSize: 9_000 });
  });

  it.each(['', 'abc', '12abc'])('turns %j into NaN so validation reports it', (text) => {
    expect(fromFormValues(form({ chunkSize: text }), DEFAULTS).chunkSize).toBeNaN();
  });

  it('keeps fields the form does not show (the site list) from the base', () => {
    expect(fromFormValues(form(), { ...DEFAULTS, allowedSites: SITES }).allowedSites).toEqual(SITES);
  });
});

describe('restore defaults', () => {
  it('restores every field except the APP-ID', () => {
    const restored = defaultFormValues(form({ appId: 'keep-me', chunkSize: '999', apiUrl: 'x' }), false);
    expect(restored).toEqual({ ...toFormValues(DEFAULTS), appId: 'keep-me' });
  });
});

describe('error texts', () => {
  it('uses labels instead of setting keys', () => {
    expect(humanize('chunkOverlap must be less than half of chunkSize')).toBe(
      'Chunk overlap must be less than half of Chunk size',
    );
  });

  it('does not touch keys inside longer words', () => {
    expect(humanize('retriesX stays')).toBe('RetriesX stays');
  });

  it('groups messages per field', () => {
    const map = errorsByField([
      { field: 'chunkSize', message: 'chunkSize must be a whole number' },
      { field: 'apiUrl', message: 'API URL is not a valid URL' },
      { field: 'chunkSize', message: 'second' },
    ]);
    expect([...map]).toEqual([
      ['chunkSize', ['Chunk size must be a whole number', 'Second']],
      ['apiUrl', ['API URL is not a valid URL']],
    ]);
  });
});

describe('saving', () => {
  it('stores valid values', async () => {
    const t = memoryStorage(DEFAULTS);
    const result = await saveForm(t.storage, form({ appId: 'new-id', chunkSize: '8000' }), false);
    expect(result.ok).toBe(true);
    expect(t.stored()).toMatchObject({ appId: 'new-id', chunkSize: 8_000 });
  });

  it('works when nothing was stored yet', async () => {
    const t = memoryStorage();
    expect((await saveForm(t.storage, form({ appId: 'first' }), false)).ok).toBe(true);
    expect(t.stored()?.appId).toBe('first');
  });

  it('keeps a site list that changed after the page was loaded', async () => {
    const t = memoryStorage(DEFAULTS);
    const values = form({ appId: 'id' }); // page loaded with no sites
    await t.storage.set({ [STORAGE_KEY]: { ...DEFAULTS, allowedSites: SITES } }); // 3.2: a site is added meanwhile
    await saveForm(t.storage, values, false);
    expect(t.stored()?.allowedSites).toEqual(SITES);
  });

  it('writes nothing and reports per field when values are invalid', async () => {
    const t = memoryStorage(DEFAULTS);
    const writesBefore = t.writes();
    const result = await saveForm(t.storage, form({ apiUrl: 'http://evil.com', chunkSize: 'abc', retries: '9' }), false);
    expect(result.ok).toBe(false);
    expect(t.writes()).toBe(writesBefore);
    expect(t.stored()).toEqual(DEFAULTS);
    if (result.ok) return;
    expect([...errorsByField(result.errors).keys()].sort()).toEqual(['apiUrl', 'chunkSize', 'retries']);
  });

  it('reports rules that span fields', async () => {
    const t = memoryStorage(DEFAULTS);
    const result = await saveForm(t.storage, form({ chunkSize: '1000', chunkOverlap: '500' }), false);
    expect(result.ok ? [] : [...errorsByField(result.errors)]).toEqual([
      ['chunkOverlap', ['Chunk overlap must be less than half of Chunk size']],
    ]);
  });

  it('dev build accepts a localhost API URL (mock API); release does not', async () => {
    const values = form({ apiUrl: 'http://localhost:8787/api/protect' });
    expect((await saveForm(memoryStorage(getDefaultSettings(true)).storage, values, true)).ok).toBe(true);
    expect((await saveForm(memoryStorage(DEFAULTS).storage, values, false)).ok).toBe(false);
  });

  it('rejects an APP-ID with spaces inside', async () => {
    const result = await saveForm(memoryStorage(DEFAULTS).storage, form({ appId: 'abc def' }), false);
    expect(result.ok ? [] : [...errorsByField(result.errors)]).toEqual([['appId', ['APP-ID must not contain spaces']]]);
  });
});
