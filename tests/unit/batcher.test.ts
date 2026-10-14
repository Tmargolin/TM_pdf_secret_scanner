import { describe, expect, it } from 'vitest';
import { BATCH_WINDOW_MS, createBatcher } from '../../src/content/batcher.ts';

/** Manual clock: timers run only when the test says so. */
function clock() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextId = 1;
  return {
    setTimer: (run: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
    },
    pending: () => timers.size,
  };
}

function setup(maxItems = 100) {
  const c = clock();
  const batches: string[][] = [];
  const batcher = createBatcher<string>({
    windowMs: BATCH_WINDOW_MS,
    maxItems,
    onBatch: (items) => void batches.push(items),
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  return { batcher, batches, clock: c };
}

describe('createBatcher', () => {
  it('the window is 300 ms', () => {
    expect(BATCH_WINDOW_MS).toBe(300);
  });

  it('files within 300 ms of the first one form one batch', () => {
    const t = setup();
    t.batcher.add('a');
    t.clock.advance(100);
    t.batcher.add('b');
    t.clock.advance(150);
    t.batcher.add('c');
    expect(t.batches).toEqual([]);
    t.clock.advance(50); // 300 ms after the first
    expect(t.batches).toEqual([['a', 'b', 'c']]);
  });

  it('the window starts at the first file and is not extended by later ones', () => {
    const t = setup();
    t.batcher.add('a');
    t.clock.advance(299);
    t.batcher.add('b');
    t.clock.advance(1);
    expect(t.batches).toEqual([['a', 'b']]);
  });

  it('a file after the window starts a new batch', () => {
    const t = setup();
    t.batcher.add('a');
    t.clock.advance(300);
    t.batcher.add('b');
    t.clock.advance(300);
    expect(t.batches).toEqual([['a'], ['b']]);
  });

  it('a full batch is sent at once, without waiting', () => {
    const t = setup(3);
    for (const item of ['a', 'b', 'c']) t.batcher.add(item);
    expect(t.batches).toEqual([['a', 'b', 'c']]);
    expect(t.clock.pending()).toBe(0);
    t.batcher.add('d');
    t.clock.advance(300);
    expect(t.batches).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('nothing added: nothing sent, no timer', () => {
    const t = setup();
    t.clock.advance(1_000);
    expect(t.batches).toEqual([]);
    expect(t.clock.pending()).toBe(0);
  });

  it('works with the real timers by default', async () => {
    const batches: number[][] = [];
    const batcher = createBatcher<number>({ windowMs: 10, maxItems: 100, onBatch: (items) => void batches.push(items) });
    batcher.add(1);
    batcher.add(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(batches).toEqual([[1, 2]]);
  });
});
