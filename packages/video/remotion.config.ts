import { Config } from '@remotion/cli/config'

/**
 * Remotion CLI configuration for the manual `npx remotion render` step.
 *
 * The `.mp4` is a MANUAL, human-run artifact (never CI-gated — see README): CI's
 * gate for this package is the headless typecheck + test suite, not a video
 * render. This file only sets the codec so the manual command needs no extra
 * flags; the compositions themselves are registered in `src/index.ts` (the
 * Remotion entry).
 */
Config.setVideoImageFormat('png')
Config.setCodec('h264')
