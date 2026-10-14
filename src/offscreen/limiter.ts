// Concurrency limiter – at most max() tasks run at once, the rest wait in
// FIFO order (used for maxParallelExtractions, docs/agents/offscreen.md).
// max() is read at every decision, so a changed setting applies to the next
// start. A waiting task whose signal aborts (job timeout) leaves the queue.

export interface Limiter {
  /** Runs `task` when a slot is free; rejects with `signal.reason` if aborted while waiting. */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  stats(): { active: number; waiting: number };
}

interface Waiter {
  start(): void;
}

export function createLimiter(max: () => number): Limiter {
  let active = 0;
  const waiting: Waiter[] = [];

  const next = (): void => {
    while (waiting.length > 0 && active < max()) (waiting.shift() as Waiter).start();
  };

  const execute = async <T>(task: () => Promise<T>): Promise<T> => {
    active++;
    try {
      return await task();
    } finally {
      active--;
      next();
    }
  };

  return {
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (active < max() && waiting.length === 0) return execute(task);
      return new Promise<T>((resolve, reject) => {
        const waiter: Waiter = {
          start() {
            signal?.removeEventListener('abort', onAbort);
            execute(task).then(resolve, reject);
          },
        };
        const onAbort = () => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiting.push(waiter);
      });
    },
    stats: () => ({ active, waiting: waiting.length }),
  };
}
