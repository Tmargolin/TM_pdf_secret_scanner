// Options page wiring (DESIGN.md §6, docs/agents/options.md). The logic lives
// in form.ts; this file only moves values between it and the page.
// Never logs or displays the APP-ID outside its own field.

import { notificationsBlocked } from '../shared/notification-permission.ts';
import { createLogger } from '../shared/safe-logger.ts';
import { getDefaultSettings, isConfigured, loadSettings, type Settings } from '../shared/settings.ts';
import { defaultFormValues, errorsByField, NUMERIC_FIELDS, saveForm, toFormValues, type FormValues } from './form.ts';
import { addSite, chromePermissionsApi, removeSite, type SiteResult } from './sites.ts';

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

// ---------- site allow list ----------

const sitesDeps = { storage, permissions: chromePermissionsApi(), dev, log: createLogger('options', { dev }) };
let shownSites: string[] = [];

function setSiteStatus(text: string, kind: 'ok' | 'error' | ''): void {
  const element = byId('site-status');
  element.textContent = text;
  element.className = kind;
}

function renderSites(sites: string[]): void {
  shownSites = sites;
  const list = byId<HTMLUListElement>('sites');
  list.replaceChildren();
  if (sites.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No sites yet – nothing is checked.';
    list.append(empty);
    return;
  }
  for (const site of sites) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = site;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${site}`);
    remove.addEventListener('click', () => {
      void removeSite(site, sitesDeps).then(
        (result) => showSiteResult(result, `Removed ${site}.`),
        () => setSiteStatus('The site list could not be saved.', 'error'),
      );
    });
    item.append(name, remove);
    list.append(item);
  }
}

function showSiteResult(result: SiteResult, okText: string): void {
  if (result.ok) {
    renderSites(result.sites);
    setSiteStatus(okText, 'ok');
  } else {
    setSiteStatus(result.error, 'error');
  }
}

byId<HTMLFormElement>('add-site-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const field = byId<HTMLInputElement>('site-input');
  // addSite asks Chrome for permission before its first await: still inside this click.
  void addSite(field.value, shownSites, sitesDeps).then(
    (result) => {
      showSiteResult(result, result.ok ? `Added ${result.pattern}. Reload tabs already open on it.` : '');
      if (result.ok) field.value = '';
    },
    () => setSiteStatus('The site list could not be saved.', 'error'),
  );
});

// The list can also change elsewhere (another options tab): keep it current.
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === 'local') void loadSettings(storage, dev).then((settings) => renderSites(settings.allowedSites));
});

// ---------- notifications blocked in Chrome ----------

function showNotificationLevel(level: string): void {
  byId('notifications-blocked').hidden = !notificationsBlocked(level);
}

chrome.notifications.onPermissionLevelChanged.addListener(showNotificationLevel);
void chrome.notifications.getPermissionLevel().then(showNotificationLevel, () => {});

// ---------- load ----------

async function load(): Promise<void> {
  const settings = await loadSettings(storage, dev);
  fillForm(toFormValues(settings));
  showConfigured(settings);
  renderSites(settings.allowedSites);
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
