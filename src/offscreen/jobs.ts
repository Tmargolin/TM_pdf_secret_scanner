// Job registry – every file of every tab becomes a job (DESIGN.md §4.1,
// docs/agents/offscreen.md). Lives in the offscreen document; the limits are
// global across all tabs and frames.
//
//   arrival  → too large (sent without bytes)         → FILE_TOO_LARGE at once
//            → queued + this file > maxQueuedMB       → QUEUE_FULL at once (bytes dropped)
//            → queued (FIFO)
//   start    → when running + this file ≤ maxInFlightMB, or nothing is running
//   running  → runJob(job, bytes, signal); jobTimeoutMs from the start (D38)
//            → SCAN_TIMEOUT, signal aborted
//   any unexpected exception in a job → SCAN_INTERRUPTED for that job only (D38)
// A job's bytes are released when it ends.

import type { ScanRequest } from '../shared/messages.ts';
import type { Logger } from '../shared/safe-logger.ts';
import type { ErrorCode, ScanResult } from '../shared/types.ts';
import type { ReceivedBatch } from './batch-receiver.ts';

const MB = 1024 * 1024;

export interface JobLimits {
  maxInFlightMB: number;
  maxQueuedMB: number;
  jobTimeoutMs: number;
}

export type JobState = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  scanId: string;
  batchId: string;
  fileName: string;
  /** Decoded size in bytes. */
  size: number;
  origin: string;
  tabId: number | undefined;
  frameId: number | undefined;
  state: JobState;
}

/** What the work for one file produces; the registry adds the ids. */
export type JobOutcome = Pick<ScanResult, 'status' | 'findings' | 'errors' | 'stats'>;

/** The work for one job. Must stop soon after `signal` aborts (timeout). */
export type RunJob = (job: Readonly<Job>, bytes: Uint8Array, signal: AbortSignal) => Promise<JobOutcome>;

export interface JobRegistryDeps {
  /** Read on every decision, so changed settings apply to the next job. */
  limits(): JobLimits;
  runJob: RunJob;
  log: Logger;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface RegistryStats {
  queued: number;
  running: number;
  /** Bytes received and not finished (queued + running) – checked against maxQueuedMB. */
  pendingBytes: number;
  /** Bytes of running jobs – checked against maxInFlightMB. */
  runningBytes: number;
}

export interface JobRegistry {
  /** Admits every file of the batch; resolves with one result per file, in the batch's order. Never rejects. */
  submitBatch(batch: ReceivedBatch): Promise<ScanResult[]>;
  stats(): RegistryStats;
}

/** A failed result for a job that produced nothing else. */
export function errorResult(job: Pick<Job, 'scanId' | 'batchId' | 'fileName'>, code: ErrorCode): ScanResult {
  return { scanId: job.scanId, batchId: job.batchId, fileName: job.fileName, status: 'error', findings: [], errors: [{ code }] };
}

/** base64 → bytes (the content script encoded them; the scan port validated the length). */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface Entry {
  job: Job;
  base64: string | null;
  resolve(result: ScanResult): void;
}

export function createJobRegistry(deps: JobRegistryDeps): JobRegistry {
  const { log } = deps;
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const queue: Entry[] = [];
  let running = 0;
  let runningBytes = 0;
  let pendingBytes = 0;

  const pump = (): void => {
    while (queue.length > 0) {
      const next = queue[0] as Entry;
      const limit = deps.limits().maxInFlightMB * MB;
      // Nothing running: always start, or a file bigger than the limit would wait forever.
      if (running > 0 && runningBytes + next.job.size > limit) return;
      queue.shift();
      void start(next);
    }
  };

  const start = async (entry: Entry): Promise<void> => {
    const { job } = entry;
    job.state = 'running';
    running++;
    runningBytes += job.size;
    const controller = new AbortController();
    let timer: unknown = null;
    let result: ScanResult;
    try {
      const bytes = decodeBase64(entry.base64 ?? '');
      entry.base64 = null; // the bytes now live only in the running work
      const work = deps.runJob(job, bytes, controller.signal);
      work.catch(() => {}); // if it fails after a timeout, nobody is waiting for it any more
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimer(() => resolve('timeout'), deps.limits().jobTimeoutMs);
      });
      const outcome = await Promise.race([work, timeout]);
      if (outcome === 'timeout') {
        controller.abort();
        log.warn('job timed out');
        result = errorResult(job, 'SCAN_TIMEOUT');
      } else {
        result = { scanId: job.scanId, batchId: job.batchId, fileName: job.fileName, ...outcome };
      }
    } catch (error) {
      log.error('job failed unexpectedly', { error });
      result = errorResult(job, 'SCAN_INTERRUPTED');
    } finally {
      if (timer !== null) clearTimer(timer);
      entry.base64 = null;
      running--;
      runningBytes -= job.size;
      pendingBytes -= job.size;
    }
    job.state = result.status === 'error' ? 'failed' : 'done';
    entry.resolve(result);
    pump();
  };

  const admit = (request: ScanRequest, batch: ReceivedBatch): Promise<ScanResult> => {
    const job: Job = {
      scanId: request.scanId,
      batchId: batch.batchId,
      fileName: request.fileName,
      size: request.size,
      origin: batch.origin,
      tabId: batch.tabId,
      frameId: batch.frameId,
      state: 'queued',
    };
    if ('skipped' in request) return Promise.resolve(errorResult(job, 'FILE_TOO_LARGE'));
    if (pendingBytes + job.size > deps.limits().maxQueuedMB * MB) {
      log.warn('queue full: file not scanned', { queuedBytes: pendingBytes });
      return Promise.resolve(errorResult(job, 'QUEUE_FULL'));
    }
    pendingBytes += job.size;
    return new Promise<ScanResult>((resolve) => {
      queue.push({ job, base64: request.base64, resolve });
      pump();
    });
  };

  return {
    submitBatch: (batch) => Promise.all(batch.requests.map((request) => admit(request, batch))),
    stats: () => ({ queued: queue.length, running, pendingBytes, runningBytes }),
  };
}
