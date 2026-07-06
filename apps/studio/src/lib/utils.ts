import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The shadcn `cn` class-name helper (ADR-0008): `clsx` resolves conditional /
 * array / object class inputs into one string, then `tailwind-merge` collapses
 * conflicting Tailwind utilities so the last one wins (e.g. `px-2 px-4` → `px-4`).
 * Every shadcn component composes its variant classes through this.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
