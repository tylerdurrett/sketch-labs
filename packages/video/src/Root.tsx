import { Composition } from 'remotion'

import { defaultParams, registry } from '@harness/core'

import {
  CIRCLES_ID,
  CirclesComposition,
  DEFAULT_FPS,
  DEFAULT_SEED,
  calculateCirclesMetadata,
  type CirclesProps,
} from './CirclesComposition'

/**
 * The Remotion root — the single component `registerRoot` mounts. It registers
 * every Composition the CLI can render; today just circles.
 *
 * The circles Composition's dimensions and `durationInFrames` are left to
 * {@link calculateCirclesMetadata} (fps default {@link DEFAULT_FPS}), which
 * derives the frame count from the Sketch's `time.duration` and defaults the
 * output size to the Sketch's coordinate space. `defaultProps` seeds the input
 * props with `defaultParams(sketch.schema)` and the fixed {@link DEFAULT_SEED};
 * a render overrides any of them via `--props`.
 *
 * `width`/`height` default to 0 in `defaultProps` — a sentinel meaning "use the
 * Sketch's coordinate space", which {@link calculateCirclesMetadata} resolves
 * from the probe `generate`. Passing a non-zero `width`/`height` per render wins.
 */
export function RemotionRoot() {
  const sketch = registry.get(CIRCLES_ID)

  const defaultProps: CirclesProps = {
    fps: DEFAULT_FPS,
    width: 0,
    height: 0,
    params: defaultParams(sketch.schema),
    seed: DEFAULT_SEED,
  }

  return (
    <Composition
      id="Circles"
      component={CirclesComposition}
      calculateMetadata={calculateCirclesMetadata}
      defaultProps={defaultProps}
    />
  )
}
