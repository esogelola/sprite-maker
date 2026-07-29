/**
 * Colour arithmetic shared by the linter, the renderer and the UI — spec §6.5
 * and amendment A7.
 *
 * **Why this file exists at all.** Wave 3 shipped `relativeLuminance` inside
 * `main/lint.ts`. The code was right; the location was not. `main/*` is
 * unreachable from the renderer bundle — a value import of anything under it
 * drags `node:http` in behind it, which is the same reason §5.2 moved
 * `PipelineState` and friends into `shared/` — so the first time the UI needs
 * contrast for a swatch border or a legible canvas overlay, it cannot import
 * `@main/lint` and someone writes a second copy of the formula. Spec §6.5 says
 * "do not reimplement it with rounding" in as many words, and a rule that
 * placement quietly breaks is not a rule. `shared/color.ts` owns the formula
 * and the threshold; `lint.ts`, `render.ts` and the renderer import from here.
 *
 * The module is **pure**: no imports, no I/O, no Electron, no `node:*`, so it
 * is importable from both processes and from a test with no environment at all.
 */

/**
 * Below this WCAG relative-luminance difference, two orthogonally adjacent
 * palette indices read as one shape rather than two — spec §6.5.
 *
 * `gameboy` indices 2 and 3 sit at Δ 0.0794 against it: a 0.8% margin, and the
 * canary for any change to `relativeLuminance` below.
 */
export const LOW_CONTRAST_THRESHOLD = 0.08;

/** The sRGB → linear transfer function, applied per channel. */
function linearize(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance of a `#rrggbb` colour, in `0..1`.
 *
 * The standard formula, unrounded and unapproximated — spec §6.5 says so in as
 * many words. `gameboy` 2↔3 is Δ 0.0794 against a 0.08 threshold, so quantizing
 * the channels, rounding the exponent, or substituting a cheap
 * perceived-brightness approximation each silently delete a real warning while
 * leaving every other assertion green.
 *
 * **Relocated from `main/lint.ts` character for character** (amendment A7). It
 * deliberately does not call `hexToRgb` below, close as the two are: the move
 * had to be provably value-preserving, and `tests/shared/color.test.ts` pins
 * every digit of the Wave 3 output to prove it.
 */
export function relativeLuminance(hex: string): number {
  const r = linearize(parseInt(hex.slice(1, 3), 16) / 255);
  const g = linearize(parseInt(hex.slice(3, 5), 16) / 255);
  const b = linearize(parseInt(hex.slice(5, 7), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * `#rrggbb` → `[r, g, b]`, each `0..255`.
 *
 * Lives here rather than in `render.ts` for the reason above: a hex parser is
 * the other thing every consumer of a palette needs, and a copy in `main/`
 * would be just as unreachable from the renderer as the luminance formula was.
 *
 * Assumes a `#rrggbb` string — `HexColor` in `shared/schema.ts` has already
 * rejected everything else by the time a colour reaches a palette or a
 * `SpriteDoc`, and `toPng` validates the one colour that does not come from a
 * validated document.
 */
export function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}
