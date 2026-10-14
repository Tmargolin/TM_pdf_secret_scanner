import { describe, expect, it } from 'vitest';
import { logNotificationPermission, notificationsBlocked } from '../../src/shared/notification-permission.ts';
import { createLogger, type LogLevel } from '../../src/shared/safe-logger.ts';

function capture(dev = true) {
  const lines: { level: LogLevel; line: string }[] = [];
  return { lines, log: createLogger('sw', { dev, sink: (level, line) => void lines.push({ level, line }) }) };
}

describe('notificationsBlocked', () => {
  it.each([
    ['granted', false],
    ['denied', true],
    ['', true], // anything unexpected counts as blocked: better a needless warning than a silent miss
  ])('%j → %s', (level, blocked) => {
    expect(notificationsBlocked(level)).toBe(blocked);
  });
});

describe('logNotificationPermission', () => {
  it('warns while notifications are blocked', () => {
    const { lines, log } = capture();
    logNotificationPermission('denied', log);
    expect(lines).toEqual([{ level: 'warn', line: '[PSS:sw] notifications are blocked in Chrome – alerts will not be shown' }]);
  });

  it('only notes it in dev builds while they are allowed', () => {
    const dev = capture(true);
    logNotificationPermission('granted', dev.log);
    expect(dev.lines).toEqual([{ level: 'debug', line: '[PSS:sw] notifications are allowed' }]);
    const release = capture(false);
    logNotificationPermission('granted', release.log);
    expect(release.lines).toEqual([]);
  });
});
