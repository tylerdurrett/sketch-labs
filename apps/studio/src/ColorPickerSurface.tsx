import { useLayoutEffect, useRef } from "react";
import { HexColorPicker } from "react-colorful";

import { hexToHsv } from "./colorValue";

export interface ColorPickerSurfaceProps {
  /** Param key used to distinguish this picker's accessible control names. */
  paramKey: string;
  /** Current canonical `#rrggbb` color. */
  color: string;
  /** Receives every local pointer or keyboard preview. */
  onChange: (color: string) => void;
  /** Receives the final color when a pointer or keyboard gesture settles. */
  onChangeEnd: (color: string) => void;
}

/**
 * The Studio-owned interaction surface around react-colorful's public picker.
 *
 * react-colorful renders the saturation/value and hue controls internally and
 * does not expose part props. Its saturation slider is also missing numeric
 * ARIA state. The layout effect repairs the actual focusable descendants after
 * every controlled update, keeping their names and state synchronized without
 * relying on private React components or reimplementing gesture behavior.
 */
export function ColorPickerSurface({
  paramKey,
  color,
  onChange,
  onChangeEnd,
}: ColorPickerSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const hsv = hexToHsv(color);
    if (!surface || hsv === null) return;

    const roundedSaturation = Math.round(hsv.s);
    const roundedValue = Math.round(hsv.v);
    const roundedHue = Math.round(hsv.h);

    const applyAccessibleState = () => {
      const saturation = surface.querySelector<HTMLElement>(
        ".react-colorful__saturation .react-colorful__interactive",
      );
      const hue = surface.querySelector<HTMLElement>(
        ".react-colorful__hue .react-colorful__interactive",
      );
      if (!saturation || !hue) return;

      setAttribute(
        saturation,
        "aria-label",
        `${paramKey} saturation and value`,
      );
      setAttribute(saturation, "aria-valuemin", "0");
      setAttribute(saturation, "aria-valuemax", "100");
      setAttribute(saturation, "aria-valuenow", String(roundedSaturation));
      setAttribute(
        saturation,
        "aria-valuetext",
        `Saturation ${roundedSaturation}%, value ${roundedValue}%`,
      );

      setAttribute(hue, "aria-label", `${paramKey} hue`);
      setAttribute(hue, "aria-valuemin", "0");
      setAttribute(hue, "aria-valuemax", "360");
      setAttribute(hue, "aria-valuenow", String(roundedHue));
      setAttribute(hue, "aria-valuetext", `${roundedHue} degrees`);
    };

    applyAccessibleState();

    // react-colorful synchronizes an externally controlled color in a passive
    // effect and that child render restores its generic ARIA attributes after
    // this parent's layout effect. Observe just those attribute writes and
    // reapply the owned state; guarded writes prevent an observer loop.
    const observer = new MutationObserver(applyAccessibleState);
    observer.observe(surface, {
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-label",
        "aria-valuemin",
        "aria-valuemax",
        "aria-valuenow",
        "aria-valuetext",
      ],
    });
    return () => observer.disconnect();
  }, [color, paramKey]);

  return (
    <div ref={surfaceRef} className="color-picker-surface">
      <HexColorPicker
        color={color}
        onChange={onChange}
        onChangeEnd={onChangeEnd}
      />
    </div>
  );
}

function setAttribute(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}
