// The message catalogue (_locales/en/messages.json) against the code
// (src/shared/i18n.ts, every getMessage call, the manifest) – DESIGN.md §7.
// chrome.i18n returns "" for a missing key, so a typo would silently give an
// empty notification; these tests make it a failing build instead.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { errorMessageKey, MESSAGES, type MessageKey } from '../../src/shared/i18n.ts';
import { ERROR_CODES } from '../../src/shared/types.ts';

interface CatalogueEntry {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}

const root = new URL('../../', import.meta.url);
const catalogue = JSON.parse(readFileSync(new URL('_locales/en/messages.json', root), 'utf8')) as Record<string, CatalogueEntry>;
const codeKeys = Object.keys(MESSAGES) as MessageKey[];

/** All .ts files under src/, with their text. */
const sources = (readdirSync(new URL('src/', root), { recursive: true }) as string[])
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file, text: readFileSync(new URL(`src/${file.replaceAll('\\', '/')}`, root), 'utf8') }));

/** Renders a message the way chrome.i18n does: $NAME$ → its placeholder content → substitution $n. */
function render(key: string, substitutions: string[]): string {
  const entry = catalogue[key] as CatalogueEntry;
  return entry.message.replace(/\$(\w+)\$/g, (_match, name: string) => {
    const content = entry.placeholders?.[name.toLowerCase()]?.content ?? '';
    return content.replace(/\$(\d)/g, (_m, n: string) => substitutions[Number(n) - 1] ?? '');
  });
}

describe('catalogue ⇄ code', () => {
  it('every key the code lists exists in messages.json', () => {
    expect(codeKeys.filter((key) => !(key in catalogue))).toEqual([]);
  });

  it('every key in messages.json is listed in the code (no forgotten texts)', () => {
    expect(Object.keys(catalogue).filter((key) => !(key in MESSAGES))).toEqual([]);
  });

  it('every error code has a reason text', () => {
    for (const code of ERROR_CODES) expect(catalogue[errorMessageKey(code)]?.message, code).toBeTruthy();
  });

  it('every getMessage("…") call and every __MSG_…__ in the manifest uses a known key', () => {
    const used = new Set<string>();
    for (const { text } of sources) for (const match of text.matchAll(/getMessage\(\s*'(\w+)'/g)) used.add(match[1] as string);
    const manifest = readFileSync(new URL('manifest.json', root), 'utf8');
    for (const match of manifest.matchAll(/__MSG_(\w+)__/g)) used.add(match[1] as string);
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((key) => !(key in MESSAGES))).toEqual([]);
  });
});

describe('placeholders', () => {
  it.each(codeKeys)('%s: as many placeholders as the code passes substitutions, numbered $1…$n', (key: MessageKey) => {
    const entry = catalogue[key] as CatalogueEntry;
    const contents = Object.values(entry.placeholders ?? {}).map((p) => p.content);
    expect(contents.length).toBe(MESSAGES[key]);
    expect([...contents].sort()).toEqual(Array.from({ length: MESSAGES[key] }, (_, i) => `$${i + 1}`));
  });

  it.each(codeKeys)('%s: every $NAME$ in the text is declared, and every declared one is used', (key: MessageKey) => {
    const entry = catalogue[key] as CatalogueEntry;
    const used = new Set([...entry.message.matchAll(/\$(\w+)\$/g)].map((m) => (m[1] as string).toLowerCase()));
    expect(used).toEqual(new Set(Object.keys(entry.placeholders ?? {})));
  });

  it.each(codeKeys)('%s: renders with its examples – no "$" left, not empty', (key: MessageKey) => {
    const entry = catalogue[key] as CatalogueEntry;
    const examples = Object.values(entry.placeholders ?? {})
      .sort((a, b) => a.content.localeCompare(b.content))
      .map((p) => p.example ?? 'x');
    const text = render(key, examples);
    expect(text.trim()).not.toBe('');
    expect(text).not.toContain('$');
  });
});

describe('Chrome rules for message files', () => {
  it('keys use only letters, digits and "_" and differ in more than case (Chrome ignores case)', () => {
    const keys = Object.keys(catalogue);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
    expect(new Set(keys.map((k) => k.toLowerCase())).size).toBe(keys.length);
  });

  it('every entry has a description for translators', () => {
    const missing = Object.entries(catalogue).filter(([key, e]) => !e.description && !key.startsWith('ext'));
    expect(missing.map(([key]) => key)).toEqual([]);
  });
});

describe('examples render as DESIGN.md §7 shows them', () => {
  it('a secrets notification', () => {
    expect(render('titleSecretsOne', ['report.pdf'])).toBe('Secrets found in report.pdf');
    expect(render('titleSecretsMany', ['2', '3'])).toBe('2 of 3 files contain secrets');
    expect(render('findingWithPages', ['AWS credentials', '3', 'AKIA…LE'])).toBe('AWS credentials (p. 3) AKIA…LE');
    expect(render('findingsMore', ['2'])).toBe('+2 more');
  });

  it('a partial scan', () => {
    expect(render('error_TEXT_TRUNCATED', ['2,000,000', '3,500,000'])).toBe('Only the first 2,000,000 of 3,500,000 characters were checked.');
    expect(render('fileReason', ['a.pdf', 'The PDF could not be read – it was not checked.'])).toBe(
      'a.pdf: The PDF could not be read – it was not checked.',
    );
  });
});
