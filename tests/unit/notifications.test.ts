import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromeNotificationApi, createNotifier, ICON_PATH, siteName, type NotificationApi } from '../../src/background/notifications.ts';
import type { ShowResult } from '../../src/shared/messages.ts';
import { createLogger, type LogLevel } from '../../src/shared/safe-logger.ts';
import { createChromeFake, FAKE_EXTENSION_ID, type ChromeFake } from '../helpers/chrome-fake.ts';

const BATCH_ID = '6a2b3c4d-5555-4666-8777-988899990000';
const result = (n: number) => ({
  scanId: `5f1c2a3e-1111-4222-8333-94445555666${n}`,
  batchId: BATCH_ID,
  fileName: `file-${n}.pdf`,
  status: 'clean' as const,
  findings: [],
  errors: [],
});
const SHOW: ShowResult = { type: 'SHOW_RESULT', batchId: BATCH_ID, origin: 'https://mail.google.com', results: [result(1), result(2)] };

let fake: ChromeFake;
beforeEach(() => {
  fake = createChromeFake();
  fake.install();
});
afterEach(() => fake.uninstall());

function setup(api: NotificationApi = chromeNotificationApi()) {
  const lines: { level: LogLevel; line: string }[] = [];
  const notifier = createNotifier(api, createLogger('sw', { sink: (level, line) => void lines.push({ level, line }) }));
  return { notifier, lines };
}

describe('siteName', () => {
  it.each([
    ['https://mail.google.com', 'mail.google.com'],
    ['http://localhost:8787', 'localhost:8787'],
    ['https://xn--e1afmkfd.xn--p1ai', 'xn--e1afmkfd.xn--p1ai'],
    ['not an origin', 'not an origin'],
  ])('%s → %s', (origin, expected) => {
    expect(siteName(origin)).toBe(expected);
  });
});

describe('skeleton batch notification', () => {
  it('shows one notification with the texts from _locales', async () => {
    await setup().notifier.showBatchReceived(SHOW);
    expect([...fake.notifications.entries()]).toEqual([
      [
        `batch-${BATCH_ID}`,
        {
          type: 'basic',
          iconUrl: `chrome-extension://${FAKE_EXTENSION_ID}/${ICON_PATH}`,
          title: 'PDF Secret Scanner (preview)',
          message: 'Received 2 file(s) from mail.google.com. Results are not shown in notifications yet.',
        },
      ],
    ]);
  });

  it('uses a full extension URL for the icon (a relative one fails in the service worker)', () => {
    expect(chromeNotificationApi().iconUrl).toBe(`chrome-extension://${FAKE_EXTENSION_ID}/icons/icon-128.png`);
  });

  it('the same batch twice replaces its notification instead of adding one', async () => {
    const { notifier } = setup();
    await notifier.showBatchReceived(SHOW);
    await notifier.showBatchReceived(SHOW);
    expect(fake.notifications.size).toBe(1);
  });

  it('logs and does not throw when Chrome refuses the notification', async () => {
    const { notifier, lines } = setup({ ...chromeNotificationApi(), iconUrl: ICON_PATH }); // the step-2 bug
    await expect(notifier.showBatchReceived(SHOW)).resolves.toBeUndefined();
    expect(fake.notifications.size).toBe(0);
    expect(lines.map((l) => [l.level, l.line])).toEqual([['error', '[PSS:sw] notification could not be shown']]);
  });

  it('never puts file names into the notification (skeleton)', async () => {
    await setup().notifier.showBatchReceived(SHOW);
    expect(JSON.stringify([...fake.notifications.values()])).not.toContain('file-1.pdf');
  });
});
