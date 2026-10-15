// One chunk → one API call, with timeout and retries (DESIGN.md §4 step 3, §5,
// docs/agents/scanner.md). The global limit on calls in flight (maxConcurrency,
// round-robin across jobs) is added in 6.6; splitting a chunk that was cut
// short in 6.5.
//
//   POST apiUrl   APP-ID: <appId>   {"prompt": "<chunk>"}
//
//   200 + valid body  → { kind: 'ok', … }   (parse.ts)
//   200 + bad body    → API_BAD_RESPONSE     (no retry: it would not change)
//   401               → API_UNAUTHORIZED     (no retry)
//   413               → { kind: 'too-large' } (the caller splits the chunk)
//   429, 5xx          → retried, then API_HTTP_ERROR (detail: the status)
//   no answer         → retried, then API_UNREACHABLE
//   requestTimeoutMs  → retried, then API_TIMEOUT
//   other status      → API_HTTP_ERROR, no retry
// Retries: up to `retries` more attempts, exponential back-off with jitter
// (0.5 s, 1 s, 2 s … + up to 25 %), or the server's Retry-After if longer,
// at most MAX_BACKOFF_MS. The job's signal (jobTimeoutMs) stops everything:
// the request is aborted and the call rejects with the signal's reason.
//
// Never logged: the chunk text, request or response bodies, the APP-ID (the
// safe logger redacts it too), any secret.

import type { Logger } from '../shared/safe-logger.ts';
import type { ErrorCode } from '../shared/types.ts';
import { parseProtectResponse, type RawFinding } from './parse.ts';

export interface ApiSettings {
  apiUrl: string;
  appId: string;
  requestTimeoutMs: number;
  retries: number;
}

export type ApiErrorCode = Extract<
  ErrorCode,
  'NOT_CONFIGURED' | 'API_UNREACHABLE' | 'API_TIMEOUT' | 'API_HTTP_ERROR' | 'API_BAD_RESPONSE' | 'API_UNAUTHORIZED'
>;

export type ApiCallOutcome =
  | { kind: 'ok'; secrets: RawFinding[]; characters: number | null; chunksRequired: number | null }
  /** HTTP 413 – the chunk must be split (6.5). */
  | { kind: 'too-large' }
  | { kind: 'error'; code: ApiErrorCode; detail?: string };

export interface ApiClientDeps {
  fetch: typeof fetch;
  log: Logger;
  /** Waits between attempts; must reject when `signal` aborts. Default: setTimeout. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 0 ≤ random() < 1, for back-off jitter. Default: Math.random. */
  random?: () => number;
}

export interface ApiClient {
  /** Never rejects for API problems; rejects only when `signal` aborts (the job timed out). */
  scanChunk(text: string, settings: ApiSettings, signal: AbortSignal): Promise<ApiCallOutcome>;
}

export const BASE_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 10_000;

/** Waits `ms`, or rejects at once with the signal's reason when it aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry-After in ms (seconds or an HTTP date), or null. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Delay before retry number `attempt` (1 = first retry). */
export function backoffMs(attempt: number, random: () => number, serverMs: number | null = null): number {
  const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  const withJitter = exponential * (1 + 0.25 * random());
  return Math.min(MAX_BACKOFF_MS, Math.max(withJitter, serverMs ?? 0));
}

/** One attempt's result: final, or worth retrying. */
type Attempt =
  | { final: ApiCallOutcome }
  | { retry: { code: ApiErrorCode; detail?: string }; serverDelayMs: number | null };

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const { log } = deps;
  const sleep = deps.sleep ?? abortableSleep;
  const random = deps.random ?? Math.random;

  const attempt = async (body: string, settings: ApiSettings, jobSignal: AbortSignal): Promise<Attempt> => {
    const request = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      request.abort();
    }, settings.requestTimeoutMs);
    const onJobAbort = () => request.abort();
    jobSignal.addEventListener('abort', onJobAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await deps.fetch(settings.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'APP-ID': settings.appId },
          body,
          signal: request.signal,
          credentials: 'omit', // no cookies to the API
          cache: 'no-store',
          redirect: 'error', // the APP-ID header must not follow a redirect elsewhere
        });
      } catch {
        jobSignal.throwIfAborted();
        return timedOut ? { retry: { code: 'API_TIMEOUT' }, serverDelayMs: null } : { retry: { code: 'API_UNREACHABLE' }, serverDelayMs: null };
      }

      const status = response.status;
      if (status === 200) {
        let json: unknown;
        try {
          json = await response.json();
        } catch {
          jobSignal.throwIfAborted();
          if (timedOut) return { retry: { code: 'API_TIMEOUT' }, serverDelayMs: null };
          return { final: { kind: 'error', code: 'API_BAD_RESPONSE' } };
        }
        const parsed = parseProtectResponse(json);
        if (!parsed.ok) return { final: { kind: 'error', code: 'API_BAD_RESPONSE' } };
        return { final: { kind: 'ok', secrets: parsed.secrets, characters: parsed.characters, chunksRequired: parsed.chunksRequired } };
      }
      void response.body?.cancel().catch(() => {}); // the error body is never read
      if (status === 401) return { final: { kind: 'error', code: 'API_UNAUTHORIZED' } };
      if (status === 413) return { final: { kind: 'too-large' } };
      const retryable = status === 429 || (status >= 500 && status <= 599);
      const error = { code: 'API_HTTP_ERROR' as const, detail: String(status) };
      if (!retryable) return { final: { kind: 'error', ...error } };
      return { retry: error, serverDelayMs: retryAfterMs(response.headers.get('Retry-After')) };
    } finally {
      clearTimeout(timer);
      jobSignal.removeEventListener('abort', onJobAbort);
    }
  };

  return {
    async scanChunk(text, settings, signal) {
      signal.throwIfAborted();
      if (settings.appId === '') return { kind: 'error', code: 'NOT_CONFIGURED' };
      const body = JSON.stringify({ prompt: text });
      for (let number = 0; ; number++) {
        const result = await attempt(body, settings, signal);
        if ('final' in result) {
          const outcome = result.final;
          if (outcome.kind === 'ok' && outcome.chunksRequired !== null && outcome.chunksRequired > 1) {
            log.warn('chunk larger than the server prefers', { chunksRequired: outcome.chunksRequired });
          }
          if (outcome.kind === 'error') log.warn('API request failed', { code: outcome.code, ...(outcome.detail ? { status: outcome.detail } : {}) });
          return outcome;
        }
        const { code, detail } = result.retry;
        if (number >= settings.retries) {
          log.warn('API request failed after retries', { code, attempts: number + 1, ...(detail ? { status: detail } : {}) });
          return detail === undefined ? { kind: 'error', code } : { kind: 'error', code, detail };
        }
        const delay = backoffMs(number + 1, random, result.serverDelayMs);
        log.info('API request will be retried', { code, attempt: number + 1, delayMs: Math.round(delay) });
        await sleep(delay, signal);
      }
    },
  };
}
