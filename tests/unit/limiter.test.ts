// Unit tests of the concurrency limiter (src/offscreen/limiter.ts), used for
// maxParallelExtractions. Tasks are promises the test resolves by hand.
import { describe, expect, it } from 'vitest';
import { createLimiter } from '../../src/offscreen/limiter.ts';

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A task the test finishes by hand; records when it started. */
function tasks() {
  const started: string[] = [];
  const finishers = new Map<string, { resolve(value: string): void; reject(error: unknown): void }>();
  const task = (name: string) => () => {
    started.push(name);
    return new Promise<string>((resolve, reject) => finishers.set(name, { resolve, reject }));
  };
  const finish = (name: string) => finishers.get(name)?.resolve(name);
  const fail = (name: string, error: unknown) => finishers.get(name)?.reject(error);
  return { started, task, finish, fail };
}

describe('createLimiter', () => {
  it('runs at most max() tasks at once; the next starts when one ends', async () => {
    const limiter = createLimiter(() => 2);
    const t = tasks();
    const results = ['a', 'b', 'c', 'd'].map((n) => limiter.run(t.task(n)));
    await flush();
    expect(t.started).toEqual(['a', 'b']);
    expect(limiter.stats()).toEqual({ active: 2, waiting: 2 });
    t.finish('b');
    await flush();
    expect(t.started).toEqual(['a', 'b', 'c']);
    t.finish('a');
    t.finish('c');
    await flush();
    t.finish('d');
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd']);
    expect(limiter.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it('waiting tasks start in FIFO order; a newcomer does not jump the queue', async () => {
    let max = 1;
    const limiter = createLimiter(() => max);
    const t = tasks();
    void limiter.run(t.task('a'));
    void limiter.run(t.task('b'));
    void limiter.run(t.task('c'));
    max = 3; // more room now – but b and c wait for the next decision …
    void limiter.run(t.task('d')); // … and d must not overtake them
    await flush();
    expect(t.started).toEqual(['a']);
    t.finish('a');
    await flush();
    expect(t.started).toEqual(['a', 'b', 'c', 'd']);
  });

  it('max() is read at every decision: lowering it holds back the next start', async () => {
    let max = 2;
    const limiter = createLimiter(() => max);
    const t = tasks();
    ['a', 'b', 'c'].forEach((n) => void limiter.run(t.task(n)));
    await flush();
    max = 1;
    t.finish('a');
    await flush();
    expect(t.started).toEqual(['a', 'b']); // b still running, limit 1: c waits
    t.finish('b');
    await flush();
    expect(t.started).toEqual(['a', 'b', 'c']);
  });

  it('a task that fails passes its error on and frees its slot', async () => {
    const limiter = createLimiter(() => 1);
    const t = tasks();
    const first = limiter.run(t.task('a'));
    void limiter.run(t.task('b'));
    t.fail('a', new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await flush();
    expect(t.started).toEqual(['a', 'b']);
  });

  it('a task that throws at once is a rejection, not an exception, and frees its slot', async () => {
    const limiter = createLimiter(() => 1);
    const t = tasks();
    const bad = limiter.run(() => {
      throw new Error('sync boom');
    });
    await expect(bad).rejects.toThrow('sync boom');
    void limiter.run(t.task('next'));
    expect(t.started).toEqual(['next']);
  });

  it('aborted while waiting: rejects with the reason, leaves the queue, never runs', async () => {
    const limiter = createLimiter(() => 1);
    const t = tasks();
    void limiter.run(t.task('a'));
    const controller = new AbortController();
    const waiting = limiter.run(t.task('b'), controller.signal);
    void limiter.run(t.task('c'));
    controller.abort(new Error('job timed out'));
    await expect(waiting).rejects.toThrow('job timed out');
    expect(limiter.stats()).toEqual({ active: 1, waiting: 1 });
    t.finish('a');
    await flush();
    expect(t.started).toEqual(['a', 'c']);
  });

  it('already aborted: rejects at once without running', async () => {
    const limiter = createLimiter(() => 1);
    const t = tasks();
    const controller = new AbortController();
    controller.abort();
    await expect(limiter.run(t.task('a'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.started).toEqual([]);
    expect(limiter.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it('an abort after the task started does not stop it (the task itself watches the signal)', async () => {
    const limiter = createLimiter(() => 1);
    const t = tasks();
    const controller = new AbortController();
    const running = limiter.run(t.task('a'), controller.signal);
    controller.abort();
    t.finish('a');
    expect(await running).toBe('a');
  });

  it('a task that waited and then started is not affected by a later abort', async () => {
    const limiter = createLimiter(() => 1);
    const t = tasks();
    void limiter.run(t.task('a'));
    const controller = new AbortController();
    const second = limiter.run(t.task('b'), controller.signal);
    t.finish('a');
    await flush();
    controller.abort();
    t.finish('b');
    expect(await second).toBe('b');
  });
});
