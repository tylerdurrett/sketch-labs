import { describe, expect, it } from "vitest";

import {
  hexToHsv,
  hexToRgb,
  isCanonicalHexColor,
  parseRgbChannelDraft,
  rgbToHex,
  rgbToHsv,
} from "./colorValue";

describe("canonical hex colors", () => {
  it.each(["#000000", "#09afc3", "#ffffff"])(
    "recognizes %s",
    (value) => {
      expect(isCanonicalHexColor(value)).toBe(true);
    },
  );

  it.each([
    "",
    "000000",
    "#000",
    "#00000000",
    "#ABCDEF",
    "#abcdEF",
    "#gg0000",
    " #abcdef",
    "#abcdef ",
  ])("rejects non-canonical value %j", (value) => {
    expect(isCanonicalHexColor(value)).toBe(false);
    expect(hexToRgb(value)).toBeNull();
    expect(hexToHsv(value)).toBeNull();
  });

  it("parses each channel from canonical hex", () => {
    expect(hexToRgb("#09afc3")).toEqual({ r: 9, g: 175, b: 195 });
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
  });
});

describe("RGB serialization", () => {
  it("pads channels and emits lowercase canonical hex", () => {
    expect(rgbToHex({ r: 0, g: 9, b: 175 })).toBe("#0009af");
  });

  it("rounds fractional channels and clamps values to the channel range", () => {
    expect(rgbToHex({ r: -20, g: 15.5, b: 300 })).toBe("#0010ff");
  });

  it("handles non-finite channels defensively", () => {
    expect(rgbToHex({ r: Number.NaN, g: Number.NEGATIVE_INFINITY, b: Infinity })).toBe(
      "#0000ff",
    );
  });
});

describe("HSV conversion", () => {
  it.each([
    [{ r: 255, g: 0, b: 0 }, { h: 0, s: 100, v: 100 }],
    [{ r: 0, g: 255, b: 0 }, { h: 120, s: 100, v: 100 }],
    [{ r: 0, g: 0, b: 255 }, { h: 240, s: 100, v: 100 }],
    [{ r: 255, g: 255, b: 0 }, { h: 60, s: 100, v: 100 }],
    [{ r: 0, g: 255, b: 255 }, { h: 180, s: 100, v: 100 }],
    [{ r: 255, g: 0, b: 255 }, { h: 300, s: 100, v: 100 }],
  ])("converts RGB primary/secondary %j", (rgb, hsv) => {
    expect(rgbToHsv(rgb)).toEqual(hsv);
  });

  it("uses hue zero and saturation zero for achromatic colors", () => {
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
    expect(rgbToHsv({ r: 128, g: 128, b: 128 })).toEqual({
      h: 0,
      s: 0,
      v: (128 / 255) * 100,
    });
  });

  it("preserves fractional HSV values for callers to format for ARIA", () => {
    const hsv = rgbToHsv({ r: 51, g: 102, b: 153 });

    expect(hsv.h).toBeCloseTo(210);
    expect(hsv.s).toBeCloseTo(66.666_667);
    expect(hsv.v).toBeCloseTo(60);
    expect(hexToHsv("#336699")).toEqual(hsv);
  });

  it("normalizes defensive RGB inputs the same way as hex serialization", () => {
    expect(rgbToHsv({ r: -1, g: 127.6, b: 999 })).toEqual(
      rgbToHsv({ r: 0, g: 128, b: 255 }),
    );
  });
});

describe("RGB channel drafts", () => {
  it.each([
    ["0", 0],
    ["9", 9],
    ["+42", 42],
    ["0042", 42],
    [" 42 ", 42],
    ["\t-5\n", 0],
    ["255", 255],
    ["-1", 0],
    ["999", 255],
  ])("parses and clamps %j", (draft, channel) => {
    expect(parseRgbChannelDraft(draft)).toBe(channel);
  });

  it.each([
    "",
    "+",
    "-",
    "   ",
    "1.5",
    ".5",
    "1e2",
    "0x10",
    "Infinity",
    "-Infinity",
    "NaN",
  ])("rejects invalid draft %j", (draft) => {
    expect(parseRgbChannelDraft(draft)).toBeNull();
  });

  it("rejects an integer draft that overflows to a non-finite number", () => {
    expect(parseRgbChannelDraft("9".repeat(400))).toBeNull();
  });
});
