// Options form model (DESIGN.md §6, docs/agents/options.md). Pure functions –
// no DOM, no chrome.* – so the page logic is unit-testable; options.ts only
// moves values between these and the page.

import {
  getDefaultSettings,
  loadSettings,
  saveSettings,
  type NumericSettingKey,
  type Settings,
  type SettingsError,
  type SettingsStorage,
  type ValidationResult,
} from '../shared/settings.ts';

export interface NumericField {
  key: NumericSettingKey;
  label: string;
  unit: string;
  help: string;
}

/** Advanced settings in the order of DESIGN.md §6. */
export const NUMERIC_FIELDS: readonly NumericField[] = [
  { key: 'chunkSize', label: 'Chunk size', unit: 'characters', help: 'Text sent per API request.' },
  { key: 'chunkOverlap', label: 'Chunk overlap', unit: 'characters', help: 'Text repeated between neighbouring chunks, for context.' },
  { key: 'maxRequestBytes', label: 'Maximum request size', unit: 'bytes', help: 'UTF-8 size of one request body.' },
  { key: 'maxTextChars', label: 'Maximum text per file', unit: 'characters', help: 'Text beyond this is not checked (partial-scan warning).' },
  { key: 'maxConcurrency', label: 'Parallel API requests', unit: '', help: 'API calls in flight across all scans.' },
  { key: 'maxParallelExtractions', label: 'Parallel PDF extractions', unit: '', help: 'PDFs read at the same time.' },
  { key: 'maxInFlightMB', label: 'Files in progress', unit: 'MB', help: 'Total size of files being processed; more files wait.' },
  { key: 'maxQueuedMB', label: 'Files waiting', unit: 'MB', help: 'Total size received and not finished; above it files are not scanned.' },
  { key: 'jobTimeoutMs', label: 'Time limit per file', unit: 'ms', help: 'End to end.' },
  { key: 'requestTimeoutMs', label: 'Time limit per request', unit: 'ms', help: '' },
  { key: 'retries', label: 'Retries per request', unit: '', help: 'After network errors, 429 and 5xx, with back-off.' },
  { key: 'maxFileSizeMB', label: 'Maximum PDF size', unit: 'MB', help: 'Larger PDFs are reported as too large.' },
];

/** What the form shows: everything as text, as in the input fields. */
export type FormValues = { apiUrl: string; appId: string } & Record<NumericSettingKey, string>;

export function toFormValues(settings: Settings): FormValues {
  const values = { apiUrl: settings.apiUrl, appId: settings.appId } as FormValues;
  for (const { key } of NUMERIC_FIELDS) values[key] = String(settings[key]);
  return values;
}

/**
 * Applies the form to `base`. Text that is not a number becomes NaN, which
 * validation reports as "must be a whole number". Fields the form does not
 * show (allowedSites) come from `base` unchanged.
 */
export function fromFormValues(values: FormValues, base: Settings): Settings {
  const settings: Settings = { ...base, apiUrl: values.apiUrl.trim(), appId: values.appId.trim() };
  for (const { key } of NUMERIC_FIELDS) {
    const text = values[key].trim();
    settings[key] = text === '' ? Number.NaN : Number(text);
  }
  return settings;
}

/** "Restore defaults": everything except the APP-ID (and the site list, not on this form). */
export function defaultFormValues(current: FormValues, dev: boolean): FormValues {
  return { ...toFormValues(getDefaultSettings(dev)), appId: current.appId };
}

/** "chunkSize must be …" → "Chunk size must be …": the page shows labels, not setting keys. */
export function humanize(message: string): string {
  let text = message;
  for (const { key, label } of NUMERIC_FIELDS) text = text.replace(new RegExp(`\\b${key}\\b`, 'g'), label);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Validation errors grouped by field, in words, for showing next to each input. */
export function errorsByField(errors: readonly SettingsError[]): Map<keyof Settings, string[]> {
  const map = new Map<keyof Settings, string[]>();
  for (const { field, message } of errors) map.set(field, [...(map.get(field) ?? []), humanize(message)]);
  return map;
}

/**
 * Saves the form. Re-reads the stored settings first so a change made
 * elsewhere meanwhile (e.g. the site list) is kept. Nothing is written if
 * validation fails.
 */
export async function saveForm(storage: SettingsStorage, values: FormValues, dev: boolean): Promise<ValidationResult> {
  const current = await loadSettings(storage, dev);
  return saveSettings(storage, fromFormValues(values, current), dev);
}
