/**
 * Grid → PNG — spec §4.4, §4.5 and §6.8.
 *
 * One renderer serves two callers with opposite requirements, and the parameter
 * that separates them is `background`:
 *
 * - **Export** (Wave 13) calls `toPng(doc, scale)` and gets alpha. A sprite
 *   sheet whose transparency has been baked to a colour is not a sprite sheet.
 * - **Critique** (Wave 7) calls `toPng(doc, scale, pickCriticBackground(doc))`,
 *   because a vision encoder cannot see transparency at all. Spec §4.5 records
 *   the probe: shown a half-transparent, half-opaque-black image,
 *   `qwen3-vl:8b-instruct-q4_K_M` reported *"No visible differences; both
 *   halves are identical black backgrounds."* `pico-8` index 0 is `#000000`, so
 *   a black-outlined sprite on transparency loses the entire silhouette — which
 *   is exactly what §4.4 assigns the image to judge.
 *
 * **Nearest neighbour, never interpolation.** Every sub-pixel of a source cell
 * gets identical RGBA. Bilinear smoothing on a 32×32 canvas upscaled to 512px
 * turns a one-pixel outline into a four-pixel gradient, and a critic asked
 * whether the outline is clean then answers about the resampler.
 *
 * `scale` is a caller's decision, not this module's: §6.8 computes it as
 * `max(1, floor(criticTargetPx / size.w))` for the critique path and offers 1,
 * 4, 8 and 16 for export. This module only insists it be a positive integer —
 * a fractional scale is precisely the thing that cannot be done without
 * resampling.
 *
 * No disk I/O: `toPng` returns a `Buffer` and Wave 13 decides where it goes.
 */

import { PNG } from "pngjs";

import { hexToRgb, relativeLuminance } from "@shared/color";
import { charIndex } from "@shared/grid";
import type { SpriteDoc } from "@shared/schema";

/** `#rrggbb`, the same shape `HexColor` accepts in `shared/schema.ts`. */
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * The greyscale ramp `pickCriticBackground` searches, with luminances computed
 * once at module load rather than 256 times per critique round.
 *
 * **Grey, because hue is not the variable.** The encoder's failure in §4.5 is a
 * luminance collision — it could not separate transparent from black — so the
 * background has to differ from the sprite in luminance. A coloured background
 * would additionally compete with the sprite's own hues for the critic's
 * attention while buying nothing.
 */
const GREY_RAMP: ReadonlyArray<{ hex: string; luminance: number }> = Array.from(
  { length: 256 },
  (_, g) => {
    const hex = `#${g.toString(16).padStart(2, "0").repeat(3)}`;
    return { hex, luminance: relativeLuminance(hex) };
  },
);

/**
 * What `pickCriticBackground` returns for a sprite with nothing drawn on it.
 *
 * Every candidate is equally distant from an empty set, so the choice is a
 * ruling rather than a computation: white, because §4.5's failure mode is a
 * dark sprite vanishing into a dark field, and because a blank canvas handed to
 * the critic should read as blank rather than as an image that failed to load.
 * It is reachable — a generator returning 32 rows of dots produces exactly this
 * document, and spec §6.5 already had to rule on the same sprite for
 * `symmetryScore`.
 */
const EMPTY_SPRITE_BACKGROUND = "#ffffff";

/** The colour palette index `i` names, or a thrown error if the doc lies. */
function colorAt(doc: SpriteDoc, index: number): string {
  const hex = doc.palette.colors[index];
  if (hex === undefined) {
    // Unreachable through `SpriteDocSchema`, which rejects any row character
    // past the end of the palette. Thrown rather than skipped anyway: a missing
    // entry silently rendered as transparent would put a hole in an exported
    // sprite and a hole in the critic's image, and the critic would then report
    // the hole as an artistic flaw.
    throw new RangeError(
      `row character '${index.toString(16)}' names palette index ${index}, ` +
        `but '${doc.palette.id}' has only ${doc.palette.colors.length} entries`,
    );
  }
  return hex;
}

/** Rejects every scale that cannot be done by pixel replication. */
function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new RangeError(
      `scale must be a positive whole number, got ${scale} — a fractional or ` +
        `zero scale cannot be rendered by pixel replication`,
    );
  }
}

/**
 * Render `doc` at `scale`× as an 8-bit RGBA PNG.
 *
 * Transparent cells decode to `[0, 0, 0, 0]` unless `background` is given, in
 * which case they decode to that colour at full alpha. Opaque cells are
 * unaffected by `background` either way — compositing a colour *under* the
 * sprite is the whole operation, and repainting the sprite itself would be a
 * different one.
 */
export function toPng(doc: SpriteDoc, scale: number, background?: string): Buffer {
  assertScale(scale);
  if (background !== undefined && !HEX_COLOR_RE.test(background)) {
    throw new RangeError(
      `background must be a #rrggbb colour, got ${JSON.stringify(background)}`,
    );
  }

  const { w, h } = doc.size;
  const png = new PNG({ width: w * scale, height: h * scale });
  const stride = png.width * 4;
  const under = background === undefined ? undefined : hexToRgb(background);

  for (let y = 0; y < h; y++) {
    const row = doc.rows[y];
    for (let x = 0; x < w; x++) {
      const index = charIndex(row[x]);

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (index >= 0) {
        [r, g, b] = hexToRgb(colorAt(doc, index));
        a = 255;
      } else if (under !== undefined) {
        [r, g, b] = under;
        a = 255;
      }
      // else: transparent and no background — leave the fully transparent
      // black that `new PNG` zero-filled, which is what export must preserve.

      // Pixel replication, `scale` × `scale` per source cell. The bounds are
      // `< scale` on both axes and `< w` / `< h` above: the last row and the
      // last column of the *image* are as much a part of the sprite as any
      // other, and an off-by-one here is invisible on a sprite with a
      // transparent margin.
      for (let dy = 0; dy < scale; dy++) {
        let at = (y * scale + dy) * stride + x * scale * 4;
        for (let dx = 0; dx < scale; dx++) {
          png.data[at++] = r;
          png.data[at++] = g;
          png.data[at++] = b;
          png.data[at++] = a;
        }
      }
    }
  }

  return PNG.sync.write(png);
}

/**
 * The flat colour to composite this sprite's transparency onto — spec §4.5.
 *
 * Returns the grey whose WCAG relative luminance is furthest from **the palette
 * entries the sprite actually uses**, which is two decisions worth naming:
 *
 * - **Used entries, not the whole palette.** A `pico-8` sprite drawn in four
 *   dark greens has no white in it; measuring against index 7 would rule white
 *   out and pick something close to the greens instead.
 * - **Furthest from the *nearest* used entry** (a maximin, not the largest mean
 *   distance). Averaging lets a background sit on top of one colour as long as
 *   it is far from the rest, and one erased colour is one erased silhouette.
 *
 * Computed rather than fixed because `nes-16` and `db16` both carry mid-greys:
 * a hardcoded grey would reintroduce §4.5's defect for any sprite using them —
 * the same failure, less often, which is the harder kind to notice.
 *
 * Ties go to the darker candidate, so the answer is stable between rounds and
 * between machines; the metric is flat across a tie by definition, so which one
 * wins is arbitrary but must not be *unpredictable* — a background that flips
 * between rounds would show up as a critique diff with no cause.
 */
export function pickCriticBackground(doc: SpriteDoc): string {
  const used = new Set<number>();
  for (const row of doc.rows) {
    for (const ch of row) {
      const index = charIndex(ch);
      if (index >= 0) used.add(index);
    }
  }
  if (used.size === 0) return EMPTY_SPRITE_BACKGROUND;

  const luminances = [...used].map((index) => relativeLuminance(colorAt(doc, index)));

  let best = GREY_RAMP[0].hex;
  let bestDistance = -Infinity;
  for (const candidate of GREY_RAMP) {
    let distance = Infinity;
    for (const luminance of luminances) {
      const gap = Math.abs(candidate.luminance - luminance);
      if (gap < distance) distance = gap;
    }
    if (distance > bestDistance) {
      bestDistance = distance;
      best = candidate.hex;
    }
  }
  return best;
}
