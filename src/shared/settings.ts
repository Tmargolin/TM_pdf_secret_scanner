// Settings model – single source of truth for DESIGN.md §6.
// Pure functions (no chrome.* calls inside) so they can be unit-tested;
// storage access is passed in by the caller.

/** All user-configurable settings. */
export interface Settings {
  /** Site patterns the scanner runs on, e.g. "*://mail.google.com/*" (§3.1). */
  allowedSites: string[];
  /** Prompt Security API endpoint. */
  apiUrl: string;
  /** APP-ID credential. Empty string = not configured. Never log it. */
  appId: string;
  /** Characters per API request (§4.2). */
  chunkSize: number;
  /** Characters repeated between neighbouring chunks, for context. */
  chunkOverlap: number;
  /** Maximum UTF-8 size of one request body, in bytes. */
  maxRequestBytes: number;
  /** Text beyond this many characters is not scanned (partial-scan warning). */
  maxTextChars: number;
  /** API calls in flight across all scans. */
  maxConcurrency: number;
  /** PDFs parsed at the same time. */
  maxParallelExtractions: number;
  /** Total size (MB) of files being processed. */
  maxInFlightMB: number;
  /** Total size (MB) of files received and not finished; above it → QUEUE_FULL. */
  maxQueuedMB: number;
  /** Maximum time per file, end to end. */
  jobTimeoutMs: number;
  /** Maximum time per API request. */
  requestTimeoutMs: number;
  /** Retries per API request (network errors, 429, 5xx). */
  retries: number;
  /** Larger PDFs are not scanned (reported as too large). */
  maxFileSizeMB: number;
}

export type NumericSettingKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];

/** Real API endpoint (must match host_permissions in manifest.json). */
export const DEFAULT_API_URL = 'https://eu.prompt.security/api/protect';

/** Hosts the release build may call (from manifest.json host_permissions). */
export const ALLOWED_API_HOSTS: readonly string[] = ['eu.prompt.security'];

/** Allow-list entry pre-filled in dev builds (local test pages). */
export const DEV_SEED_SITE = 'http://localhost/*';

/** Inclusive ranges for numeric settings. */
export const NUMERIC_LIMITS: Readonly<Record<NumericSettingKey, { min: number; max: number }>> = {
  chunkSize: { min: 500, max: 50_000 },
  chunkOverlap: { min: 0, max: 2_000 },
  maxRequestBytes: { min: 8_192, max: 262_144 },
  maxTextChars: { min: 10_000, max: 10_000_000 },
  maxConcurrency: { min: 1, max: 16 },
  maxParallelExtractions: { min: 1, max: 4 },
  maxInFlightMB: { min: 10, max: 500 },
  maxQueuedMB: { min: 10, max: 1_000 },
  jobTimeoutMs: { min: 10_000, max: 600_000 },
  requestTimeoutMs: { min: 1_000, max: 120_000 },
  retries: { min: 0, max: 5 },
  // Files travel base64-encoded in one message (64 MB limit): 45 MB → ~60 MB.
  maxFileSizeMB: { min: 1, max: 45 },
};

/** Defaults from DESIGN.md §6. Dev builds also pre-fill the localhost site. */
export function getDefaultSettings(dev: boolean): Settings {
  return {
    allowedSites: dev ? [DEV_SEED_SITE] : [],
    apiUrl: DEFAULT_API_URL,
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
  };
}

/** True when an APP-ID has been entered. */
export function isConfigured(settings: Settings): boolean {
  return settings.appId !== '';
}

// ---------- single-field checks (return an error message, or null if valid) ----------

/** "*://host/*" or "*://*.host/*" (what the options page stores, §3.1). Dev: also "http://localhost/*". */
const SITE_PATTERN = /^\*:\/\/(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]+\/\*$/;

export function checkSitePattern(pattern: string, dev: boolean): string | null {
  if (dev && pattern === DEV_SEED_SITE) return null;
  return SITE_PATTERN.test(pattern) ? null : `"${pattern}" is not a valid site pattern`;
}

export function checkApiUrl(value: string, dev: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'API URL is not a valid URL';
  }
  if (url.protocol === 'https:' && ALLOWED_API_HOSTS.includes(url.hostname) && url.port === '') return null;
  if (dev && url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return null;
  return dev
    ? `API URL must be https://${ALLOWED_API_HOSTS.join(' or ')} or http://localhost`
    : `API URL must be https://${ALLOWED_API_HOSTS.join(' or ')}`;
}

export function checkAppId(value: string): string | null {
  if (value === '') return null; // allowed: "not configured yet"
  if (value.length > 200) return 'APP-ID is too long';
  if (/\s/.test(value)) return 'APP-ID must not contain spaces';
  return null;
}

export function checkNumber(key: NumericSettingKey, value: unknown): string | null {
  const { min, max } = NUMERIC_LIMITS[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) return `${key} must be a whole number`;
  if (value < min || value > max) return `${key} must be between ${min} and ${max}`;
  return null;
}

// ---------- whole-object validation (used when saving) ----------

export interface SettingsError {
  field: keyof Settings;
  message: string;
}

export type ValidationResult = { ok: true; settings: Settings } | { ok: false; errors: SettingsError[] };

const NUMERIC_KEYS = Object.keys(NUMERIC_LIMITS) as NumericSettingKey[];

/**
 * Strict check of a complete settings object. Also checks rules that span
 * fields: overlap smaller than half a chunk; queue cap ≥ in-flight cap.
 */
export function validateSettings(candidate: Settings, dev: boolean): ValidationResult {
  const errors: SettingsError[] = [];
  const add = (field: keyof Settings, message: string | null) => {
    if (message !== null) errors.push({ field, message });
  };

  if (!Array.isArray(candidate.allowedSites)) {
    add('allowedSites', 'allowedSites must be a list');
  } else {
    for (const site of candidate.allowedSites) {
      add('allowedSites', typeof site === 'string' ? checkSitePattern(site, dev) : 'site pattern must be text');
    }
    if (new Set(candidate.allowedSites).size !== candidate.allowedSites.length) {
      add('allowedSites', 'allowedSites contains duplicates');
    }
  }
  add('apiUrl', typeof candidate.apiUrl === 'string' ? checkApiUrl(candidate.apiUrl, dev) : 'API URL must be text');
  add('appId', typeof candidate.appId === 'string' ? checkAppId(candidate.appId) : 'APP-ID must be text');
  for (const key of NUMERIC_KEYS) add(key, checkNumber(key, candidate[key]));

  if (errors.length === 0) {
    if (candidate.chunkOverlap * 2 >= candidate.chunkSize) {
      add('chunkOverlap', 'chunkOverlap must be less than half of chunkSize');
    }
    if (candidate.maxQueuedMB < candidate.maxInFlightMB) {
      add('maxQueuedMB', 'maxQueuedMB must be at least maxInFlightMB');
    }
  }
  return errors.length === 0 ? { ok: true, settings: candidate } : { ok: false, errors };
}

// ---------- lenient normalisation (used when loading) ----------

/**
 * Turns whatever is in storage (possibly missing, partial, old or corrupt)
 * into a complete, valid Settings object: each valid field is kept, anything
 * invalid or missing falls back to its default, unknown keys are dropped.
 */
export function normalizeSettings(raw: unknown, dev: boolean): Settings {
  const defaults = getDefaultSettings(dev);
  if (typeof raw !== 'object' || raw === null) return defaults;
  const r = raw as Record<string, unknown>;
  const result: Settings = { ...defaults };

  if (Array.isArray(r['allowedSites'])) {
    const sites = r['allowedSites'].filter(
      (s): s is string => typeof s === 'string' && checkSitePattern(s, dev) === null,
    );
    result.allowedSites = [...new Set(sites)];
  }
  if (typeof r['apiUrl'] === 'string' && checkApiUrl(r['apiUrl'], dev) === null) result.apiUrl = r['apiUrl'];
  if (typeof r['appId'] === 'string' && checkAppId(r['appId']) === null) result.appId = r['appId'];
  for (const key of NUMERIC_KEYS) {
    if (checkNumber(key, r[key]) === null) result[key] = r[key] as number;
  }

  // Cross-field rules: fall back to defaults for the dependent field.
  if (result.chunkOverlap * 2 >= result.chunkSize) result.chunkOverlap = Math.min(defaults.chunkOverlap, Math.floor(result.chunkSize / 2) - 1);
  if (result.maxQueuedMB < result.maxInFlightMB) result.maxQueuedMB = result.maxInFlightMB;
  return result;
}

// ---------- storage ----------

/** The part of chrome.storage.local we use – passed in so tests can fake it. */
export interface SettingsStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Key under which the whole settings object is stored. */
export const STORAGE_KEY = 'settings';

export async function loadSettings(storage: SettingsStorage, dev: boolean): Promise<Settings> {
  const items = await storage.get(STORAGE_KEY);
  return normalizeSettings(items[STORAGE_KEY], dev);
}

/** Validates, then saves. Nothing is written if validation fails. */
export async function saveSettings(storage: SettingsStorage, candidate: Settings, dev: boolean): Promise<ValidationResult> {
  const result = validateSettings(candidate, dev);
  if (result.ok) await storage.set({ [STORAGE_KEY]: result.settings });
  return result;
}
