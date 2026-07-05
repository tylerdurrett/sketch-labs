import { Slider as SliderPrimitive } from "@base-ui-components/react/slider";
import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

/**
 * The shadcn Slider, on Base UI (ADR-0008). Unlike the Button, Base UI DOES ship
 * a Slider primitive, so the shadcn recipe composes its parts —
 * `Root > Control > Track > Indicator + Thumb` — and styles each with the
 * dark-theme design tokens (bg-muted, bg-primary, border, ring, …) from
 * `src/index.css`, flowing every class through {@link cn}. The visible track/
 * range/thumb are pure presentation; the Thumb renders a visually-hidden native
 * `<input type="range">` that carries the real value/min/max/step and keyboard
 * semantics.
 *
 * All of Root's value props — `min`, `max`, `step`, `value`, `onValueChange` —
 * are forwarded straight through, so this is a drop-in full-width slider. Typed
 * to the single-thumb `number` case (the control row never uses a range).
 */
function Slider({
  className,
  ...props
}: ComponentProps<typeof SliderPrimitive.Root<number>>) {
  return (
    <SliderPrimitive.Root
      className={cn(
        "relative flex w-full touch-none items-center select-none",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full items-center py-1.5">
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
          <SliderPrimitive.Indicator className="absolute h-full rounded-full bg-primary" />
          <SliderPrimitive.Thumb className="block size-4 shrink-0 rounded-full border border-primary bg-background shadow-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
