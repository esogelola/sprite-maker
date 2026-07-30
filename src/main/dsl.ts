/**
 * The shape DSL interpreter — spec §6.2a (A10) and §6.2b (A11), plan Wave 6b.
 *
 * The draft stage is a division of labour. The generator benchmark
 * (`captures/2026-07-30-generator-capability-benchmark.txt`) established that no
 * locally-runnable model can write a pixel grid: `qwen3:8b` returns a solid
 * rectangle when asked for "8 lines of 8 characters", the most forgiving format
 * available, and prompt, temperature, example size and palette were each
 * eliminated as causes. The DSL benchmark
 * (`captures/2026-07-30-shape-dsl-benchmark.txt`) established that the *same*
 * model composes a recognisable five-colour fox — ears, eyes, body, legs — from
 * thirteen shape operations.
 *
 * **The model reasons about placement; this module counts cells.** Every
 * function here is pure: no model, no disk, no network, no Electron — the same
 * discipline as `shared/grid.ts`, and for the same reason. It is the half of the
 * draft that has to be exactly right, because nothing downstream can see that a
 * mirror was off by one column.
 *
 * Three properties are load-bearing:
 *
 * **1. Every write routes through `setPixel`.** Palette bounds, canvas bounds
 * and the character encoding are enforced in `shared/grid.ts` and nowhere else.
 * Splicing rows here would be faster and would quietly admit a `9` into a
 * four-colour document, which `SpriteDocSchema` then refuses three stages later.
 *
 * **2. Ops clamp; they do not reject.** `cx: 20` on a 16-wide canvas meant "near
 * the right edge", and drawing the visible part costs a partial shape while
 * rejecting costs a whole batch. That is §6.3's repair-table reasoning applied
 * to geometry. Only a *wholly* outside op is a no-op, and it is a silent one.
 *
 * **3. The zero cases are real values, not absences.** `index: "0"` is black,
 * the most common outline colour, and must paint. A `radius: 0` ellipse is the
 * single pixel a model draws an eye with. An empty grid gauges to `coverage: 0`,
 * never `NaN` — `0/0` serializes to `null` and surfaces two stages from its
 * cause.
 */

import {
  TRANSPARENT,
  charIndex,
  makeEmpty,
  setPixel,
  type Grid,
} from "@shared/grid";
import type { DraftGaugeBar, DrawOp, Size } from "@shared/schema";

/**
 * `[x0, y0, x1, y1]`, inclusive — the same shape as `Issue.region` (§6.4).
 *
 * A tuple rather than an object so a bounding box the gauge reports and a region
 * the critic names are the same value in the same order, and Wave 7 does not
 * have to translate between two spellings of one rectangle.
 */
export type BBox = [number, number, number, number];

/**
 * What the harness measures between batches — spec §6.2b.
 *
 * These four numbers are what the model is shown alongside the canvas, and what
 * `clearsGaugeBar` decides on. `bbox` is `null` on an empty canvas rather than a
 * degenerate rectangle: "nothing is drawn" and "one pixel at the origin is
 * drawn" are different facts, and `[0,0,0,0]` says the second.
 */
export interface Gauge {
  coverage: number;
  colours: number;
  bbox: BBox | null;
  distinctRows: number;
}

// ---------------------------------------------------------------------------
// clamping — spec §6.2a, "ops are clamped, not rejected"
// ---------------------------------------------------------------------------

/** The canvas dimensions of a `Grid`, which carries them only in its shape. */
function dimensions(g: Grid): { w: number; h: number } {
  return { w: g[0]?.length ?? 0, h: g.length };
}

/**
 * An inclusive rectangle, normalized and clipped to the canvas.
 *
 * `null` means "wholly outside", which every caller turns into a silent no-op.
 * A reversed rectangle (`x0 > x1`) is normalized rather than refused: `fillRow`
 * in `shared/grid.ts` throws on one because the agent's `fill_row` tool speaks
 * in cells the *critic* named, and swapping those arguments is a real mistake to
 * report. Here the model is composing blind, and a swap is the same arithmetic
 * slip as an over-large `cx`.
 */
function clipRect(
  g: Grid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const { w, h } = dimensions(g);
  if (w === 0 || h === 0) return null;

  const lox = Math.max(0, Math.min(x0, x1));
  const hix = Math.min(w - 1, Math.max(x0, x1));
  const loy = Math.max(0, Math.min(y0, y1));
  const hiy = Math.min(h - 1, Math.max(y0, y1));

  if (lox > hix || loy > hiy) return null;
  return { x0: lox, y0: loy, x1: hix, y1: hiy };
}

/** Paint one cell, or skip it when it is off the canvas. Never throws on bounds. */
function paint(g: Grid, x: number, y: number, ch: string, paletteSize: number): Grid {
  const { w, h } = dimensions(g);
  if (x < 0 || y < 0 || x >= w || y >= h) return g;
  // `setPixel` is the chokepoint: an off-palette `index` throws `GridError`
  // here, from the one module that owns that rule.
  return setPixel(g, x, y, ch, paletteSize);
}

/** Fill an already-clipped inclusive rectangle. */
function fillRect(
  g: Grid,
  rect: { x0: number; y0: number; x1: number; y1: number },
  ch: string,
  paletteSize: number,
): Grid {
  let out = g;
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      out = paint(out, x, y, ch, paletteSize);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the five ops
// ---------------------------------------------------------------------------

/**
 * The tolerance on the ellipse test.
 *
 * `dx² + dy² <= 1.05` rather than `<= 1`. At a radius of 1 the four orthogonal
 * neighbours sit at exactly 1.0, and floating-point division makes a strict
 * comparison a coin toss on which of them survive; at a radius of 2 the tolerance
 * is what keeps the shape from reading as a plus sign. Small radii are most of
 * the ops in a 16×16 sprite, so an ellipse that shrinks is an ellipse that
 * vanishes.
 */
const ELLIPSE_TOLERANCE = 1.05;

/**
 * `dx / rx`, with the zero radius that a strict division would make `NaN`.
 *
 * `rx: 0` is a legal, meaningful radius — it names the centre column, which is
 * how a model draws an eye or a one-pixel bar. `0/0` is `NaN`, and `NaN <= 1.05`
 * is `false`, so an unguarded division erases exactly the ops the sprite's
 * detail is made of.
 */
function axisRatio(delta: number, radius: number): number {
  if (radius === 0) return delta === 0 ? 0 : Infinity;
  return delta / radius;
}

function drawEllipse(
  g: Grid,
  op: Extract<DrawOp, { op: "ellipse" }>,
  paletteSize: number,
): Grid {
  // Only the visible part is walked, so an ellipse centred far off-canvas costs
  // nothing rather than iterating over its whole bounding box.
  const rect = clipRect(g, op.cx - op.rx, op.cy - op.ry, op.cx + op.rx, op.cy + op.ry);
  if (rect === null) return g;

  let out = g;
  for (let y = rect.y0; y <= rect.y1; y++) {
    const ny = axisRatio(y - op.cy, op.ry);
    for (let x = rect.x0; x <= rect.x1; x++) {
      const nx = axisRatio(x - op.cx, op.rx);
      if (nx * nx + ny * ny <= ELLIPSE_TOLERANCE) {
        out = paint(out, x, y, op.index, paletteSize);
      }
    }
  }
  return out;
}

/**
 * Bresenham, endpoints inclusive — one pixel per step of the major axis.
 *
 * Points outside the canvas are skipped rather than ending the walk: a line that
 * leaves the canvas and comes back is a line the model drew across a corner, and
 * stopping at the first outside point would silently truncate it. The loop is
 * bounded by `OP_COORD_LIMIT` on the schema, which is why an unclipped walk is
 * safe here.
 */
function drawLine(g: Grid, op: Extract<DrawOp, { op: "line" }>, paletteSize: number): Grid {
  let out = g;
  let x = op.x0;
  let y = op.y0;
  const dx = Math.abs(op.x1 - op.x0);
  const dy = -Math.abs(op.y1 - op.y0);
  const sx = op.x0 < op.x1 ? 1 : -1;
  const sy = op.y0 < op.y1 ? 1 : -1;
  let err = dx + dy;

  for (;;) {
    out = paint(out, x, y, op.index, paletteSize);
    if (x === op.x1 && y === op.y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/**
 * Copy the left half onto the right, reflected about `axis`.
 *
 * **`axis` is the first column of the right half**, so source `x` lands at
 * `2 * axis - 1 - x`: on a 16-wide canvas `axis: 8` maps 0 → 15 and 7 → 8, which
 * covers every column exactly once. The other reading — `2 * axis - x`, with the
 * axis on a column rather than between two — leaves column 15 unwritten and
 * column 8 untouched, and produces a sprite that is *almost* symmetric, which is
 * the hardest kind of defect to see.
 *
 * The copy is unconditional, transparency included. A mirror that only painted
 * opaque cells would leave whatever was already in the right half showing
 * through, which is how a sprite ends up with three ears.
 */
function mirrorX(g: Grid, axis: number, paletteSize: number): Grid {
  const { w, h } = dimensions(g);
  let out = g;
  for (let x = 0; x < Math.min(axis, w); x++) {
    const dest = 2 * axis - 1 - x;
    if (dest < 0 || dest >= w) continue;
    for (let y = 0; y < h; y++) {
      out = paint(out, dest, y, g[y][x], paletteSize);
    }
  }
  return out;
}

/**
 * One operation against one grid, returning a new grid — spec §6.2a.
 *
 * `paletteSize` is passed in rather than read from a document so the module
 * stays pure and so the palette rule keeps exactly one home: a four-colour
 * `gameboy` canvas rejects `index: "9"` inside `setPixel`, not here.
 */
export function applyOp(g: Grid, op: DrawOp, paletteSize: number): Grid {
  switch (op.op) {
    case "ellipse":
      return drawEllipse(g, op, paletteSize);
    case "fill_rect": {
      const rect = clipRect(g, op.x0, op.y0, op.x1, op.y1);
      return rect === null ? g : fillRect(g, rect, op.index, paletteSize);
    }
    case "line":
      return drawLine(g, op, paletteSize);
    case "mirror_x":
      return mirrorX(g, op.axis, paletteSize);
    case "clear": {
      const rect = clipRect(g, op.x0, op.y0, op.x1, op.y1);
      // `TRANSPARENT` is accepted by `setPixel` at every palette size, which is
      // why `clear` carries no `index` and cannot be asked to "erase to white".
      return rect === null ? g : fillRect(g, rect, TRANSPARENT, paletteSize);
    }
  }
}

/**
 * A whole op list against a fresh canvas — spec §6.2a.
 *
 * Order matters and is the model's: later ops paint over earlier ones, which is
 * how an outline goes on after a fill and how `clear` cuts a notch.
 */
export function renderOps(ops: readonly DrawOp[], size: Size, paletteSize: number): Grid {
  let g = makeEmpty(size.w, size.h);
  for (const op of ops) g = applyOp(g, op, paletteSize);
  return g;
}

// ---------------------------------------------------------------------------
// the gauge — spec §6.2b
// ---------------------------------------------------------------------------

/**
 * Measure a canvas — spec §6.2b, amendment A11.
 *
 * The four numbers the harness shows the model between batches, and the four
 * `clearsGaugeBar` decides on. Every one of them has a defined value on an empty
 * canvas: `coverage` is `0` and not `0/0`, `colours` is `0`, `bbox` is `null`,
 * and `distinctRows` is the number of distinct row strings, which is `1` for a
 * grid of identical empty rows — the figure the benchmark reports as `1/16` for
 * the degenerate reply.
 */
export function gauge(g: Grid): Gauge {
  const { w, h } = dimensions(g);
  const cells = w * h;

  const colours = new Set<string>();
  let count = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  for (let y = 0; y < h; y++) {
    const row = g[y];
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      // `charIndex` returns -1 for transparent *and* for anything invalid, so
      // this counts painted cells rather than legal ones — and `'0'` is index 0,
      // which a truthiness test would drop. It is black, and it is the
      // commonest outline colour in every bundled palette.
      if (c === TRANSPARENT || charIndex(c) < 0) continue;
      count++;
      colours.add(c);
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }

  return {
    // The zero case, spelled out: a canvas with no cells has coverage 0, not
    // `NaN`. `NaN` fails every bar silently and serializes to `null`.
    coverage: cells === 0 ? 0 : count / cells,
    colours: colours.size,
    bbox: count === 0 ? null : [x0, y0, x1, y1],
    distinctRows: new Set(g).size,
  };
}

/**
 * Has the draft cleared the bar? — spec §6.2b, amendment A11.
 *
 * **The harness owns this decision, not the model.** In the benchmark the model
 * never once set `done: true`; it consumed every batch it was offered, and on
 * the subject one shot already drew well, five further batches produced a
 * simpler, worse sprite. Reliability is what the loop buys; quality is not.
 *
 * Every comparison is inclusive, so a canvas sitting exactly on a bound passes.
 * The bounds are first guesses to be tuned by the bench (§12), and a draft that
 * is exactly at `maxCoverage` should not pay for another inference.
 */
export function clearsGaugeBar(reading: Gauge, bar: DraftGaugeBar): boolean {
  return (
    reading.colours >= bar.minColours &&
    reading.coverage >= bar.minCoverage &&
    reading.coverage <= bar.maxCoverage &&
    reading.distinctRows >= bar.minDistinctRows
  );
}
