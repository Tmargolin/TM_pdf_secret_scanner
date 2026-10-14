import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createManifest, DEV_HOST_PERMISSION, type Manifest } from '../../scripts/manifest.ts';

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const template = readJson<Manifest>('manifest.json');
const pkg = readJson<{ version: string }>('package.json');
const messages = readJson<Record<string, { message: string }>>('_locales/en/messages.json');

const API_HOST = 'https://eu.prompt.security/*';
const release = createManifest(template, { mode: 'release', version: pkg.version });
const dev = createManifest(template, { mode: 'dev', version: pkg.version });

describe('manifest template', () => {
  it('is Manifest V3 with the required minimum Chrome version', () => {
    expect(template['manifest_version']).toBe(3);
    expect(template['minimum_chrome_version']).toBe('120');
  });

  it('does not run in incognito windows', () => {
    expect(template['incognito']).toBe('not_allowed');
  });

  it('uses localised name and description that exist in the catalogue', () => {
    expect(template['default_locale']).toBe('en');
    expect(template['name']).toBe('__MSG_extName__');
    expect(template['description']).toBe('__MSG_extDescription__');
    expect(messages['extName']?.message).toBeTruthy();
    expect(messages['extDescription']?.message).toBeTruthy();
  });

  it('declares a module service worker', () => {
    expect(template['background']).toEqual({
      service_worker: 'background/service-worker.js',
      type: 'module',
    });
  });

  it('requests exactly the designed permissions', () => {
    expect([...(template['permissions'] as string[])].sort()).toEqual(
      ['notifications', 'offscreen', 'scripting', 'storage'],
    );
    expect(template.host_permissions).toEqual([API_HOST]);
    expect(template['optional_host_permissions']).toEqual(['*://*/*']);
  });

  it('has no static content scripts, external messaging or custom CSP', () => {
    expect(template).not.toHaveProperty('content_scripts');
    expect(template).not.toHaveProperty('externally_connectable');
    expect(template).not.toHaveProperty('content_security_policy');
  });
});

describe('createManifest', () => {
  it('sets the version from package.json in a Chrome-compatible format', () => {
    expect(release.version).toBe(pkg.version);
    expect(release.version).toMatch(/^\d+(\.\d+){0,3}$/);
  });

  it('release build contains no localhost access', () => {
    expect(release.host_permissions).toEqual([API_HOST]);
    expect(JSON.stringify(release)).not.toContain('localhost');
  });

  it('dev build adds localhost access and nothing else', () => {
    expect(dev.host_permissions).toEqual([API_HOST, DEV_HOST_PERMISSION]);
    const { host_permissions: _devHosts, ...devRest } = dev;
    const { host_permissions: _releaseHosts, ...releaseRest } = release;
    expect(devRest).toEqual(releaseRest);
  });

  it('does not modify the template', () => {
    expect(template.host_permissions).toEqual([API_HOST]);
    expect(template.version).toBe('0.0.0');
  });
});
