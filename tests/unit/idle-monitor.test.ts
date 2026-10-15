// Unit tests of the idle monitor (src/offscreen/idle-monitor.ts, D42). Timers
// are injected: the test fires them by hand, so time never really passes.
import { describe, expect, it } from 'vitest';
import { CLOSE_GRACE_MS, createIdleMonitor } from '../../src/offscreen/idle-monitor.ts';
import { createLogger, type LogLevel } from '../../src/shared/safe-logger.ts';

/** Manual timers: pending ones can be listed and fired. */
function manualTimers() {
  let next = 1;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  return {
    setTimer: (callback: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { callback, ms });
      return id;
    },
    clearTimer: (handle: unknown) => void pending.delete(handle as number),
    /** Delays of the timers still pending. */
    delays: () => [...pending.values()].map((t) => t.ms),
    /** Fires the only pending timer (fails if there is not exactly one). */
    fire() {
      expect(pending.size).toBe(1);
      const [id, timer] = [...pending.entries()][0] as [number, { callback: () => void }];
      pending.delete(id);
      timer.callback();
    },
  };
}

function setup(timeout: number | null = 60) {
  const timers = manualTimers();
  const lines: { level: LogLevel; line: string }[] = [];
  let reports = 0;
  let timeoutSec = timeout;
  const monitor = createIdleMonitor({
    timeoutSec: () => timeoutSec,
    reportIdle: () => void reports++,
    log: createLogger('offscreen', { dev: true, sink: (level, line) => void lines.push({ level, line }) }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return {
    monitor,
    timers,
    lines,
    reports: () => reports,
    setTimeout: (s: number | null) => {
      timeoutSec = s;
    },
  };
}

describe('the idle timer', () => {
  it('does not run before the settings arrive', () => {
    const t = setup(null);
    t.monitor.refresh();
    expect(t.timers.delays()).toEqual([]);
  });

  it('starts with offscreenIdleTimeoutSec once the settings arrive', () => {
    const t = setup();
    t.monitor.refresh();
    expect(t.timers.delays()).toEqual([60_000]);
  });

  it('0 = never close: no timer, even after work ends', () => {
    const t = setup(0);
    t.monitor.refresh();
    t.monitor.begin()();
    expect(t.timers.delays()).toEqual([]);
  });

  it('a changed timeout replaces the running timer', () => {
    const t = setup();
    t.monitor.refresh();
    t.setTimeout(600);
    t.monitor.refresh();
    expect(t.timers.delays()).toEqual([600_000]);
    t.setTimeout(0);
    t.monitor.refresh();
    expect(t.timers.delays()).toEqual([]);
  });

  it('stops while there is work and starts again when the last work ends', () => {
    const t = setup();
    t.monitor.refresh();
    const endFirst = t.monitor.begin();
    const endSecond = t.monitor.begin();
    expect(t.timers.delays()).toEqual([]);
    expect(t.monitor.active()).toBe(2);
    endFirst();
    expect(t.timers.delays()).toEqual([]); // one batch still running
    endSecond();
    expect(t.timers.delays()).toEqual([60_000]);
    expect(t.monitor.active()).toBe(0);
  });

  it('ending the same work twice counts once', () => {
    const t = setup();
    const endFirst = t.monitor.begin();
    t.monitor.begin();
    endFirst();
    endFirst();
    expect(t.monitor.active()).toBe(1);
    expect(t.timers.delays()).toEqual([]);
  });

  it('settings changes during work do not start the timer', () => {
    const t = setup();
    t.monitor.begin();
    t.monitor.refresh();
    expect(t.timers.delays()).toEqual([]);
  });
});

describe('closing', () => {
  it('when the timer fires: closing, OFFSCREEN_IDLE reported once, safety valve armed', () => {
    const t = setup();
    t.monitor.refresh();
    expect(t.monitor.isClosing()).toBe(false);
    t.timers.fire();
    expect(t.monitor.isClosing()).toBe(true);
    expect(t.reports()).toBe(1);
    expect(t.timers.delays()).toEqual([CLOSE_GRACE_MS]);
    expect(t.lines).toContainEqual({ level: 'info', line: '[PSS:offscreen] idle: asking the service worker to close the document' });
  });

  it('settings changes while closing keep the safety valve', () => {
    const t = setup();
    t.monitor.refresh();
    t.timers.fire();
    t.setTimeout(30);
    t.monitor.refresh();
    expect(t.timers.delays()).toEqual([CLOSE_GRACE_MS]);
    expect(t.monitor.isClosing()).toBe(true);
  });

  it('safety valve: still open after CLOSE_GRACE_MS → resumes and starts the idle timer again', () => {
    const t = setup();
    t.monitor.refresh();
    t.timers.fire(); // idle
    t.timers.fire(); // grace period over, nobody closed us
    expect(t.monitor.isClosing()).toBe(false);
    expect(t.timers.delays()).toEqual([60_000]);
    expect(t.lines).toContainEqual({ level: 'warn', line: '[PSS:offscreen] not closed after reporting idle – resuming' });
    t.timers.fire(); // idle again
    expect(t.reports()).toBe(2);
  });

  it('safety valve with work started meanwhile: resumes without an idle timer', () => {
    const t = setup();
    t.monitor.refresh();
    t.timers.fire();
    t.monitor.begin(); // not done by the receiver while closing; the monitor must still not lose the valve
    expect(t.timers.delays()).toEqual([CLOSE_GRACE_MS]);
    t.timers.fire();
    expect(t.monitor.isClosing()).toBe(false);
    expect(t.timers.delays()).toEqual([]);
  });
});
