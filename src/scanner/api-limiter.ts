// Global limit on API calls in flight, shared by every job of every tab
// (DESIGN.md §4.1 "Scheduling", docs/agents/scanner.md).
//
//   at most max() calls at once (maxConcurrency, read at every decision)
//   waiting calls are taken ROUND-ROBIN ACROSS JOBS: one from each job in
//   turn, FIFO within a job – so a 300-page PDF does not starve a 1-page PDF
//   that arrives a moment later (it waits for at most one call per other job)
//
// A waiting call whose signal aborts (its job timed out) leaves the queue and
// rejects with the signal's reason; a running call is not interrupted here –
// the API client watches the same signal.

export interface ApiLimiter {
  /** Runs `task` for `jobKey` when a slot is free and it is that job's turn. */
  run<T>(jobKey: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  stats(): { active: number; waiting: number; jobsWaiting: number };
}

interface Waiter {
  start(): void;
}

export function createApiLimiter(max: () => number): ApiLimiter {
  let active = 0;
  /** Jobs with waiting calls, in turn order; the first one goes next. */
  const turn: string[] = [];
  const waiting = new Map<string, Waiter[]>();

  const waitingCount = () => {
    let count = 0;
    for (const list of waiting.values()) count += list.length;
    return count;
  };

  const next = (): void => {
    while (active < max() && turn.length > 0) {
      const job = turn.shift() as string;
      const list = waiting.get(job) as Waiter[];
      const waiter = list.shift() as Waiter;
      if (list.length > 0) turn.push(job); // back of the line
      else waiting.delete(job);
      waiter.start();
    }
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

  /**
   * Takes a waiting call out of the queue (its job aborted). It is always
   * there: a waiter leaves the queue only by starting – which first removes
   * its abort listener – or through this function, which runs at most once.
   */
  const remove = (job: string, waiter: Waiter) => {
    const list = waiting.get(job) as Waiter[];
    list.splice(list.indexOf(waiter), 1);
    if (list.length === 0) {
      waiting.delete(job);
      turn.splice(turn.indexOf(job), 1);
    }
  };

  return {
    run<T>(jobKey: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (active < max() && turn.length === 0) return execute(task);
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          remove(jobKey, waiter);
          reject(signal?.reason);
        };
        const waiter: Waiter = {
          start() {
            signal?.removeEventListener('abort', onAbort);
            execute(task).then(resolve, reject);
          },
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const list = waiting.get(jobKey);
        if (list) list.push(waiter);
        else {
          waiting.set(jobKey, [waiter]);
          turn.push(jobKey);
        }
      });
    },
    stats: () => ({ active, waiting: waitingCount(), jobsWaiting: turn.length }),
  };
}
