/**
 * The sprite, rendered as pixels — spec §4.5, §8; plan Wave 11.
 *
 * Until this component existed the app rendered a `<pre>` of `.` and hex digits.
 * That is a faithful view of `SpriteDoc.rows` and a useless view of a sprite: the
 * measured failure the wave was dispatched to make visible — the revise stage
 * degrading a draft, symmetry 0.955 → 0.410 in one run — is not legible as text.
 *
 * **Transparent is not black, and this component is where that is decided.**
 * `pico-8` index 0 *is* `#000000`, so a canvas that fills every cell with a
 * colour makes `.` and `0` the same pixel. Spec §4.5 records that exact confusion
 * measured against the critic — shown a half-transparent, half-black image the
 * model reported "both halves are identical black backgrounds" — and the fix
 * there was to composite against a chosen background. The fix here is structural
 * rather than chosen: **a transparent cell paints nothing at all**, and the
 * checkerboard lives on the grid behind it. There is no code path on which the
 * two render the same, because the empty cell has no fill to get wrong.
 *
 * **Clicks are delegated, not per-cell.** A 64×64 canvas is 4096 cells; one
 * handler that reads `data-x` / `data-y` off the target is one place a
 * transposition can happen, rather than 4096 closures rebuilt on every repaint.
 * `Number("0")` is `0` and `Number.isInteger(0)` is `true`, so the guard admits
 * the first row and the first column — a truthiness check there would make the
 * top-left quadrant edge unpaintable.
 *
 * The component is presentational (§5.1): it does not call `Api.setPixel`, it
 * reports the cell and the colour and lets `App.tsx` route the intent through
 * main. That is what makes it testable without a bridge, and it is what keeps the
 * "edit is a main-process operation" rule in one place.
 */

import type { CSSProperties } from "react";

import { charIndex } from "@shared/grid";
import type { PaletteRef, SpriteDoc } from "@shared/schema";

/** `[x0, y0, x1, y1]`, inclusive — the shape `Issue.region` already uses (§6.4). */
export type Region = readonly [number, number, number, number];

export interface CanvasProps {
  doc: SpriteDoc;
  /** The row character a click paints — `"."` or `0`-`f`. */
  activeIndex: string;
  /** Report a click. The colour is passed back so the caller need not re-read it. */
  onPaint(x: number, y: number, ch: string): void;
  /** The active issue's region, highlighted on the canvas (§8). */
  highlight?: Region | null;
}

/**
 * Roughly how wide the canvas should be, in CSS pixels.
 *
 * A target rather than a fixed cell size, for the reason §6.8 gives for
 * `criticTargetPx`: a fixed multiplier makes one of the three canvases wrong.
 * 512 divides evenly by all of 16, 32 and 64 — 32px, 16px and 8px cells — so
 * every size lands on whole pixels and none of them needs a fractional row.
 */
const CANVAS_TARGET_PX = 512;

/** Cell size for a canvas of `w` columns. Whole pixels only: half a cell blurs. */
export function cellSizePx(w: number): number {
  return Math.max(4, Math.floor(CANVAS_TARGET_PX / w));
}

/**
 * The colour a row character paints, or `undefined` when it paints nothing.
 *
 * `undefined` covers transparency *and* — defensively — an index the document's
 * own palette does not carry. `SpriteDocSchema` refuses the latter (amendment
 * A4), so this is not a tolerated state; it is the difference between a
 * hypothetical bad document rendering as holes and the whole editor crashing on
 * `colors[15]` being `undefined`.
 *
 * Exported because `Filmstrip` renders the same pixels at thumbnail scale, and
 * two implementations of "which cells are empty" is one more than §4.5 survives.
 */
export function cellFill(palette: PaletteRef, ch: string): string | undefined {
  const index = charIndex(ch);
  if (index < 0) return undefined;
  return palette.colors[index];
}

/** Is `(x, y)` inside an inclusive region? */
function inRegion(region: Region | null | undefined, x: number, y: number): boolean {
  if (region === null || region === undefined) return false;
  const [x0, y0, x1, y1] = region;
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

export function Canvas({ doc, activeIndex, onPaint, highlight }: CanvasProps): React.JSX.Element {
  const { w, h } = doc.size;
  const px = cellSizePx(w);

  /**
   * One handler for the whole grid. `closest` walks up from whatever was hit, so
   * a click anywhere inside a cell resolves to that cell and a click on the grid's
   * own padding resolves to nothing.
   */
  function handleClick(event: React.MouseEvent<HTMLDivElement>): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-x]");
    if (target === null) return;
    const x = Number(target.getAttribute("data-x"));
    const y = Number(target.getAttribute("data-y"));
    // Not truthiness: (0, 0) is the top-left pixel and a perfectly ordinary edit.
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    onPaint(x, y, activeIndex);
  }

  const cells: React.JSX.Element[] = [];
  for (let y = 0; y < h; y++) {
    const row = doc.rows[y];
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      const fill = cellFill(doc.palette, ch);
      const lit = inRegion(highlight, x, y);
      cells.push(
        <div
          key={`${x},${y}`}
          role="gridcell"
          data-x={x}
          data-y={y}
          data-ch={ch}
          // Read by `tests/renderer/Canvas.test.tsx`, and by a human in devtools
          // asking the §4.5 question: is that cell black, or is it empty?
          data-transparent={fill === undefined ? "true" : "false"}
          data-highlight={lit ? "true" : "false"}
          aria-label={`${x}, ${y}: ${ch === "." ? "empty" : `index ${ch}`}`}
          style={{
            // No `backgroundColor` at all on an empty cell — the checkerboard on
            // the grid is what shows through it. See the header.
            ...(fill === undefined ? null : { backgroundColor: fill }),
            ...(lit ? styles.lit : null),
          }}
        />,
      );
    }
  }

  return (
    <div
      data-testid="canvas"
      data-size={w}
      role="grid"
      aria-label={`sprite canvas, ${w} by ${h}`}
      onClick={handleClick}
      style={{
        ...styles.grid,
        ...checkerboard(px),
        gridTemplateColumns: `repeat(${w}, ${px}px)`,
        gridAutoRows: `${px}px`,
      }}
    >
      {cells}
    </div>
  );
}

/**
 * The transparency checkerboard, sized to one cell per square.
 *
 * Four `linear-gradient` layers rather than `repeating-conic-gradient`: the
 * classic four-corner form is understood by every engine this ships to and,
 * unlike the conic form, survives jsdom's CSS parser — which is what lets the
 * §4.5 assertion be made on a computed style rather than on a class name.
 *
 * One square per *cell* rather than a fixed 8 or 16 pixels, so the checker reads
 * as "these pixels are empty" at all three canvas sizes instead of as a texture
 * whose scale happens to agree with the sprite at 32×32 only.
 */
function checkerboard(px: number): CSSProperties {
  const a = "#20242e";
  return {
    backgroundColor: "#161922",
    backgroundImage: [
      `linear-gradient(45deg, ${a} 25%, transparent 25%)`,
      `linear-gradient(-45deg, ${a} 25%, transparent 25%)`,
      `linear-gradient(45deg, transparent 75%, ${a} 75%)`,
      `linear-gradient(-45deg, transparent 75%, ${a} 75%)`,
    ].join(", "),
    backgroundSize: `${px * 2}px ${px * 2}px`,
    backgroundPosition: `0 0, 0 ${px}px, ${px}px -${px}px, -${px}px 0`,
  };
}

const styles: Record<string, CSSProperties> = {
  grid: {
    display: "grid",
    // No gap and no cell border: a grid of squares separated by lines is a
    // spreadsheet, and §4's "nearest-neighbour, crisp squares" is the whole look.
    gap: 0,
    lineHeight: 0,
    border: "1px solid rgba(128,128,128,.38)",
    imageRendering: "pixelated",
    cursor: "crosshair",
    // Without this the grid stretches to the flex line and the cells detach from
    // the checkerboard behind them.
    justifySelf: "center",
  },
  lit: {
    boxShadow: "inset 0 0 0 2px rgba(255,60,60,.95)",
    position: "relative",
    zIndex: 2,
  },
};
