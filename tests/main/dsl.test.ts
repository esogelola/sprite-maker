/**
 * The shape DSL — spec §6.2a (A10) and §6.2b (A11), plan Wave 6b.
 *
 * Written before `src/main/dsl.ts` existed. This module is the half of the
 * draft stage that the *model is not competent at*: the benchmark
 * (`captures/2026-07-30-generator-capability-benchmark.txt`) showed no local 8B
 * model can do 256 cells of blind bookkeeping, and the DSL benchmark
 * (`captures/2026-07-30-shape-dsl-benchmark.txt`) showed the same model composes
 * a recognisable sprite from 13 operations. So every cell this file writes is a
 * cell the model never counted, and an off-by-one here is invisible upstream.
 *
 * Four behaviours are pinned because their breakage is silent:
 *
 * - **`mirror_x` reproduces the left half exactly.** Every benchmark run reached
 *   for it, unprompted beyond one line of guidance, and character sprites are
 *   mostly symmetric. A mirror off by one column, or copying right-to-left,
 *   still produces a plausible-looking sprite.
 * - **Ops clamp, they do not reject.** `cx: 20` on a 16-wide canvas meant "near
 *   the right edge"; rejecting it costs a whole batch for an arithmetic slip,
 *   which is the same reasoning as §6.3's repair table.
 * - **Every write routes through `shared/grid.ts`'s `setPixel`.** Palette and
 *   bounds validation live there and nowhere else — an `index` a 4-colour ramp
 *   cannot spell is refused by `setPixel`, not by a second copy of the rule.
 * - **The zero case everywhere.** An empty grid must gauge to `coverage: 0`,
 *   not `NaN`; `index: "0"` is black, the most common outline colour, and must
 *   paint; a `radius: 0` ellipse is one pixel, not nothing.
 *
 * Pure throughout: no model, no I/O, green with Ollama stopped.
 */

import { describe, expect, it } from "vitest";

import { applyOp, clearsGaugeBar, gauge, renderOps } from "@main/dsl";
import { GridError, makeEmpty, type Grid } from "@shared/grid";
import { DEFAULT_HARNESS_CONFIG, type DrawOp, type Size } from "@shared/schema";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const SIZE_16: Size = { w: 16, h: 16 };
const SIZE_32: Size = { w: 32, h: 32 };

/** Every bundled palette carries at least four entries — spec §6.1a. */
const FOUR = 4;
const SIXTEEN = 16;

const BAR = DEFAULT_HARNESS_CONFIG.draftGaugeBar;

/** A grid from a picture, so an expectation reads as the sprite it describes. */
function grid(...rows: string[]): Grid {
  return rows;
}

/** Every painted cell of `g`, as `x,y=char`, in row-major order. */
function painted(g: Grid): string[] {
  const out: string[] = [];
  g.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] !== ".") out.push(`${x},${y}=${row[x]}`);
  });
  return out;
}

// ---------------------------------------------------------------------------
// applyOp — fill_rect
// ---------------------------------------------------------------------------

describe("applyOp — fill_rect", () => {
  it("fills the rectangle inclusive of both corners", () => {
    const out = applyOp(makeEmpty(8, 8), { op: "fill_rect", x0: 2, y0: 1, x1: 4, y1: 3, index: "1" }, FOUR);
    expect(out).toEqual(
      grid(
        "........",
        "..111...",
        "..111...",
        "..111...",
        "........",
        "........",
        "........",
        "........",
      ),
    );
  });

  it("writes a single pixel when the corners coincide", () => {
    const out = applyOp(makeEmpty(4, 4), { op: "fill_rect", x0: 2, y0: 2, x1: 2, y1: 2, index: "3" }, FOUR);
    expect(painted(out)).toEqual(["2,2=3"]);
  });

  it("normalizes a reversed rectangle rather than dropping it", () => {
    const forward = applyOp(makeEmpty(8, 8), { op: "fill_rect", x0: 1, y0: 1, x1: 5, y1: 4, index: "2" }, FOUR);
    const reversed = applyOp(makeEmpty(8, 8), { op: "fill_rect", x0: 5, y0: 4, x1: 1, y1: 1, index: "2" }, FOUR);
    expect(reversed).toEqual(forward);
  });

  it("clamps a rectangle that runs off the right and bottom edges", () => {
    const out = applyOp(makeEmpty(4, 4), { op: "fill_rect", x0: 2, y0: 2, x1: 40, y1: 40, index: "1" }, FOUR);
    expect(out).toEqual(grid("....", "....", "..11", "..11"));
  });

  it("clamps a rectangle that starts off the left and top edges", () => {
    const out = applyOp(makeEmpty(4, 4), { op: "fill_rect", x0: -9, y0: -9, x1: 1, y1: 1, index: "1" }, FOUR);
    expect(out).toEqual(grid("11..", "11..", "....", "...."));
  });

  it("is a silent no-op when the whole rectangle is outside the canvas", () => {
    const empty = makeEmpty(4, 4);
    const right = applyOp(empty, { op: "fill_rect", x0: 20, y0: 0, x1: 30, y1: 3, index: "1" }, FOUR);
    const above = applyOp(empty, { op: "fill_rect", x0: 0, y0: -30, x1: 3, y1: -20, index: "1" }, FOUR);
    expect(right).toEqual(empty);
    expect(above).toEqual(empty);
  });
});

// ---------------------------------------------------------------------------
// applyOp — ellipse
// ---------------------------------------------------------------------------

describe("applyOp — ellipse", () => {
  it("draws a filled ellipse centred on (cx, cy)", () => {
    // `(dx/rx)² + (dy/ry)² <= 1.05`, so the poles are a single pixel: at
    // `|dy| = ry` the whole budget is spent and only `dx = 0` fits. The
    // tolerance keeps small radii from vanishing; it does not fatten the tips.
    const out = applyOp(makeEmpty(9, 9), { op: "ellipse", cx: 4, cy: 4, rx: 3, ry: 2, index: "2" }, FOUR);
    expect(out).toEqual(
      grid(
        ".........",
        ".........",
        "....2....",
        "..22222..",
        ".2222222.",
        "..22222..",
        "....2....",
        ".........",
        ".........",
      ),
    );
  });

  it("draws a single pixel for radius 0 — the zero case, not nothing", () => {
    // An eye is a radius-0 ellipse. A `!rx` guard, or a strict `< 1` test,
    // erases it and the sprite comes back blind.
    const out = applyOp(makeEmpty(5, 5), { op: "ellipse", cx: 2, cy: 2, rx: 0, ry: 0, index: "1" }, FOUR);
    expect(painted(out)).toEqual(["2,2=1"]);
    expect(out).toEqual(grid(".....", ".....", "..1..", ".....", "....."));
  });

  it("draws a one-pixel-wide bar when only rx is 0", () => {
    const out = applyOp(makeEmpty(5, 5), { op: "ellipse", cx: 2, cy: 2, rx: 0, ry: 2, index: "1" }, FOUR);
    expect(painted(out)).toEqual(["2,0=1", "2,1=1", "2,2=1", "2,3=1", "2,4=1"]);
  });

  it("keeps a radius-1 ellipse from vanishing — the 1.05 tolerance", () => {
    // (dx/1)^2 + (dy/1)^2 = 2 at the diagonal, so the corners stay off, but the
    // four orthogonal neighbours are exactly 1.0 and must be on. A strict `< 1`
    // leaves a radius-1 ellipse as a single pixel and every small detail
    // disappears from the sprite.
    const out = applyOp(makeEmpty(5, 5), { op: "ellipse", cx: 2, cy: 2, rx: 1, ry: 1, index: "1" }, FOUR);
    expect(out).toEqual(grid(".....", "..1..", ".111.", "..1..", "....."));
  });

  it("clamps an ellipse whose centre is off the canvas, drawing the visible part", () => {
    // Acceptance criterion 3, and §6.2a's own example: `cx: 20` on a 16-wide
    // canvas meant "near the right edge", so the arc that reaches back onto the
    // canvas is drawn rather than the whole op being thrown away.
    const out = applyOp(makeEmpty(SIZE_16.w, SIZE_16.h), { op: "ellipse", cx: 20, cy: 8, rx: 8, ry: 4, index: "1" }, FOUR);
    const g = gauge(out);
    expect(g.coverage).toBeGreaterThan(0);
    // Everything drawn is inside the canvas, and it hugs the right edge.
    expect(g.bbox).toEqual([12, 5, 15, 11]);
    for (const row of out) expect(row).toHaveLength(16);
  });

  it("is a silent no-op when the whole ellipse is outside the canvas", () => {
    const empty = makeEmpty(SIZE_16.w, SIZE_16.h);
    // Out to the right by more than its own radius — nothing of it is visible.
    expect(applyOp(empty, { op: "ellipse", cx: 20, cy: 8, rx: 3, ry: 3, index: "1" }, FOUR)).toEqual(empty);
    expect(applyOp(empty, { op: "ellipse", cx: 60, cy: 8, rx: 3, ry: 3, index: "1" }, FOUR)).toEqual(empty);
    expect(applyOp(empty, { op: "ellipse", cx: 8, cy: -60, rx: 3, ry: 3, index: "1" }, FOUR)).toEqual(empty);
  });
});

// ---------------------------------------------------------------------------
// applyOp — line
// ---------------------------------------------------------------------------

describe("applyOp — line", () => {
  it("draws a horizontal line inclusive of both endpoints", () => {
    const out = applyOp(makeEmpty(6, 3), { op: "line", x0: 1, y0: 1, x1: 4, y1: 1, index: "1" }, FOUR);
    expect(out).toEqual(grid("......", ".1111.", "......"));
  });

  it("draws a vertical line", () => {
    const out = applyOp(makeEmpty(3, 5), { op: "line", x0: 1, y0: 0, x1: 1, y1: 4, index: "1" }, FOUR);
    expect(out).toEqual(grid(".1.", ".1.", ".1.", ".1.", ".1."));
  });

  it("draws a 45-degree diagonal", () => {
    const out = applyOp(makeEmpty(5, 5), { op: "line", x0: 0, y0: 0, x1: 4, y1: 4, index: "1" }, FOUR);
    expect(out).toEqual(grid("1....", ".1...", "..1..", "...1.", "....1"));
  });

  it("draws a shallow diagonal by Bresenham, one pixel per column", () => {
    const out = applyOp(makeEmpty(7, 3), { op: "line", x0: 0, y0: 0, x1: 6, y1: 2, index: "1" }, FOUR);
    // Exactly one lit cell per column: a line that doubles up is a line that
    // reads as a smear at 16x16.
    for (let x = 0; x < 7; x++) {
      const column = out.map((row) => row[x]).filter((c) => c !== ".");
      expect(column).toHaveLength(1);
    }
    expect(painted(out)).toHaveLength(7);
  });

  it("draws the same pixels in either direction", () => {
    const forward = applyOp(makeEmpty(9, 9), { op: "line", x0: 1, y0: 2, x1: 7, y1: 6, index: "1" }, FOUR);
    const backward = applyOp(makeEmpty(9, 9), { op: "line", x0: 7, y0: 6, x1: 1, y1: 2, index: "1" }, FOUR);
    expect(painted(backward).sort()).toEqual(painted(forward).sort());
  });

  it("writes one pixel when the endpoints coincide", () => {
    const out = applyOp(makeEmpty(4, 4), { op: "line", x0: 2, y0: 1, x1: 2, y1: 1, index: "2" }, FOUR);
    expect(painted(out)).toEqual(["2,1=2"]);
  });

  it("clips a line that leaves the canvas instead of dropping it", () => {
    const out = applyOp(makeEmpty(8, 8), { op: "line", x0: -4, y0: 4, x1: 40, y1: 4, index: "1" }, FOUR);
    expect(out[4]).toBe("11111111");
    expect(painted(out)).toHaveLength(8);
  });

  it("is a silent no-op when the whole line is outside the canvas", () => {
    const empty = makeEmpty(8, 8);
    expect(applyOp(empty, { op: "line", x0: 20, y0: 20, x1: 30, y1: 30, index: "1" }, FOUR)).toEqual(empty);
  });

  it("stays bounded on the longest coordinates the schema admits", () => {
    // `OP_COORD_LIMIT` exists so this cannot become an unbounded loop.
    const started = Date.now();
    const out = applyOp(makeEmpty(8, 8), { op: "line", x0: -512, y0: -512, x1: 512, y1: 512, index: "1" }, FOUR);
    expect(Date.now() - started).toBeLessThan(200);
    expect(painted(out)).toHaveLength(8); // the main diagonal
  });
});

// ---------------------------------------------------------------------------
// applyOp — mirror_x
//
// Acceptance criterion 2. Every benchmark run reached for this op.
// ---------------------------------------------------------------------------

describe("applyOp — mirror_x", () => {
  it("reproduces the left half exactly, reflected onto the right", () => {
    const left = grid(
      "0123............",
      "1...............",
      "..2.............",
      "...3............",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    );
    const out = applyOp(left, { op: "mirror_x", axis: 8 }, FOUR);

    // x maps to 2*axis - 1 - x: 0 -> 15, 7 -> 8. Both halves are covered and
    // no column is written twice.
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 8; x++) {
        expect(out[y][15 - x]).toBe(left[y][x]);
      }
      // The left half is untouched.
      expect(out[y].slice(0, 8)).toBe(left[y].slice(0, 8));
    }
    expect(out[0]).toBe("0123........3210");
  });

  it("mirrors an odd-width canvas about the given column boundary", () => {
    const out = applyOp(grid("12...", ".....", "....."), { op: "mirror_x", axis: 2 }, FOUR);
    // axis 2 mirrors x 0-1 onto x 2-3; x 4 is beyond the reflection and is left.
    expect(out[0]).toBe("1221.");
  });

  it("overwrites the right half, including with transparency", () => {
    // "Reproduces the left half exactly" means exactly: a mirror that only
    // paints where the source is opaque leaves the old right half showing
    // through, which is how a sprite ends up with three ears.
    const out = applyOp(grid("..1.33.."), { op: "mirror_x", axis: 4 }, FOUR);
    expect(out[0]).toBe("..1..1..");
  });

  it("is a silent no-op when the reflection lands entirely off the canvas", () => {
    const before = grid("12..", "....");
    expect(applyOp(before, { op: "mirror_x", axis: 0 }, FOUR)).toEqual(before);
    expect(applyOp(before, { op: "mirror_x", axis: 40 }, FOUR)).toEqual(before);
  });

  it("is idempotent — mirroring twice changes nothing the first did not", () => {
    const once = applyOp(grid("0123............"), { op: "mirror_x", axis: 8 }, FOUR);
    expect(applyOp(once, { op: "mirror_x", axis: 8 }, FOUR)).toEqual(once);
  });
});

// ---------------------------------------------------------------------------
// applyOp — clear
// ---------------------------------------------------------------------------

describe("applyOp — clear", () => {
  it("erases a rectangle back to transparent", () => {
    const before = grid("1111", "1111", "1111", "1111");
    const out = applyOp(before, { op: "clear", x0: 1, y0: 1, x1: 2, y1: 2 }, FOUR);
    expect(out).toEqual(grid("1111", "1..1", "1..1", "1111"));
  });

  it("clamps rather than rejecting, and normalizes a reversed rectangle", () => {
    const before = grid("1111", "1111", "1111", "1111");
    expect(applyOp(before, { op: "clear", x0: 2, y0: 2, x1: 40, y1: 40 }, FOUR)).toEqual(
      grid("1111", "1111", "11..", "11.."),
    );
    expect(applyOp(before, { op: "clear", x0: 3, y0: 3, x1: 2, y1: 2 }, FOUR)).toEqual(
      applyOp(before, { op: "clear", x0: 2, y0: 2, x1: 3, y1: 3 }, FOUR),
    );
  });

  it("is a silent no-op when the whole rectangle is outside the canvas", () => {
    const before = grid("1111", "1111");
    expect(applyOp(before, { op: "clear", x0: 10, y0: 0, x1: 20, y1: 1 }, FOUR)).toEqual(before);
  });

  it("clears even when the palette has no colours left to name", () => {
    // `clear` carries no `index` precisely so it cannot be asked to "erase to
    // white"; it writes `.`, which `setPixel` accepts at every palette size.
    expect(applyOp(grid("11"), { op: "clear", x0: 0, y0: 0, x1: 1, y1: 0 }, FOUR)).toEqual(grid(".."));
  });
});

// ---------------------------------------------------------------------------
// applyOp — the shared contract
// ---------------------------------------------------------------------------

describe("applyOp — the shared contract", () => {
  it("leaves its input untouched, like every mutator in shared/grid.ts", () => {
    const before = makeEmpty(8, 8);
    const snapshot = [...before];
    applyOp(before, { op: "fill_rect", x0: 0, y0: 0, x1: 7, y1: 7, index: "1" }, FOUR);
    expect(before).toEqual(snapshot);
  });

  it("paints index '0' — the falsy character, and the commonest outline colour", () => {
    // `"0"` is black in every bundled palette and the index a `!index` or
    // `Number(index) || fallback` check silently drops.
    for (const op of [
      { op: "fill_rect", x0: 1, y0: 1, x1: 2, y1: 2, index: "0" },
      { op: "ellipse", cx: 2, cy: 2, rx: 1, ry: 1, index: "0" },
      { op: "line", x0: 0, y0: 0, x1: 3, y1: 3, index: "0" },
    ] satisfies DrawOp[]) {
      const out = applyOp(makeEmpty(4, 4), op, FOUR);
      expect(painted(out).length).toBeGreaterThan(0);
      expect(painted(out).every((cell) => cell.endsWith("=0"))).toBe(true);
    }
  });

  it("routes validation through setPixel — an off-palette index throws GridError", () => {
    // Acceptance criterion 4: the palette rule lives in `shared/grid.ts` and
    // nowhere else. A DSL that spliced rows directly would paint a `9` into a
    // four-colour document and fail three layers later, at `SpriteDocSchema`.
    expect(() =>
      applyOp(makeEmpty(8, 8), { op: "fill_rect", x0: 0, y0: 0, x1: 1, y1: 1, index: "9" }, FOUR),
    ).toThrow(GridError);
    // The same op against a 16-colour palette is not a defect at all.
    expect(() =>
      applyOp(makeEmpty(8, 8), { op: "fill_rect", x0: 0, y0: 0, x1: 1, y1: 1, index: "9" }, SIXTEEN),
    ).not.toThrow();
  });

  it("never widens or shortens a row", () => {
    let g = makeEmpty(SIZE_16.w, SIZE_16.h);
    for (const op of [
      { op: "ellipse", cx: 20, cy: 20, rx: 9, ry: 9, index: "1" },
      { op: "fill_rect", x0: -5, y0: -5, x1: 30, y1: 30, index: "2" },
      { op: "line", x0: -20, y0: 8, x1: 40, y1: 8, index: "3" },
      { op: "mirror_x", axis: 8 },
      { op: "clear", x0: -4, y0: -4, x1: 40, y1: 2 },
    ] satisfies DrawOp[]) {
      g = applyOp(g, op, FOUR);
      expect(g).toHaveLength(16);
      for (const row of g) expect(row).toHaveLength(16);
    }
  });
});

// ---------------------------------------------------------------------------
// renderOps
// ---------------------------------------------------------------------------

describe("renderOps", () => {
  it("returns an empty canvas for an empty op list", () => {
    expect(renderOps([], SIZE_16, FOUR)).toEqual(makeEmpty(16, 16));
  });

  it("applies ops in order, later ops painting over earlier ones", () => {
    const out = renderOps(
      [
        { op: "fill_rect", x0: 0, y0: 0, x1: 3, y1: 3, index: "1" },
        { op: "fill_rect", x0: 1, y0: 1, x1: 2, y1: 2, index: "2" },
      ],
      { w: 16, h: 16 },
      FOUR,
    );
    expect(out[0].slice(0, 4)).toBe("1111");
    expect(out[1].slice(0, 4)).toBe("1221");
  });

  it("renders the canvas at the size it is given", () => {
    const out = renderOps([{ op: "fill_rect", x0: 0, y0: 0, x1: 40, y1: 40, index: "1" }], SIZE_32, FOUR);
    expect(out).toHaveLength(32);
    for (const row of out) expect(row).toBe("1".repeat(32));
  });

  it("composes a legible sprite from the benchmark's own op vocabulary", () => {
    // The shape of the run recorded in
    // `captures/2026-07-30-shape-dsl-benchmark.txt`: block in a mass, add a
    // head, mirror for symmetry, then the details.
    const out = renderOps(
      [
        { op: "ellipse", cx: 8, cy: 5, rx: 4, ry: 3, index: "2" },
        { op: "fill_rect", x0: 5, y0: 8, x1: 10, y1: 12, index: "2" },
        { op: "line", x0: 3, y0: 1, x1: 6, y1: 4, index: "0" },
        { op: "ellipse", cx: 6, cy: 5, rx: 0, ry: 0, index: "3" },
        { op: "mirror_x", axis: 8 },
        { op: "clear", x0: 0, y0: 14, x1: 15, y1: 15 },
        { op: "line", x0: 6, y0: 13, x1: 6, y1: 13, index: "1" },
        { op: "line", x0: 9, y0: 13, x1: 9, y1: 13, index: "1" },
      ],
      SIZE_16,
      FOUR,
    );
    expect(out).toEqual(
      grid(
        "................",
        "...0........0...",
        "....0......0....",
        ".....022220.....",
        ".....202202.....",
        "....22322322....",
        ".....222222.....",
        ".....222222.....",
        ".....222222.....",
        ".....222222.....",
        ".....222222.....",
        ".....222222.....",
        ".....222222.....",
        "......1..1......",
        "................",
        "................",
      ),
    );
    // Eight operations, four colours, ears mirrored, feet, and a margin — the
    // draft the gauge bar exists to accept.
    expect(clearsGaugeBar(gauge(out), BAR)).toBe(true);
    // `clear` ran before the feet, so the bottom two rows are empty and row 13
    // is not: order is the model's and later ops paint over earlier ones.
    expect(out[14]).toBe(".".repeat(16));
    expect(out[15]).toBe(".".repeat(16));
  });
});

// ---------------------------------------------------------------------------
// gauge — acceptance criterion 5, including the zero case
// ---------------------------------------------------------------------------

describe("gauge", () => {
  it("measures a hand-built grid exactly", () => {
    const g = gauge(grid("....", ".12.", ".33.", "...."));
    expect(g.coverage).toBe(4 / 16);
    expect(g.colours).toBe(3); // 1, 2, 3 — `3` twice counts once
    expect(g.bbox).toEqual([1, 1, 2, 2]);
    expect(g.distinctRows).toBe(3); // "....", ".12.", ".33." — the two dots rows are one
  });

  it("gives an EMPTY grid coverage 0, colours 0 and a representable bbox", () => {
    // The falsy-zero case this project has near-missed three times. `0/0` is
    // `NaN`, which serializes to `null` and surfaces two stages from its cause.
    const g = gauge(makeEmpty(16, 16));
    expect(g.coverage).toBe(0);
    expect(Number.isNaN(g.coverage)).toBe(false);
    expect(g.colours).toBe(0);
    expect(g.bbox).toBeNull();
    expect(g.distinctRows).toBe(1); // 16 identical rows of dots
  });

  it("gives a ZERO-CELL grid coverage 0 rather than NaN", () => {
    // The other zero: no rows at all. `painted / (w * h)` is `0 / 0` here.
    const g = gauge([]);
    expect(g.coverage).toBe(0);
    expect(Number.isNaN(g.coverage)).toBe(false);
    expect(g.colours).toBe(0);
    expect(g.bbox).toBeNull();
    expect(g.distinctRows).toBe(0);
  });

  it("counts index '0' as a painted cell and as a colour", () => {
    // `"0"` is black. Counted with `charIndex(c) > 0`, or with a truthiness
    // test, the commonest outline colour reads as an empty canvas.
    const g = gauge(grid("0...", "....", "....", "...."));
    expect(g.coverage).toBe(1 / 16);
    expect(g.colours).toBe(1);
    expect(g.bbox).toEqual([0, 0, 0, 0]);
  });

  it("reports coverage 1 for a fully painted grid", () => {
    const g = gauge(grid("11", "11"));
    expect(g.coverage).toBe(1);
    expect(g.colours).toBe(1);
    expect(g.bbox).toEqual([0, 0, 1, 1]);
    expect(g.distinctRows).toBe(1);
  });

  it("counts every distinct index, up to the 16 the encoding can spell", () => {
    const g = gauge(grid("0123456789abcdef"));
    expect(g.colours).toBe(16);
    expect(g.coverage).toBe(1);
  });

  it("bounds the bbox to the painted cells, not to the canvas", () => {
    const g = gauge(grid("........", "........", "...1....", "........", "......2.", "........"));
    expect(g.bbox).toEqual([3, 2, 6, 4]);
  });

  it("counts distinct rows by their content, matching the benchmark's own figure", () => {
    // The benchmark reports `distinctRows 1/16` for the degenerate all-dots
    // reply and `12/16` for the fox — that is `new Set(rows).size`.
    expect(gauge(Array(16).fill(".".repeat(16))).distinctRows).toBe(1);
    expect(gauge(grid("1...", "1...", "2...", "3...")).distinctRows).toBe(3);
  });

  it("is pure — it does not touch the grid it measures", () => {
    const g = grid("....", ".12.", ".33.", "....");
    const snapshot = [...g];
    gauge(g);
    expect(g).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// clearsGaugeBar — spec §6.2b, the harness's stop decision
// ---------------------------------------------------------------------------

describe("clearsGaugeBar", () => {
  /** A gauge reading built from the default bar, then nudged. */
  function reading(patch: Partial<ReturnType<typeof gauge>> = {}): ReturnType<typeof gauge> {
    return { coverage: 0.3, colours: 4, bbox: [1, 1, 14, 14], distinctRows: 12, ...patch };
  }

  it("clears when every measurement is inside the bar", () => {
    expect(clearsGaugeBar(reading(), BAR)).toBe(true);
  });

  it("fails a monochrome mass — the failure A11 exists to catch", () => {
    expect(clearsGaugeBar(reading({ colours: 1 }), BAR)).toBe(false);
    expect(clearsGaugeBar(reading({ colours: 2 }), BAR)).toBe(false);
    expect(clearsGaugeBar(reading({ colours: 3 }), BAR)).toBe(true);
  });

  it("fails an under-drawn canvas and an over-flooded one", () => {
    expect(clearsGaugeBar(reading({ coverage: 0.11 }), BAR)).toBe(false);
    expect(clearsGaugeBar(reading({ coverage: 0.12 }), BAR)).toBe(true);
    expect(clearsGaugeBar(reading({ coverage: 0.8 }), BAR)).toBe(true);
    expect(clearsGaugeBar(reading({ coverage: 0.81 }), BAR)).toBe(false);
  });

  it("fails a canvas with too little vertical structure", () => {
    expect(clearsGaugeBar(reading({ distinctRows: 7 }), BAR)).toBe(false);
    expect(clearsGaugeBar(reading({ distinctRows: 8 }), BAR)).toBe(true);
  });

  it("fails an empty canvas on every count at once", () => {
    expect(clearsGaugeBar(gauge(makeEmpty(16, 16)), BAR)).toBe(false);
    expect(clearsGaugeBar(gauge([]), BAR)).toBe(false);
  });
});
