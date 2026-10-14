// Offscreen document – owns all scan work (DESIGN.md §2, docs/agents/offscreen.md).
// Walking skeleton: it only announces that it loaded. Settings handshake: 2.5,
// scan ports: 2.7.

import { createLogger } from '../shared/safe-logger.ts';

const log = createLogger('offscreen', { dev: __DEV__ });
log.info('offscreen document loaded');
