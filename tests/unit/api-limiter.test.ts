// Unit tests of the global API call limiter (src/scanner/api-limiter.ts,
// DESIGN.md §4.1 "Scheduling"). Calls are promises the test finishes by
// hand, so the order of starts is fully deterministic.
import { describe, expect, it } from 'vitest';
import { createApiLimiter } from '../../src/scanner/api-limiter.ts';

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Calls the test finishes by hand; records the order they started in and the peak in flight. */
function calls() {
  const started: string[] = [];
  const finishers = new Map<string, { resolve(): void; reject(e: unknown): void }>();
  let inFlight = 0;
  let peak = 0;
  const call = (name: string) => () => {
    started.push(name);
    inFlight++;
    peak = Math.max(peak, inFlight);
    return new Promise<string>((resolve, reject) => {
      finishers.set(name, {
        resolve: () => {
          inFlight--;
          resolve(name);
        },
        reject: (e) => {
          inFlight--;
          reject(e);
        },
      });
    });
  };
  const settle = (name: string) => {
    const finisher = finishers.get(name);
    finishers.delete(name);
    return finisher;
  };
  const finish = async (...names: string[]) => {
    for (const name of names) settle(name)?.resolve();
    await flush();
  };
  /** Finishes whatever is running, oldest first, until nothing runs. */
  const drain = async () => {
    for (let guard = 0; guard < 10_000 && inFlight > 0; guard++) {
      const running = started.find((name) => finishers.has(name));
      if (!running) break;
      settle(running)?.resolve();
      await flush();
    }
  };
  return { started, call, finish, drain, peak: () => peak, fail: (name: string, e: unknown) => settle(name)?.reject(e) };
}

describe('the limit (maxConcurrency)', () => {
  it('never more than max() calls in flight, across many jobs', async () => {
    const limiter = createApiLimiter(() => 4);
    const c = calls();
    const all: Promise<string>[] = [];
    for (const job of ['a', 'b', 'c', 'd', 'e']) for (let i = 0; i < 6; i++) all.push(limiter.run(job, c.call(`${job}${i}`)));
    await flush();
    expect(c.started).toHaveLength(4);
    await c.drain();
    await Promise.all(all);
    expect(c.peak()).toBe(4);
    expect(c.started).toHaveLength(30);
    expect(limiter.stats()).toEqual({ active: 0, waiting: 0, jobsWaiting: 0 });
  });

  it('max() is read at every decision: raising it starts more, lowering it holds back', async () => {
    let max = 1;
    const limiter = createApiLimiter(() => max);
    const c = calls();
    ['a1', 'a2', 'a3', 'a4'].forEach((name) => void limiter.run('a', c.call(name)));
    await flush();
    max = 3;
    await c.finish('a1');
    expect(c.started).toEqual(['a1', 'a2', 'a3', 'a4']);
    void limiter.run('a', c.call('a5'));
    max = 1;
    await c.finish('a2');
    expect(c.started).not.toContain('a5'); // 2 still run, limit 1: a5 waits
    await c.finish('a3', 'a4');
    expect(c.started).toContain('a5');
  });

  it('a failing call passes its error on and frees its slot', async () => {
    const limiter = createApiLimiter(() => 1);
    const c = calls();
    const first = limiter.run('a', c.call('a1'));
    void limiter.run('b', c.call('b1'));
    c.fail('a1', new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await flush();
    expect(c.started).toEqual(['a1', 'b1']);
  });

  it('a call that throws at once is a rejection, and frees its slot', async () => {
    const limiter = createApiLimiter(() => 1);
    await expect(
      limiter.run('a', () => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(limiter.stats().active).toBe(0);
  });
});

describe('round-robin across jobs', () => {
  it('a 1-chunk job arriving after a 300-chunk job waits for at most one of its calls', async () => {
    const limiter = createApiLimiter(() => 4);
    const c = calls();
    for (let i = 0; i < 300; i++) void limiter.run('big', c.call(`big${i}`));
    await flush();
    void limiter.run('small', c.call('small')); // turn order: big, small
    await c.finish('big0', 'big1'); // two slots free: one more for big, then small's turn
    expect(c.started.slice(4)).toEqual(['big4', 'small']);
  });

  it('jobs take turns, one call each; FIFO within a job', async () => {
    const limiter = createApiLimiter(() => 1);
    const c = calls();
    void limiter.run('a', c.call('a1')); // runs at once
    ['a2', 'a3', 'a4'].forEach((name) => void limiter.run('a', c.call(name)));
    ['b1', 'b2'].forEach((name) => void limiter.run('b', c.call(name)));
    void limiter.run('c', c.call('c1'));
    await c.drain();
    expect(c.started).toEqual(['a1', 'a2', 'b1', 'c1', 'a3', 'b2', 'a4']);
  });

  it('a job that joins later goes to the back of the turn order', async () => {
    const limiter = createApiLimiter(() => 1);
    const c = calls();
    void limiter.run('a', c.call('a1'));
    ['a2', 'a3'].forEach((name) => void limiter.run('a', c.call(name)));
    void limiter.run('b', c.call('b1'));
    await c.finish('a1'); // a2 runs; turn order is now b, a
    void limiter.run('c', c.call('c1'));
    await c.drain();
    expect(c.started).toEqual(['a1', 'a2', 'b1', 'a3', 'c1']);
  });

  it('a new call does not jump ahead of waiting calls, even when a slot looks free', async () => {
    let max = 1;
    const limiter = createApiLimiter(() => max);
    const c = calls();
    void limiter.run('a', c.call('a1'));
    void limiter.run('b', c.call('b1')); // waits
    max = 2; // room now – but b1 is waiting, so the newcomer queues behind it
    void limiter.run('c', c.call('c1'));
    await flush();
    expect(c.started).toEqual(['a1']);
    await c.finish('a1');
    expect(c.started).toEqual(['a1', 'b1', 'c1']);
  });
});

describe('job timeout (abort)', () => {
  it('a waiting call whose job times out rejects, leaves the queue, and never runs', async () => {
    const limiter = createApiLimiter(() => 1);
    const c = calls();
    void limiter.run('a', c.call('a1'));
    const job = new AbortController();
    const waiting = limiter.run('b', c.call('b1'), job.signal);
    void limiter.run('c', c.call('c1'));
    job.abort(new Error('job timed out'));
    await expect(waiting).rejects.toThrow('job timed out');
    expect(limiter.stats()).toEqual({ active: 1, waiting: 1, jobsWaiting: 1 });
    await c.drain();
    expect(c.started).toEqual(['a1', 'c1']);
  });

  it('only that call leaves: the job\'s other waiting calls stay in line', async () => {
    const limiter = createApiLimiter(() => 1);
    const c = calls();
    void limiter.run('a', c.call('a1'));
    const one = new AbortController();
    const aborted = limiter.run('b', c.call('b1'), one.signal);
    void limiter.run('b', c.call('b2'));
    one.abort();
    await aborted.catch(() => {});
    await c.drain();
    expect(c.started).toEqual(['a1', 'b2']);
  });

  it('already aborted: rejects at once without running', async () => {
    const limiter = createApiLimiter(() => 4);
    const c = calls();
    const job = new AbortController();
    job.abort();
    await expect(limiter.run('a', c.call('a1'), job.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(c.started).toEqual([]);
  });

  it('an abort after the call started does not stop it here (the API client watches the signal)', async () => {
    const limiter = createApiLimiter(() => 1);
    const c = calls();
    const job = new AbortController();
    const running = limiter.run('a', c.call('a1'), job.signal);
    job.abort();
    await c.finish('a1');
    expect(await running).toBe('a1');
  });

  it('a call that waited, then started, is not affected by a later abort', async () => {
    const limiter = createApiLimiter(() => 1);
    const c = calls();
    void limiter.run('a', c.call('a1'));
    const job = new AbortController();
    const second = limiter.run('b', c.call('b1'), job.signal);
    await c.finish('a1');
    job.abort();
    await c.finish('b1');
    expect(await second).toBe('b1');
  });
});
