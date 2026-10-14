#!/usr/bin/env node
// Probes the Prompt Security API to learn its real behaviour (DESIGN.md §5, step 1).
//
// Usage (PowerShell):
//   $env:PSS_APP_ID = "<your APP-ID>"
//   node scripts/probe-api.mjs
//
// Optional: PSS_API_URL (default https://eu.prompt.security/api/protect).
//
// Safety: the APP-ID is never printed. All test secrets are generated at random
// on each run (they are fake). Request texts, secret values and raw response
// bodies are never printed – only their shape, sizes and metadata.

import { randomBytes, randomUUID } from 'node:crypto';

const API_URL = process.env.PSS_API_URL ?? 'https://eu.prompt.security/api/protect';
const APP_ID = process.env.PSS_APP_ID;
const TIMEOUT_MS = 30_000;

if (!APP_ID) {
  console.error('PSS_APP_ID is not set. In PowerShell: $env:PSS_APP_ID = "<your APP-ID>"');
  process.exit(1);
}

// ---------- fake secrets (random every run) ----------
const pick = (alphabet, n) =>
  Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
const UPPER32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

const fake = {
  aws: `AKIA${pick(UPPER32, 16)}`,
  github: `ghp_${pick(ALNUM, 36)}`,
  jwt: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: randomUUID(), iat: 1760000000 })}.${randomBytes(32).toString('base64url')}`,
  pem: [
    '-----BEGIN RSA PRIVATE KEY-----',
    ...(randomBytes(1190).toString('base64').match(/.{1,64}/g) ?? []),
    '-----END RSA PRIVATE KEY-----',
  ].join('\n'),
};
const SECRET_VALUES = Object.values(fake);

// ---------- filler text ----------
const EN = 'The quarterly report covers revenue, hiring plans and the product roadmap for the next release. ';
const HE = 'הדוח הרבעוני מתאר את ההכנסות, תוכניות הגיוס ומפת הדרכים של המוצר לגרסה הבאה. ';
const filler = (base, chars) => base.repeat(Math.ceil(chars / base.length)).slice(0, chars);
// Secret placed near the END, to see whether the server scans the whole text.
const withKeyAtEnd = (base, chars) => `${filler(base, chars - 60)}\nkey: ${fake.aws}\n`;

// ---------- helpers ----------
const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');

/** Replace any generated secret in a string before it could be printed. */
const redact = (s) => SECRET_VALUES.reduce((acc, v) => acc.split(v).join('<redacted>'), s);

/** Shape of a JSON value: keys and types only, no values (except safe scalars). */
function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [`array(${value.length})`, shape(value[0], depth + 1)] : 'array(0)';
  if (typeof value === 'object') {
    if (depth > 3) return 'object';
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
  }
  if (typeof value === 'string') return `string(${value.length})`;
  return typeof value;
}

async function call({ body, headers }) {
  const started = performance.now();
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, ms: Math.round(performance.now() - started), contentType: res.headers.get('content-type'), retryAfter: res.headers.get('retry-after'), text, json };
  } catch (err) {
    return { status: 0, ms: Math.round(performance.now() - started), error: err?.name === 'TimeoutError' ? 'timeout' : String(err?.cause?.code ?? err?.name ?? err) };
  }
}

/** Safe summary of a response. Never includes request text or secret values. */
function summarize(r) {
  if (r.status === 0) return { http: 'NO RESPONSE', error: r.error, ms: r.ms };
  const out = { http: r.status, ms: r.ms, contentType: r.contentType };
  if (r.retryAfter) out.retryAfter = r.retryAfter;
  const j = r.json;
  if (!j) {
    out.body = `non-JSON, ${r.text.length} chars`;
    return out;
  }
  const p = j?.result?.prompt;
  if (r.status === 200 && p) {
    const findings = p.findings ?? {};
    const secrets = Array.isArray(findings.Secrets) ? findings.Secrets : [];
    const tl = Array.isArray(findings['Token Limitation']) ? findings['Token Limitation'][0] : undefined;
    Object.assign(out, {
      status: j.status,
      action: j.result?.action,
      passed: p.passed,
      violations: p.violations,
      findingGroups: Object.keys(findings),
      secrets: secrets.map((s) => ({ entity_type: s.entity_type, category: s.category, entityLength: s.entity?.length })),
      tokenLimitation: tl && { characters: tl.characters, tokens: tl.tokens, tokens_limit: tl.tokens_limit, chunks_required: tl.chunks_required },
    });
    return out;
  }
  // Error or unexpected body: shape only, plus short safe messages.
  out.shape = shape(j);
  for (const key of ['status', 'message', 'error', 'reason', 'detail']) {
    if (typeof j[key] === 'string') out[key] = redact(j[key]).slice(0, 200);
  }
  return out;
}

const jsonBody = (prompt) => JSON.stringify({ prompt });
const auth = { 'APP-ID': APP_ID };

// ---------- probes ----------
const probes = [
  { name: 'clean text', body: jsonBody('Hello, this is a normal sentence about the weather.'), headers: auth },
  { name: 'AWS key (random)', body: jsonBody(`deploy with key ${fake.aws} please`), headers: auth },
  { name: 'GitHub token (random)', body: jsonBody(`token=${fake.github}`), headers: auth },
  { name: 'JWT (random)', body: jsonBody(`Authorization: Bearer ${fake.jwt}`), headers: auth },
  { name: 'PEM private key (random)', body: jsonBody(`Server key:\n${fake.pem}\n`), headers: auth },
  { name: 'PII only (email + phone)', body: jsonBody('Contact Dana Levi at dana.levi@example.com or +972-52-555-0123.'), headers: auth },
  { name: 'URL only', body: jsonBody('See https://example.com/docs/setup for details.'), headers: auth },
  { name: 'invalid APP-ID', body: jsonBody('Hello'), headers: { 'APP-ID': randomUUID() } },
  { name: 'missing APP-ID', body: jsonBody('Hello'), headers: {} },
  { name: 'malformed JSON body', body: '{"prompt": "unterminated', headers: auth },
  { name: 'wrong field name', body: JSON.stringify({ text: 'Hello' }), headers: auth },
  { name: 'empty prompt', body: jsonBody(''), headers: auth },
];

const SIZES = [4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000, 1_000_000];
for (const n of SIZES) probes.push({ name: `size ASCII ${n} chars, key at end`, body: jsonBody(withKeyAtEnd(EN, n)), headers: auth, series: 'ascii' });
for (const n of [4_000, 16_000, 64_000, 256_000]) probes.push({ name: `size Hebrew ${n} chars, key at end`, body: jsonBody(withKeyAtEnd(HE, n)), headers: auth, series: 'hebrew' });

// ---------- run ----------
console.log(`Probing ${API_URL}  (Node ${process.version}, ${new Date().toISOString()})`);
console.log('APP-ID: set (not shown). All secrets below are random fakes; values are never printed.\n');

const failedSeries = new Set();
for (const p of probes) {
  if (p.series && failedSeries.has(p.series)) {
    console.log(`- ${p.name}: skipped (a smaller size in this series already failed)`);
    continue;
  }
  const r = await call(p);
  const s = summarize(r);
  if (p.series) Object.assign(s, { requestBytes: utf8Bytes(p.body) });
  if (p.series && (r.status !== 200 || !r.json?.result?.prompt)) failedSeries.add(p.series);
  console.log(`- ${p.name}: ${JSON.stringify(s)}`);
}

// Burst: 20 small requests at once, to look for rate limiting (HTTP 429).
const BURST = 20;
const burst = await Promise.all(Array.from({ length: BURST }, () => call({ body: jsonBody('burst test'), headers: auth })));
const counts = {};
for (const r of burst) counts[r.status || 'no response'] = (counts[r.status || 'no response'] ?? 0) + 1;
const retryAfter = burst.find((r) => r.retryAfter)?.retryAfter;
const times = burst.map((r) => r.ms).sort((a, b) => a - b);
console.log(`- burst of ${BURST} concurrent requests: ${JSON.stringify({ statusCounts: counts, retryAfter, msMin: times[0], msMedian: times[Math.floor(times.length / 2)], msMax: times.at(-1) })}`);

console.log('\nDone. Paste everything above into the chat.');
