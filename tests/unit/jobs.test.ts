// Unit tests of the job registry (src/offscreen/jobs.ts, DESIGN.md §4.1, D38).
// runJob is a fake whose jobs the test finishes by hand, and the timer is a
// fake the test fires by hand – so every step is deterministic.
//
// Sizes: the registry trusts request.size (the scan port already checked it
// against the base64), so tests give large sizes with tiny base64 to exercise
// the MB limits without building megabytes.
import { describe, expect, it } from 'vitest';
import type { ReceivedBatch } from '../../src/offscreen/batch-receiver.ts';
import { createJobRegistry, type Job, type JobLimits, type JobOutcome } from '../../src/offscreen/jobs.ts';
import type { ScanRequest } from '../../src/shared/messages.ts';
import { createLogger, type LogLevel } from '../../src/shared/safe-logger.ts';
import type { ScanResult } from '../../src/shared/types.ts';

const MB = 1024 * 1024;
const CLEAN: JobOutcome = { status: 'clean', findings: [], errors: [] };

let nextId = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;

/** A file of `mb` megabytes (by its declared size); its bytes are the name. */
function file(name: string, mb = 1): ScanRequest {
  return { type: 'SCAN_REQUEST', scanId: uuid(), batchId: '', fileName: name, size: mb * MB, base64: btoa(name.padEnd(3 * Math.ceil(name.length / 3))) };
}
function tooLarge(name: string): ScanRequest {
  return { type: 'SCAN_REQUEST', scanId: uuid(), batchId: '', fileName: name, size: 99 * MB, skipped: 'FILE_TOO_LARGE' };
}
function batch(requests: ScanRequest[], tabId = 1): ReceivedBatch {
  const batchId = uuid();
  return { batchId, origin: 'https://site.example', tabId, frameId: 0, requests: requests.map((r) => ({ ...r, batchId })) };
}

/** Lets pending promise callbacks run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

interface Running {
  job: Readonly<Job>;
  bytes: Uint8Array;
  signal: AbortSignal;
  finish(outcome?: JobOutcome): void;
  fail(error: unknown): void;
}

function setup(initial: Partial<JobLimits> = {}, options: { runJob?: (job: Readonly<Job>) => Promise<JobOutcome> } = {}) {
  const limits: JobLimits = { maxInFlightMB: 10, maxQueuedMB: 20, jobTimeoutMs: 1000, ...initial };
  const running = new Map<string, Running>();
  const started: string[] = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let timerId = 0;
  const lines: { level: LogLevel; line: string; fields?: unknown }[] = [];
  const registry = createJobRegistry({
    limits: () => ({ ...limits }),
    runJob: (job, bytes, signal) => {
      started.push(job.fileName);
      if (options.runJob) return options.runJob(job);
      return new Promise<JobOutcome>((resolve, reject) => {
        running.set(job.fileName, { job, bytes, signal, finish: (outcome = CLEAN) => resolve(outcome), fail: reject });
      });
    },
    log: createLogger('offscreen', { dev: true, sink: (level, line, fields) => void lines.push({ level, line, fields }) }),
    setTimer: (callback, ms) => {
      timers.set(++timerId, { callback, ms });
      return timerId;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
  });
  /** Fires every pending timer (all running jobs time out). */
  const fireTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((t) => t.callback());
  };
  const get = (name: string) => {
    const r = running.get(name);
    if (!r) throw new Error(`${name} is not running`);
    return r;
  };
  return { registry, limits, running, started, timers, fireTimers, get, lines };
}

const codes = (results: ScanResult[]) => results.map((r) => r.errors.map((e) => e.code).join(',') || r.status);

describe('admission', () => {
  it('a file sent without bytes is FILE_TOO_LARGE at once and never runs', async () => {
    const t = setup();
    const results = await t.registry.submitBatch(batch([tooLarge('big.pdf')]));
    expect(results).toEqual([expect.objectContaining({ fileName: 'big.pdf', status: 'error', errors: [{ code: 'FILE_TOO_LARGE' }] })]);
    expect(results[0]?.stats).toBeUndefined();
    expect(t.started).toEqual([]);
    expect(t.registry.stats()).toEqual({ queued: 0, running: 0, pendingBytes: 0, runningBytes: 0 });
  });

  it('QUEUE_FULL when the file would take pending bytes above maxQueuedMB; the others are kept', async () => {
    const t = setup({ maxQueuedMB: 10, maxInFlightMB: 10 });
    const done = t.registry.submitBatch(batch([file('a.pdf', 6), file('b.pdf', 5), file('c.pdf', 4)]));
    await flush();
    expect(t.registry.stats().pendingBytes).toBe(10 * MB); // a + c; b did not fit
    t.get('a.pdf').finish();
    await flush();
    t.get('c.pdf').finish();
    expect(codes(await done)).toEqual(['clean', 'QUEUE_FULL', 'clean']);
    expect(t.started).toEqual(['a.pdf', 'c.pdf']);
  });

  it('exactly maxQueuedMB is accepted', async () => {
    const t = setup({ maxQueuedMB: 10 });
    void t.registry.submitBatch(batch([file('a.pdf', 4), file('b.pdf', 6)]));
    await flush();
    expect(t.registry.stats().pendingBytes).toBe(10 * MB);
  });

  it('space is freed when a job ends, so a later file is accepted again', async () => {
    const t = setup({ maxQueuedMB: 10 });
    const first = t.registry.submitBatch(batch([file('a.pdf', 8)]));
    expect(codes(await t.registry.submitBatch(batch([file('b.pdf', 8)])))).toEqual(['QUEUE_FULL']);
    await flush();
    t.get('a.pdf').finish();
    await first;
    const later = t.registry.submitBatch(batch([file('c.pdf', 8)]));
    await flush();
    t.get('c.pdf').finish();
    expect(codes(await later)).toEqual(['clean']);
  });

  it('a QUEUE_FULL warning is logged with counts only, never file names', async () => {
    const t = setup({ maxQueuedMB: 1 });
    await t.registry.submitBatch(batch([file('secret-plans.pdf', 2)]));
    expect(t.lines.some((l) => l.level === 'warn' && l.line.includes('queue full'))).toBe(true);
    expect(JSON.stringify(t.lines)).not.toContain('secret-plans');
  });
});

describe('starting jobs (maxInFlightMB, FIFO)', () => {
  it('jobs start while their bytes fit in maxInFlightMB; the rest wait', async () => {
    const t = setup({ maxInFlightMB: 5 });
    void t.registry.submitBatch(batch([file('a.pdf', 3), file('b.pdf', 2), file('c.pdf', 1)]));
    await flush();
    expect(t.started).toEqual(['a.pdf', 'b.pdf']);
    expect(t.registry.stats()).toEqual({ queued: 1, running: 2, pendingBytes: 6 * MB, runningBytes: 5 * MB });
    t.get('b.pdf').finish();
    await flush();
    expect(t.started).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('strict FIFO: a small file does not overtake a big one waiting at the head', async () => {
    const t = setup({ maxInFlightMB: 5 });
    void t.registry.submitBatch(batch([file('a.pdf', 3), file('big.pdf', 4), file('small.pdf', 1)]));
    await flush();
    expect(t.started).toEqual(['a.pdf']); // small would fit, but big is first in line
    t.get('a.pdf').finish();
    await flush();
    expect(t.started).toEqual(['a.pdf', 'big.pdf', 'small.pdf']);
  });

  it('a lone job larger than maxInFlightMB still starts', async () => {
    const t = setup({ maxInFlightMB: 1, maxQueuedMB: 20 });
    void t.registry.submitBatch(batch([file('huge.pdf', 15), file('next.pdf', 1)]));
    await flush();
    expect(t.started).toEqual(['huge.pdf']);
    t.get('huge.pdf').finish();
    await flush();
    expect(t.started).toEqual(['huge.pdf', 'next.pdf']);
  });

  it('batches from two tabs share the same limits and the same queue', async () => {
    const t = setup({ maxInFlightMB: 4, maxQueuedMB: 8 });
    const tab1 = t.registry.submitBatch(batch([file('t1.pdf', 3)], 1));
    const tab2 = t.registry.submitBatch(batch([file('t2.pdf', 3), file('t2-big.pdf', 3)], 2));
    await flush();
    expect(t.started).toEqual(['t1.pdf']);
    t.get('t1.pdf').finish();
    await flush();
    t.get('t2.pdf').finish();
    expect(codes(await tab1)).toEqual(['clean']);
    expect(codes(await tab2)).toEqual(['clean', 'QUEUE_FULL']);
    expect(t.running.get('t2.pdf')?.job.tabId).toBe(2);
  });

  it('limits are read at each decision: a changed maxInFlightMB applies to the next start', async () => {
    const t = setup({ maxInFlightMB: 2 });
    void t.registry.submitBatch(batch([file('a.pdf', 2), file('b.pdf', 2), file('c.pdf', 2)]));
    await flush();
    expect(t.started).toEqual(['a.pdf']);
    t.limits.maxInFlightMB = 4;
    t.get('a.pdf').finish();
    await flush();
    expect(t.started).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });
});

describe('running a job', () => {
  it('runJob gets the decoded bytes, the job with its origin and tab, and state running', async () => {
    const t = setup();
    const b = batch([file('abc', 1)], 9);
    void t.registry.submitBatch(b);
    await flush();
    const r = t.get('abc');
    expect(new TextDecoder().decode(r.bytes)).toBe('abc');
    expect(r.job).toMatchObject({ batchId: b.batchId, origin: 'https://site.example', tabId: 9, frameId: 0, state: 'running' });
    expect(r.signal.aborted).toBe(false);
  });

  it('a result carries the ids and the outcome of runJob', async () => {
    const t = setup();
    const b = batch([file('a.pdf')]);
    const done = t.registry.submitBatch(b);
    await flush();
    const outcome: JobOutcome = { status: 'error', findings: [], errors: [{ code: 'PDF_ENCRYPTED' }] };
    t.get('a.pdf').finish(outcome);
    expect(await done).toEqual([{ scanId: b.requests[0]?.scanId, batchId: b.batchId, fileName: 'a.pdf', ...outcome }]);
    expect(t.get('a.pdf').job.state).toBe('failed');
  });

  it('results come back in the batch order, whatever order the jobs finish in', async () => {
    const t = setup();
    const done = t.registry.submitBatch(batch([file('a.pdf'), tooLarge('big.pdf'), file('c.pdf')]));
    await flush();
    t.get('c.pdf').finish();
    await flush();
    t.get('a.pdf').finish();
    expect((await done).map((r) => r.fileName)).toEqual(['a.pdf', 'big.pdf', 'c.pdf']);
  });

  it('when all jobs end the counters are back to zero and no timer is left', async () => {
    const t = setup({ maxInFlightMB: 1 });
    const done = t.registry.submitBatch(batch([file('a.pdf'), file('b.pdf')]));
    await flush();
    t.get('a.pdf').finish();
    await flush();
    t.get('b.pdf').finish();
    await done;
    expect(t.registry.stats()).toEqual({ queued: 0, running: 0, pendingBytes: 0, runningBytes: 0 });
    expect(t.timers.size).toBe(0);
    expect(t.get('a.pdf').job.state).toBe('done');
  });
});

describe('timeout (jobTimeoutMs, D38)', () => {
  it('the timer starts when the job starts – time in the queue is not counted', async () => {
    const t = setup({ maxInFlightMB: 1, jobTimeoutMs: 500 });
    void t.registry.submitBatch(batch([file('a.pdf'), file('b.pdf')]));
    await flush();
    expect(t.timers.size).toBe(1); // only a.pdf is running
    expect([...t.timers.values()][0]?.ms).toBe(500);
    t.get('a.pdf').finish();
    await flush();
    expect(t.timers.size).toBe(1); // now b.pdf's own timer
  });

  it('a job that runs too long: SCAN_TIMEOUT, its signal aborted, the next job starts', async () => {
    const t = setup({ maxInFlightMB: 1 });
    const done = t.registry.submitBatch(batch([file('slow.pdf'), file('next.pdf')]));
    await flush();
    t.fireTimers();
    await flush();
    expect(t.get('slow.pdf').signal.aborted).toBe(true);
    expect(t.started).toEqual(['slow.pdf', 'next.pdf']);
    t.get('next.pdf').finish();
    expect(codes(await done)).toEqual(['SCAN_TIMEOUT', 'clean']);
    expect(t.lines.some((l) => l.level === 'warn' && l.line.includes('timed out'))).toBe(true);
  });

  it('a changed jobTimeoutMs applies to the next job', async () => {
    const t = setup({ maxInFlightMB: 1, jobTimeoutMs: 500 });
    void t.registry.submitBatch(batch([file('a.pdf'), file('b.pdf')]));
    await flush();
    t.limits.jobTimeoutMs = 2000;
    t.get('a.pdf').finish();
    await flush();
    expect([...t.timers.values()].map((x) => x.ms)).toEqual([2000]);
  });

  it('a timed-out job that finishes or fails later changes nothing', async () => {
    const t = setup();
    const done = t.registry.submitBatch(batch([file('a.pdf'), file('b.pdf')]));
    await flush();
    t.fireTimers();
    const results = await done;
    t.get('a.pdf').finish();
    t.get('b.pdf').fail(new Error('aborted'));
    await flush();
    expect(codes(results)).toEqual(['SCAN_TIMEOUT', 'SCAN_TIMEOUT']);
    expect(t.registry.stats()).toEqual({ queued: 0, running: 0, pendingBytes: 0, runningBytes: 0 });
    expect(t.lines.some((l) => l.level === 'error')).toBe(false);
  });
});

describe('job isolation (SCAN_INTERRUPTED, D38)', () => {
  it('a job whose work rejects is SCAN_INTERRUPTED; the other jobs are not affected', async () => {
    const t = setup();
    const done = t.registry.submitBatch(batch([file('bad.pdf'), file('good.pdf')]));
    await flush();
    t.get('bad.pdf').fail(new Error('boom'));
    await flush();
    t.get('good.pdf').finish();
    expect(codes(await done)).toEqual(['SCAN_INTERRUPTED', 'clean']);
    expect(t.lines.some((l) => l.level === 'error' && l.line.includes('job failed unexpectedly'))).toBe(true);
  });

  it('a runJob that throws at once is SCAN_INTERRUPTED and frees its place', async () => {
    const t = setup({ maxInFlightMB: 1 }, {
      runJob: (job) => {
        if (job.fileName === 'bad.pdf') throw new Error('sync boom');
        return Promise.resolve(CLEAN);
      },
    });
    const results = await t.registry.submitBatch(batch([file('bad.pdf'), file('good.pdf')]));
    expect(codes(results)).toEqual(['SCAN_INTERRUPTED', 'clean']);
    expect(t.registry.stats()).toEqual({ queued: 0, running: 0, pendingBytes: 0, runningBytes: 0 });
    expect(t.timers.size).toBe(0);
  });

  it('submitBatch never rejects', async () => {
    const t = setup({}, { runJob: () => Promise.reject(new Error('always')) });
    await expect(t.registry.submitBatch(batch([file('a.pdf'), tooLarge('b.pdf')]))).resolves.toHaveLength(2);
  });

  it('an empty batch resolves with no results', async () => {
    const t = setup();
    expect(await t.registry.submitBatch(batch([]))).toEqual([]);
  });
});
