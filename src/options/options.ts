// Options page wiring (DESIGN.md §6, docs/agents/options.md). The logic lives
// in form.ts; this file only moves values between it and the page.
// Never logs or displays the APP-ID outside its own field.

import { getDefaultSettings, isConfigured, loadSettings, type Settings } from '../shared/settings.ts';
import { defaultFormValues, errorsByField, NUMERIC_FIELDS, saveForm, toFormValues, type FormValues } from './form.ts';

const storage = chrome.storage.local;
const dev = __DEV__;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`options page: #${id} is missing`);
  return element as T;
};

const form = byId<HTMLFormElement>('form');
const status = byId<HTMLSpanElement>('status');
const FIELD_KEYS = ['appId', 'apiUrl', ...NUMERIC_FIELDS.map((f) => f.key)] as const;
type FieldKey = (typeof FIELD_KEYS)[number];

/** Builds one labelled number input per advanced setting (text via textContent only). */
function renderNumericFields(): void {
  const container = byId('numeric-fields');
  const defaults = getDefaultSettings(dev);
  for (const field of NUMERIC_FIELDS) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';

    const label = document.createElement('label');
    label.htmlFor = field.key;
    label.textContent = field.label;

    const input = document.createElement('input');
    input.id = field.key;
    input.name = field.key;
    input.type = 'number';
    input.step = '1';

    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = field.unit;

    const help = document.createElement('p');
    help.className = 'help';
    help.textContent = `${field.help} Default: ${defaults[field.key].toLocaleString('en')}.`.trim();

    const error = document.createElement('p');
    error.className = 'error';
    error.id = `error-${field.key}`;
    error.hidden = true;

    wrapper.append(label, input, unit, help, error);
    container.append(wrapper);
  }
}

const input = (key: FieldKey) => byId<HTMLInputElement>(key);

function readForm(): FormValues {
  const values = {} as FormValues;
  for (const key of FIELD_KEYS) values[key] = input(key).value;
  return values;
}

function fillForm(values: FormValues): void {
  for (const key of FIELD_KEYS) input(key).value = values[key];
}

function showErrors(errors: Map<keyof Settings, string[]>): void {
  for (const key of FIELD_KEYS) {
    const messages = errors.get(key) ?? [];
    const error = byId<HTMLParagraphElement>(`error-${key}`);
    error.textContent = messages.join(' ');
    error.hidden = messages.length === 0;
    input(key).setAttribute('aria-invalid', String(messages.length > 0));
  }
  // Open "Advanced" if the problem is in there.
  if (NUMERIC_FIELDS.some((f) => errors.has(f.key))) byId<HTMLDetailsElement>('advanced').open = true;
}

function setStatus(text: string, kind: 'ok' | 'error' | ''): void {
  status.textContent = text;
  status.className = kind;
}

function showConfigured(settings: Settings): void {
  byId('not-configured').hidden = isConfigured(settings);
}

async function load(): Promise<void> {
  const settings = await loadSettings(storage, dev);
  fillForm(toFormValues(settings));
  showConfigured(settings);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  setStatus('', '');
  void saveForm(storage, readForm(), dev).then(
    (result) => {
      if (result.ok) {
        showErrors(new Map());
        showConfigured(result.settings);
        setStatus('Saved.', 'ok');
      } else {
        showErrors(errorsByField(result.errors));
        setStatus('Not saved – please correct the marked fields.', 'error');
      }
    },
    () => setStatus('Not saved – the settings could not be stored.', 'error'),
  );
});

byId('restore').addEventListener('click', () => {
  fillForm(defaultFormValues(readForm(), dev));
  showErrors(new Map());
  setStatus('Defaults restored – press Save to keep them.', '');
});

byId<HTMLInputElement>('showAppId').addEventListener('change', (event) => {
  input('appId').type = (event.target as HTMLInputElement).checked ? 'text' : 'password';
});

renderNumericFields();
void load().catch(() => setStatus('The settings could not be loaded.', 'error'));
