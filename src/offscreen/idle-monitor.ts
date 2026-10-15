// Idle monitor – decides when the offscreen document is idle (DESIGN.md §2
// "Offscreen lifecycle", D42, docs/agents/offscreen.md).
//
//   work begins (a scan port opens)       → idle timer stopped
//   last work ends                        → idle timer started (offscreenIdleTimeoutSec; 0 = never)
//   timer fires                           → closing: report OFFSCREEN_IDLE, new batches are rejected
//   still open CLOSE_GRACE_MS later       → safety valve: leave closing, start the idle timer again
//
// The service worker closes the document. Entering "closing" and reporting
// happen in the same task, so no batch can be accepted in between.

import type { Logger } from '../shared/safe-logger.ts';
import type { BatchActivity } from './batch-receiver.ts';

/** How long a closing document waits for the service worker before it resumes work. */
export const CLOSE_GRACE_MS = 5_000;

export interface IdleMonitorDeps {
  /** offscreenIdleTimeoutSec from the settings; null while the settings have not arrived. */
  timeoutSec(): number | null;
  /** Sends OFFSCREEN_IDLE to the service worker (fire and forget). */
  reportIdle(): void;
  log: Logger;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface IdleMonitor extends BatchActivity {
  /** Starts the idle timer again with the current setting (settings arrived or changed). */
  refresh(): void;
  /** Work in progress right now. */
  active(): number;
}

export function createIdleMonitor(deps: IdleMonitorDeps): IdleMonitor {
  const { log } = deps;
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let active = 0;
  let closing = false;
  let timer: unknown = null;

  const stopTimer = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  /** Safety valve: the service worker did not close us – carry on as before. */
  const reopen = (): void => {
    timer = null;
    closing = false;
    log.warn('not closed after reporting idle – resuming');
    arm();
  };

  const onIdle = (): void => {
    closing = true;
    log.info('idle: asking the service worker to close the document');
    deps.reportIdle();
    timer = setTimer(reopen, CLOSE_GRACE_MS);
  };

  /** (Re)starts the idle timer if nothing is running, the document is not closing and a timeout is set. */
  const arm = (): void => {
    if (closing) return; // the safety-valve timer is running
    stopTimer();
    const seconds = deps.timeoutSec();
    if (active > 0 || seconds === null || seconds === 0) return;
    timer = setTimer(onIdle, seconds * 1_000);
  };

  return {
    begin() {
      active++;
      arm(); // stops the idle timer (active > 0)
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        active--;
        arm();
      };
    },
    isClosing: () => closing,
    refresh: arm,
    active: () => active,
  };
}
