import { Select as SelectPrimitive } from "@base-ui-components/react/select";
import { Check, ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

/**
 * The shadcn Select, on Base UI (ADR-0008). Unlike the Button (which Base UI has
 * no primitive for, so it is a `useRender` recipe over a native `<button>`),
 * Base UI DOES ship a full Select primitive — Root/Trigger/Value/Icon plus a
 * portalled Positioner/Popup and List/Item parts. So the shadcn recipe here is a
 * thin re-skin: each part re-exports the matching Base UI part with the shadcn
 * classes flowed through {@link cn}, exactly like button.tsx flows its cva
 * output through `cn`. No behavior is added — Base UI owns open/close, keyboard
 * nav, selection, and portalling; this file only supplies the token-themed
 * classes.
 *
 * All colors reference the dark-theme design tokens (bg-popover, border,
 * text-muted-foreground, ring, accent, …) from `src/index.css`, so the dropdown
 * is themed by the token layer, not by hard-coded values — matching the Button.
 */

/** The Select root: groups all parts, owns value/onValueChange. Re-exported as-is. */
const Select = SelectPrimitive.Root;

/** The selected item's text label, rendered inside the trigger. */
const SelectValue = SelectPrimitive.Value;

/**
 * The trigger button that opens the popup. Mirrors the shadcn trigger shape — a
 * full-width bordered control showing the selected value and a chevron — styled
 * against the input/ring/muted tokens. The chevron lives in Base UI's `Icon`
 * part so it rotates with the popup's open state if desired.
 */
function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="flex shrink-0 text-muted-foreground [&_svg]:size-4">
        <ChevronDown aria-hidden />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/**
 * The popup surface. Wraps Base UI's Portal → Positioner → Popup so the menu
 * escapes the sidebar's `overflow` and anchors to the trigger. `sideOffset`
 * gives the shadcn 4px gap; `--available-height` bounds it so a long registry
 * scrolls rather than overflowing the viewport, and `--anchor-width` matches the
 * trigger width like the shadcn default.
 */
function SelectContent({
  className,
  children,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof SelectPrimitive.Popup> & {
  sideOffset?: number;
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner sideOffset={sideOffset} className="z-50">
        <SelectPrimitive.Popup
          className={cn(
            "max-h-[var(--available-height)] min-w-[var(--anchor-width)] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none",
            className,
          )}
          {...props}
        >
          {children}
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

/**
 * One option row. Mirrors the shadcn item — a padded, rounded row that
 * highlights on hover/keyboard focus (Base UI's `data-highlighted`) and shows a
 * check on the selected row (Base UI's `ItemIndicator`).
 */
function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center [&_svg]:size-4">
        <Check aria-hidden />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
