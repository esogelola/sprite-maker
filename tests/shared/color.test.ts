/**
 * `shared/color.ts` — spec §6.5 and amendment A7.
 *
 * Every expectation below was captured from the **Wave 3 implementation** (the
 * `relativeLuminance` that shipped in `src/main/lint.ts` at commit `d84f39a`)
 * before A7's relocation moved a line of it. They are full-precision doubles
 * compared with `toBe`, not `toBeCloseTo`: the whole point of A7 is that the
 * formula survives being moved, and a tolerance-based assertion is exactly what
 * would let a quantized or rounded rewrite through.
 *
 * Spec §6.5: "**Do not reimplement it with rounding.** `gameboy` indices 2 and
 * 3 sit at Δ = 0.0794 against the 0.08 threshold — a 0.8% margin, and the canary
 * for any change to this formula."
 */

import { describe, expect, it } from "vitest";

import { LOW_CONTRAST_THRESHOLD, hexToRgb, relativeLuminance } from "@shared/color";
import { listPalettes } from "@shared/palettes";

/** The bundled `gameboy` ramp, with the luminances Wave 3 computed for it. */
const GAMEBOY = [
  { hex: "#0f380f", luminance: 0.029643943821220892 },
  { hex: "#306230", luminance: 0.09577143634649919 },
  { hex: "#8bac0f", luminance: 0.3502850477361253 },
  { hex: "#9bbc0f", luminance: 0.42969491447302005 },
];

describe("LOW_CONTRAST_THRESHOLD (spec §6.5)", () => {
  it("is exactly 0.08", () => {
    expect(LOW_CONTRAST_THRESHOLD).toBe(0.08);
  });
});

describe("relativeLuminance — pinned against the Wave 3 implementation", () => {
  it("is 0 for black and 1 for white", () => {
    // Black is *exactly* zero only because the low end of the transfer function
    // is the linear segment. Drop that branch and black becomes 0.00083.
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBe(1);
  });

  it("weights the channels 0.2126 / 0.7152 / 0.0722, in that order", () => {
    // Also pins channel *order*: swapping the red and blue slices of the hex
    // string leaves every other assertion in this file green.
    expect(relativeLuminance("#ff0000")).toBe(0.2126);
    expect(relativeLuminance("#00ff00")).toBe(0.7152);
    expect(relativeLuminance("#0000ff")).toBe(0.0722);
  });

  it("uses the linear segment below the 0.04045 knee", () => {
    // Byte 10 (`0x0a` → 0.0392) is the last channel value on the linear
    // segment; byte 11 (0.0431) is the first on the power segment. At byte 1 the
    // two branches differ by more than 3×, which is what makes this the
    // assertion that kills a one-branch rewrite.
    expect(relativeLuminance("#010101")).toBe(0.0003035269835488375);
    expect(relativeLuminance("#0a0a0a")).toBe(0.003035269835488375);
    expect(relativeLuminance("#0b0b0b")).toBe(0.0033465357638991604);
  });

  it("reproduces the gameboy ramp to the last bit", () => {
    for (const { hex, luminance } of GAMEBOY) {
      expect(relativeLuminance(hex)).toBe(luminance);
    }
  });

  it("reproduces pico-8 entries that Wave 3's low-contrast pairs depend on", () => {
    expect(relativeLuminance("#1d2b53")).toBe(0.026134979510889805);
    expect(relativeLuminance("#fff1e8")).toBe(0.8999678912578971);
    expect(relativeLuminance("#00e436")).toBe(0.5575314688595807);
  });

  it("keeps the gameboy 2↔3 canary under the threshold by 0.8%", () => {
    // The single most valuable number in this file. Any rounding, quantization
    // or cheap perceived-brightness substitution pushes this over 0.08 and
    // silently deletes a real `low-contrast` warning.
    const delta = Math.abs(GAMEBOY[3].luminance - GAMEBOY[2].luminance);
    expect(
      Math.abs(relativeLuminance("#9bbc0f") - relativeLuminance("#8bac0f")),
    ).toBe(delta);
    expect(delta).toBe(0.07940986673689476);
    expect(delta).toBeLessThan(LOW_CONTRAST_THRESHOLD);
    expect(delta).toBeGreaterThan(0.079);
  });

  it("keeps the gameboy 0↔1 pair under the threshold too", () => {
    expect(
      Math.abs(relativeLuminance("#306230") - relativeLuminance("#0f380f")),
    ).toBe(0.0661274925252783);
  });

  it("accepts uppercase hex, as `HexColor` does", () => {
    expect(relativeLuminance("#1D2B53")).toBe(relativeLuminance("#1d2b53"));
  });

  it("is monotonic and inside 0..1 across the whole grey ramp", () => {
    let previous = -1;
    for (let g = 0; g < 256; g++) {
      const hex = `#${g.toString(16).padStart(2, "0").repeat(3)}`;
      const l = relativeLuminance(hex);
      expect(l).toBeGreaterThan(previous);
      expect(l).toBeLessThanOrEqual(1);
      previous = l;
    }
  });

  it("lands inside 0..1 for every colour of every bundled palette", () => {
    for (const palette of listPalettes()) {
      for (const hex of palette.colors) {
        const l = relativeLuminance(hex);
        expect(l).toBeGreaterThanOrEqual(0);
        expect(l).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("hexToRgb", () => {
  it("splits `#rrggbb` into three 0-255 channels, in order", () => {
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    expect(hexToRgb("#ffffff")).toEqual([255, 255, 255]);
    expect(hexToRgb("#1d2b53")).toEqual([29, 43, 83]);
    // Red first, blue last — the assertion a channel swap has to survive.
    expect(hexToRgb("#ff0000")).toEqual([255, 0, 0]);
    expect(hexToRgb("#00ff00")).toEqual([0, 255, 0]);
    expect(hexToRgb("#0000ff")).toEqual([0, 0, 255]);
  });

  it("accepts uppercase hex", () => {
    expect(hexToRgb("#1D2B53")).toEqual([29, 43, 83]);
  });

  it("round-trips every bundled palette colour", () => {
    for (const palette of listPalettes()) {
      for (const hex of palette.colors) {
        const rgb = hexToRgb(hex);
        expect(rgb).toHaveLength(3);
        for (const channel of rgb) {
          expect(Number.isInteger(channel)).toBe(true);
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
        const back = `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
        expect(back).toBe(hex.toLowerCase());
      }
    }
  });

  it("agrees with relativeLuminance about which channel is which", () => {
    // A grey has three equal channels, so it cannot detect a byte-order swap;
    // these can. If the two functions ever disagree about which byte is red,
    // the renderer paints one colour while the contrast check judges another.
    // Full red, green and blue are the only three colours whose luminance is a
    // single coefficient, so each pins one channel position in both functions
    // at once.
    const primaries: Array<[string, [number, number, number], number]> = [
      ["#ff0000", [255, 0, 0], 0.2126],
      ["#00ff00", [0, 255, 0], 0.7152],
      ["#0000ff", [0, 0, 255], 0.0722],
    ];
    for (const [hex, rgb, luminance] of primaries) {
      expect(hexToRgb(hex)).toEqual(rgb);
      expect(relativeLuminance(hex)).toBe(luminance);
    }
  });
});
