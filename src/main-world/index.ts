// MAIN-world entry script (built to main-world/hooks.js, injected at
// document_start in the page's own world – see README "How uploads are
// detected"). Installs the hand-off hooks and connects them to the channel.

import { createMainWorldChannel } from './channel.ts';
import { installHooks } from './handoff-hooks.ts';

const channel = createMainWorldChannel(window);
installHooks(window, (file) => channel.forward(file));
