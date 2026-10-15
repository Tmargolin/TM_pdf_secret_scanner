#!/usr/bin/env node
// Local mock of the Prompt Security API for manual testing with the DEV build
// (DESIGN.md §5, §12). Mirrors the behaviour recorded by scripts/probe-api.mjs.
//
//   npm run mock-api
//   → POST http://localhost:8787/api/protect   (set this as the API URL in a dev build)
//
// Environment variables (all optional):
//   MOCK_PORT         port (default 8787)
//   MOCK_APP_ID       the only APP-ID accepted (default "mock-app-id"); any other → 401,
//                     like the real API
//   MOCK_SCAN_WINDOW  characters actually scanned (default 131072); text beyond it is
//                     silently ignored, like the real API
//   MOCK_MODE         normal (default) | 413 | 429 | 500 | timeout | malformed
//   MOCK_LATENCY_MS   added delay per request (default 0)
//
// Logs one line per request (status, sizes, finding counts) – never the text.

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8787);
const APP_ID = process.env.MOCK_APP_ID ?? 'mock-app-id';
const SCAN_WINDOW = Number(process.env.MOCK_SCAN_WINDOW ?? 131_072);
const MODE = process.env.MOCK_MODE ?? 'normal';
const LATENCY_MS = Number(process.env.MOCK_LATENCY_MS ?? 0);

/** The real API caps the input it reports at 2^18 characters. */
const INPUT_CAP = 262_144;

const DETECTORS = [
  { group: 'Secrets', regex: /\bAKIA[A-Z2-7]{16}\b/g, entity_type: 'AWS credentials', category: 'Access Tokens' },
  { group: 'Sensitive Data', regex: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, entity_type: 'Email address', category: 'PII' },
  { group: 'URLs Detector', regex: /\bhttps?:\/\/[^\s"']+/g, entity_type: 'URL', category: 'URL' },
];
const ACTIONS = { Secrets: 'block', 'Sensitive Data': 'block', 'URLs Detector': 'log', 'Token Limitation': 'log' };

const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function protectResponse(prompt) {
  const input = prompt.slice(0, INPUT_CAP);
  const scanned = input.slice(0, SCAN_WINDOW);

  const findings = {};
  for (const d of DETECTORS) {
    const matches = [...new Set(scanned.match(d.regex) ?? [])];
    if (matches.length === 0) continue;
    findings[d.group] = d.group === 'Secrets'
      ? matches.map((entity) => ({ category: d.category, entity, entity_type: d.entity_type, sanitized_entity: null }))
      : matches.map((entity) => ({ category: d.category, entity, entity_type: d.entity_type }));
  }
  findings['Token Limitation'] = [{
    characters: input.length, chunks_required: 1, difficult_words: 0, letters: 0, lines: input.split('\n').length,
    misspellings: 0, reading_time: 0, sentences: 0, syllables: 0, text_standard: '0',
    tokens: Math.ceil(input.length / 5), tokens_limit: 0, words: input.split(/\s+/).filter(Boolean).length,
  }];

  const violations = Object.keys(findings).filter((g) => ACTIONS[g] === 'block');
  const action = violations.length ? 'block' : 'log';
  const promptResult = {
    action,
    findings,
    latency: { Secrets: 2, 'Sensitive Data': 2, 'Token Limitation': 0, Total: 4, 'URLs Detector': 0 },
    modified_messages: null,
    modified_text: violations.length ? 'simply respond with the text Blocked due to policy violations' : null,
    passed: violations.length === 0,
    protection_actions: { Secrets: 'block', 'Sensitive Data': 'block', 'Token Limitation': 'log', 'URLs Detector': 'log' },
    scores: {},
    violating_findings: '',
    violations,
  };
  const groupsForTopLevel = Object.fromEntries(
    Object.entries(findings).map(([g, list]) => [g, g === 'Token Limitation' ? [] : [...new Set(list.map((f) => f.entity_type))]]),
  );
  return {
    reason: null,
    result: {
      action, benign_fastpath_details: null, conversation_id: uuid(), input: null,
      is_benign_fastpath: false, is_malicious_fastpath: false, latency: 4, monitor_only: false,
      output: null, prompt: promptResult, prompt_response_id: uuid(), response: null,
      user: null, user_groups: null, totalLatency: 40, ruleInfo: {}, findings: groupsForTopLevel,
    },
    status: 'success',
    ruleInfo: {},
  };
}

function emptyPromptResponse() {
  return {
    reason: null,
    result: {
      action: 'log', benign_fastpath_details: null, conversation_id: uuid(), input: null,
      is_benign_fastpath: false, is_malicious_fastpath: false, latency: 0, monitor_only: false,
      output: null, prompt: null, prompt_response_id: uuid(), protect_logs: null, response: null,
      user: null, user_groups: null, totalLatency: 10, ruleInfo: {},
    },
    status: 'success',
    ruleInfo: {},
  };
}

function send(res, status, body, headers = {}) {
  const isString = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isString ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(isString ? body : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    const log = (status, extra = '') => console.log(`${new Date().toISOString()} ${req.method} ${req.url} → ${status} ${extra}`);
    if (LATENCY_MS) await sleep(LATENCY_MS);

    if (req.method !== 'POST' || req.url !== '/api/protect') { log(404); return send(res, 404, { message: 'Not Found' }); }

    const appId = req.headers['app-id'];
    if (appId !== APP_ID) { log(401); return send(res, 401, { message: 'Unauthorized' }); }

    switch (MODE) {
      case '413': log(413, '(MOCK_MODE)'); return send(res, 413, 'Payload Too Large');
      case '429': log(429, '(MOCK_MODE)'); return send(res, 429, { message: 'Too Many Requests' }, { 'Retry-After': '2' });
      case '500': log(500, '(MOCK_MODE)'); return send(res, 500, { message: 'Internal Server Error' });
      case 'timeout': log('no response', '(MOCK_MODE)'); return; // never answers
      case 'malformed': log(200, '(MOCK_MODE malformed)'); return send(res, 200, '{"status":"success","result":{');
      default: break;
    }

    let body;
    try { body = JSON.parse(raw); } catch {
      log(400);
      return send(res, 400, { error: "Body is not valid JSON but content-type is set to 'application/json'", statusCode: 400 });
    }
    if (typeof body?.prompt !== 'string') {
      log(200, '(validation failed)');
      return send(res, 200, {
        reason: "Validation error: You must specify at least one of the following parameters: 'prompt', 'prompts', 'messages', 'response', 'response_messages', 'input' or 'output'",
        result: null, status: 'failed', ruleInfo: {},
      });
    }
    if (body.prompt === '') { log(200, '(empty prompt)'); return send(res, 200, emptyPromptResponse()); }

    const out = protectResponse(body.prompt);
    const secrets = out.result.prompt.findings.Secrets?.length ?? 0;
    log(200, `chars=${body.prompt.length} secrets=${secrets} action=${out.result.action}`);
    return send(res, 200, out);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock Prompt Security API on http://localhost:${PORT}/api/protect`);
  console.log(`mode=${MODE} scanWindow=${SCAN_WINDOW} latencyMs=${LATENCY_MS} appId=${process.env.MOCK_APP_ID ? 'from MOCK_APP_ID (not shown)' : 'mock-app-id'}`);
});
