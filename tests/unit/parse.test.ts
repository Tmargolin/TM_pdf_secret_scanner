// Unit tests of the response parser (src/scanner/parse.ts, DESIGN.md §5).
// Recorded responses from the real API (tests/fixtures/api-*.json, made with
// AWS's example key) plus hand-made malformed bodies.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LABEL_MAX_CHARS, parseProtectResponse } from '../../src/scanner/parse.ts';
import { AWS_EXAMPLE_KEY } from '../helpers/fake-secrets.ts';

const recorded = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;

/** A minimal successful body with the given findings. */
const body = (findings: unknown) => ({ status: 'success', result: { prompt: { findings } } });
const tokenLimitation = [{ characters: 1000, chunks_required: 1 }];

describe('recorded API responses', () => {
  it('clean text → no secrets, with the character count the API took', () => {
    expect(parseProtectResponse(recorded('api-clean'))).toEqual({ ok: true, secrets: [], characters: 51, chunksRequired: 1 });
  });

  it('the AWS example key → one secret with type, category and value', () => {
    expect(parseProtectResponse(recorded('api-secret-aws-example'))).toEqual({
      ok: true,
      secrets: [{ entityType: 'AWS credentials', category: 'Access Tokens', entity: AWS_EXAMPLE_KEY }],
      characters: 34,
      chunksRequired: 1,
    });
  });

  it('the verdict comes only from Secrets – action, passed and violations are ignored', () => {
    const response = recorded('api-secret-aws-example');
    const prompt = (response['result'] as { prompt: Record<string, unknown> }).prompt;
    Object.assign(prompt, { action: 'log', passed: true, violations: [] }); // e.g. policy switched Secrets to "log"
    expect(parseProtectResponse(response)).toMatchObject({ ok: true, secrets: [{ entity: AWS_EXAMPLE_KEY }] });

    const clean = recorded('api-clean');
    const cleanPrompt = (clean['result'] as { prompt: Record<string, unknown> }).prompt;
    Object.assign(cleanPrompt, { action: 'block', passed: false, violations: ['Sensitive Data'] }); // blocked for PII only
    expect(parseProtectResponse(clean)).toMatchObject({ ok: true, secrets: [] });
  });

  it('other finding groups (Sensitive Data, URLs Detector) are not secrets', () => {
    const findings = {
      'Sensitive Data': [{ category: 'PII', entity: 'someone@example.com', entity_type: 'Email address' }],
      'URLs Detector': [{ category: 'URL', entity: 'https://example.com', entity_type: 'URL' }],
      'Token Limitation': tokenLimitation,
    };
    expect(parseProtectResponse(body(findings))).toEqual({ ok: true, secrets: [], characters: 1000, chunksRequired: 1 });
  });
});

describe('API_BAD_RESPONSE – never read as clean', () => {
  it.each([
    ['not an object', 'Unauthorized'],
    ['null', null],
    ['an array', []],
    ['status "failed" (wrong field name, as recorded)', { status: 'failed', reason: 'Validation error: …', result: null }],
    ['no status', { result: { prompt: { findings: {} } } }],
    ['result null', { status: 'success', result: null }],
    ['result.prompt null (empty text – never sent)', { status: 'success', result: { prompt: null } }],
    ['no findings object', { status: 'success', result: { prompt: { action: 'log' } } }],
    ['findings is an array', body([])],
    ['Secrets is not an array', body({ Secrets: { entity: AWS_EXAMPLE_KEY } })],
  ])('%s', (_name, response) => {
    expect(parseProtectResponse(response)).toEqual({ ok: false, code: 'API_BAD_RESPONSE' });
  });
});

describe('Secrets entries', () => {
  it('several secrets are kept in order', () => {
    const secrets = [
      { category: 'Access Tokens', entity: AWS_EXAMPLE_KEY, entity_type: 'AWS credentials' },
      { category: 'Passwords', entity: 'not-a-real-password', entity_type: 'Password' },
    ];
    expect(parseProtectResponse(body({ Secrets: secrets, 'Token Limitation': tokenLimitation }))).toMatchObject({
      ok: true,
      secrets: [
        { entityType: 'AWS credentials', category: 'Access Tokens', entity: AWS_EXAMPLE_KEY },
        { entityType: 'Password', category: 'Passwords', entity: 'not-a-real-password' },
      ],
    });
  });

  it('a malformed entry is still a secret: kept with what can be read', () => {
    const secrets = [{}, 42, null, { entity: 7, entity_type: '  ', category: ['x'] }, { entity: '', entity_type: 'Token' }];
    const parsed = parseProtectResponse(body({ Secrets: secrets }));
    expect(parsed).toEqual({
      ok: true,
      secrets: [
        { entityType: 'Secret', category: '', entity: null },
        { entityType: 'Secret', category: '', entity: null },
        { entityType: 'Secret', category: '', entity: null },
        { entityType: 'Secret', category: '', entity: null },
        { entityType: 'Token', category: '', entity: null },
      ],
      characters: null,
      chunksRequired: null,
    });
  });

  it('labels are trimmed and cut to the length a SHOW_RESULT accepts', () => {
    const parsed = parseProtectResponse(body({ Secrets: [{ entity: AWS_EXAMPLE_KEY, entity_type: ` ${'T'.repeat(300)} `, category: ' Access Tokens ' }] }));
    expect(parsed).toMatchObject({ ok: true, secrets: [{ entityType: 'T'.repeat(LABEL_MAX_CHARS), category: 'Access Tokens' }] });
  });

  it('an empty Secrets array or no Secrets group: no secrets', () => {
    expect(parseProtectResponse(body({ Secrets: [] }))).toMatchObject({ ok: true, secrets: [] });
    expect(parseProtectResponse(body({}))).toMatchObject({ ok: true, secrets: [] });
  });
});

describe('Token Limitation', () => {
  it('reads characters and chunks_required from the first entry', () => {
    const findings = { 'Token Limitation': [{ characters: 262_144, chunks_required: 3 }, { characters: 5 }] };
    expect(parseProtectResponse(body(findings))).toMatchObject({ characters: 262_144, chunksRequired: 3 });
  });

  it.each([
    ['missing', {}],
    ['not an array', { 'Token Limitation': { characters: 10 } }],
    ['empty', { 'Token Limitation': [] }],
    ['not numbers', { 'Token Limitation': [{ characters: '10', chunks_required: null }] }],
    ['negative or fractional', { 'Token Limitation': [{ characters: -1, chunks_required: 1.5 }] }],
  ])('%s → null (the cut-short check is then skipped)', (_name, findings) => {
    expect(parseProtectResponse(body(findings))).toMatchObject({ ok: true, characters: null, chunksRequired: null });
  });
});
