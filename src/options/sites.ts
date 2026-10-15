// Site allow list editing (DESIGN.md §3.1, docs/agents/options.md). Pure
// logic with injected Chrome calls, so it is unit-testable.
//
// Order matters:
// - add: check the input, then ask Chrome for permission FIRST – Chrome only
//   allows permissions.request() during the click (user gesture); any await
//   before it can make Chrome refuse. Save only after the grant.
// - remove: save the shorter list first (scanning stops even if the next step
//   fails), then give the permission back.
// Script registration is not done here: the service worker reconciles (D24).

import type { Logger } from '../shared/safe-logger.ts';
import { checkSitePattern, loadSettings, saveSettings, type SettingsStorage } from '../shared/settings.ts';

export interface PermissionsApi {
  /** chrome.permissions.request for one origin pattern; true if granted. */
  request(pattern: string): Promise<boolean>;
  /** chrome.permissions.remove for one origin pattern. */
  remove(pattern: string): Promise<boolean>;
}

export function chromePermissionsApi(): PermissionsApi {
  return {
    request: (pattern) => chrome.permissions.request({ origins: [pattern] }),
    remove: (pattern) => chrome.permissions.remove({ origins: [pattern] }),
  };
}

export interface SitesDeps {
  storage: SettingsStorage;
  permissions: PermissionsApi;
  dev: boolean;
  log: Logger;
}

export type SiteResult = { ok: true; pattern: string; sites: string[] } | { ok: false; error: string };

const HINT = 'Enter a host such as mail.google.com or *.slack.com.';

/**
 * What the user typed → a match pattern:
 *   mail.google.com                    → *://mail.google.com/*
 *   *.slack.com                        → *://*.slack.com/*
 *   https://mail.google.com/mail/u/0   → *://mail.google.com/*   (path and port dropped)
 *   *://mail.google.com/*              → unchanged
 * Hosts are lower-cased; international names become punycode, as Chrome uses.
 */
export function normalizeSiteInput(input: string, dev: boolean): { ok: true; pattern: string } | { ok: false; error: string } {
  const text = input.trim().toLowerCase();
  if (text === '') return { ok: false, error: HINT };
  if (checkSitePattern(text, dev) === null) return { ok: true, pattern: text };

  let host = text.replace(/^\*:\/\//, '').replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split(/[/?#]/, 1)[0] ?? '';
  const wildcard = host.startsWith('*.');
  if (wildcard) host = host.slice(2);
  try {
    // Lets the URL parser validate the host, drop a port and convert to punycode.
    host = new URL(`https://${host}`).hostname;
  } catch {
    return { ok: false, error: `"${input.trim()}" is not a site. ${HINT}` };
  }
  const pattern = `*://${wildcard ? '*.' : ''}${host}/*`;
  return checkSitePattern(pattern, dev) === null
    ? { ok: true, pattern }
    : { ok: false, error: `"${input.trim()}" is not a site. ${HINT}` };
}

/** Host part of a pattern without the wildcard: "*://*.slack.com/*" → "slack.com". */
function hostOf(pattern: string): string {
  return pattern.replace(/^[^:]+:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '');
}

/** True if the two patterns' hosts are the same or one is inside the other (a.b.com / b.com). */
export function overlaps(a: string, b: string): boolean {
  const ha = hostOf(a);
  const hb = hostOf(b);
  return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`);
}

/**
 * Adds a site. `shownSites` is the list the page shows, so duplicates are
 * caught without an await before the permission request.
 */
export async function addSite(input: string, shownSites: readonly string[], deps: SitesDeps): Promise<SiteResult> {
  const normalized = normalizeSiteInput(input, deps.dev);
  if (!normalized.ok) return normalized;
  const { pattern } = normalized;
  if (shownSites.includes(pattern)) return { ok: false, error: `${pattern} is already on the list.` };

  let granted: boolean;
  try {
    granted = await deps.permissions.request(pattern); // first await: still inside the click
  } catch {
    granted = false;
  }
  if (!granted) return { ok: false, error: `Access to ${pattern} was not granted – the site was not added.` };

  const current = await loadSettings(deps.storage, deps.dev);
  const sites = current.allowedSites.includes(pattern) ? current.allowedSites : [...current.allowedSites, pattern];
  const saved = await saveSettings(deps.storage, { ...current, allowedSites: sites }, deps.dev);
  if (!saved.ok) {
    await deps.permissions.remove(pattern).catch(() => false);
    return { ok: false, error: 'The site list could not be saved.' };
  }
  return { ok: true, pattern, sites };
}

/**
 * What the options page says after a change. A change of the list reaches a
 * tab only when it (re)loads: injected scripts stay in a running page, so a
 * removed site is still scanned in tabs that stay open (seen on Gmail, step 8).
 */
export function addedMessage(pattern: string): string {
  return `Added ${pattern}. Reload tabs already open on it to start scanning there.`;
}

export function removedMessage(pattern: string): string {
  return `Removed ${pattern}. Tabs still open on it are scanned until you reload them.`;
}

/**
 * Removes a site: saves the list first, then gives the permission back –
 * unless another site still on the list overlaps it (Chrome may have merged
 * the grants), or Chrome refuses (a permission from the manifest, e.g. the
 * dev build's localhost).
 */
export async function removeSite(pattern: string, deps: SitesDeps): Promise<SiteResult> {
  const current = await loadSettings(deps.storage, deps.dev);
  const sites = current.allowedSites.filter((site) => site !== pattern);
  const saved = await saveSettings(deps.storage, { ...current, allowedSites: sites }, deps.dev);
  if (!saved.ok) return { ok: false, error: 'The site list could not be saved.' };

  if (!sites.some((site) => overlaps(site, pattern))) {
    // Not fatal: the site is off the list, so new pages are no longer scanned either way.
    const removed = await deps.permissions.remove(pattern).catch(() => false);
    if (!removed) deps.log.warn('site access could not be given back to Chrome (kept by Chrome or from the manifest)');
  }
  return { ok: true, pattern, sites };
}
