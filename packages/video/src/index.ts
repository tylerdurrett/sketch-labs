import { registerRoot } from 'remotion'

import { RemotionRoot } from './Root'

/**
 * The Remotion entry point — `registerRoot` tells the CLI which component holds
 * the Composition registry. `remotion.config.ts` sets render defaults; this file
 * is the `--entry` the `npx remotion render` command loads (see README).
 */
registerRoot(RemotionRoot)
