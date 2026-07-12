import { Popover as PopoverPrimitive } from "@base-ui-components/react/popover";
import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

/**
 * The shadcn Popover recipe, backed by Base UI (ADR-0008). Base UI owns
 * anchoring, focus management, dismissal, and portalling; this module only
 * applies the Studio's token-based surface styles.
 */
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverClose = PopoverPrimitive.Close;

function PopoverContent({
  className,
  children,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Popup> & {
  sideOffset?: number;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner sideOffset={sideOffset} className="z-50">
        <PopoverPrimitive.Popup
          className={cn(
            "w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none",
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverClose, PopoverContent, PopoverTrigger };
