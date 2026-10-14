// Content script, isolated world (DESIGN.md §3, docs/agents/content-script.md).
// Registered by the service worker for allow-listed sites (script-registry.ts).
// For now it only announces itself (dev builds); sending files to the
// offscreen document arrives in step 2.7.

import { createLogger } from '../shared/safe-logger.ts';

const log = createLogger('content', { dev: __DEV__ });
log.debug('content script loaded');
