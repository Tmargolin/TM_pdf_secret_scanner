// Offscreen document – owns all scan work (DESIGN.md §2, docs/agents/offscreen.md).
// Walking skeleton so far: settings handshake. Scan ports: 2.7.

import { isFromExtensionContext } from '../shared/messages.ts';
import { createLogger } from '../shared/safe-logger.ts';
import { createSettingsClient } from './settings-client.ts';

const log = createLogger('offscreen', { dev: __DEV__ });

const settings = createSettingsClient({
  requestSettings: () => chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }),
  dev: __DEV__,
  log,
});

chrome.runtime.onMessage.addListener((raw, sender) => {
  if (isFromExtensionContext(sender, chrome.runtime.id)) settings.accept(raw);
  return false; // never replies
});

log.info('offscreen document loaded');
void settings.start();
