// Groups files obtained by the page into batches (DESIGN.md §3, content
// script step 3): everything that arrives within `windowMs` of the first file
// is one batch – a multi-select, a multi-file drop, a folder – and gets one
// notification. A full batch is sent at once.

export interface BatcherDeps<T> {
  windowMs: number;
  maxItems: number;
  onBatch(items: T[]): void;
  /** Injected so tests can control time (defaults: setTimeout / clearTimeout). */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Batcher<T> {
  add(item: T): void;
}

export const BATCH_WINDOW_MS = 300;

export function createBatcher<T>(deps: BatcherDeps<T>): Batcher<T> {
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let items: T[] = [];
  let timer: unknown = null;

  const flush = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const batch = items;
    items = [];
    if (batch.length > 0) deps.onBatch(batch);
  };

  return {
    add(item) {
      items.push(item);
      if (items.length >= deps.maxItems) flush();
      else if (timer === null) timer = setTimer(flush, deps.windowMs);
    },
  };
}
