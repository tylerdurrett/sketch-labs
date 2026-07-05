import { mergeProps } from "@base-ui-components/react/merge-props";
import { useRender } from "@base-ui-components/react/use-render";
import { type VariantProps, cva } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

/**
 * The shadcn Button, on Base UI (ADR-0008). Base UI ships no Button primitive, so
 * the shadcn recipe is a native `<button>` whose variants come from
 * `class-variance-authority` and whose classes flow through {@link cn}. The
 * `render` prop is Base UI's composition escape hatch — `useRender` merges the
 * variant props onto either the default `<button>` or a caller-supplied element,
 * giving `asChild`-style polymorphism without a wrapper.
 *
 * All colors reference the dark-theme design tokens (bg-primary, text-*,
 * border, ring, …) defined in `src/index.css`, so the button is themed by the
 * token layer, not by hard-coded values.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 shrink-0 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md gap-1.5 px-3",
        lg: "h-10 rounded-md px-6",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface ButtonProps
  extends ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  /** Base UI composition: replace the default `<button>` with another element. */
  render?: useRender.RenderProp;
}

function Button({
  className,
  variant,
  size,
  render,
  ...props
}: ButtonProps) {
  return useRender({
    render: render ?? <button />,
    props: mergeProps<"button">(
      { className: cn(buttonVariants({ variant, size, className })) },
      props,
    ),
  });
}

export { Button, buttonVariants };
