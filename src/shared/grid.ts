/**
 * The one place a pixel changes — spec §6.1 and §6.3.
 *
 * Every mutation in the system routes through this module: the agent's
 * `place_pixel` tool, the user's mouse click, and the draft parser all call the
 * same functions, so a rule enforced here is enforced everywhere.
 *
 * The module is **pure**. It imports one type and nothing else — no Electron,
 * no model, no disk, no `node:*`. Every mutator returns a new `Grid` and leaves
 * its input untouched, which is what makes `SessionHistory`'s per-round
 * snapshots safe to hold onto.
 */

import type { PixelDiff } from "@shared/schema";

/**
 * `h` strings of `w` characters each. Row `y`, column `x` is `g[y][x]`.
 * A `Grid` is only the pixels; the size, palette and metadata live on the
 * `SpriteDoc` that wraps it.
 */
export type Grid = string[];

/** The transparent cell. Deliberately a character that reads as empty in logs. */
export const TRANSPARENT = ".";

/** Palette index `i` is spelled `HEX_CHARS[i]`. Lowercase only — spec §6.1. */
const HEX_CHARS = "0123456789abcdef";

/** The encoding caps a palette at 16 opaque entries plus transparent. */
const MAX_INDEX = HEX_CHARS.length - 1;

/**
 * A rejected grid operation.
 *
 * `code` is the machine-readable half: Wave 8's revise loop branches on it to
 * build the tool-result string it hands back to the model, and must never have
 * to parse `message` to find out what went wrong.
 *
 * - `out-of-bounds` — the coordinates do not name a cell of this grid.
 * - `off-palette`   — a real index, but past the end of the palette in use.
 * - `bad-char`      — not `.` and not a lowercase hex digit at all.
 */
export class GridError extends Error {
  constructor(
    public code: "out-of-bounds" | "off-palette" | "bad-char",
    message: string,
  ) {
    super(message);
    this.name = "GridError";
  }
}

/**
 * Palette index → row character. `0`-`9` then lowercase `a`-`f`.
 *
 * Throws rather than returning a sentinel: a caller holding an index it cannot
 * encode has a bug, and silently substituting a character would paint the
 * wrong colour. Wave 8 catches the `GridError` and reports it to the model.
 */
export function indexChar(i: number): string {
  if (!Number.isInteger(i)) {
    throw new GridError("bad-char", `palette index ${i} is not a whole number`);
  }
  if (i < 0 || i > MAX_INDEX) {
    throw new GridError(
      "off-palette",
      `palette index ${i} is outside the 0-${MAX_INDEX} encoding range`,
    );
  }
  return HEX_CHARS[i];
}

/**
 * Row character → palette index, or `-1`.
 *
 * `-1` covers transparent *and* every invalid input, which is exactly what
 * `normalize` and the Wave 3 linter want: "this cell holds no palette index."
 * Never throws — classification is not an error condition.
 *
 * Uppercase `A`-`F` are **not** accepted (spec §6.1). Folding them would give
 * one pixel two spellings and silently break row equality, `diff`, the
 * `empty-diff` stop condition and golden-file comparison at once.
 */
export function charIndex(c: string): number {
  if (typeof c !== "string" || c.length !== 1) return -1;
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // '0'-'9'
  if (code >= 97 && code <= 102) return code - 87; // 'a'-'f'
  return -1;
}

/** A fully transparent `w`×`h` grid. */
export function makeEmpty(w: number, h: number): Grid {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0) {
    throw new GridError(
      "out-of-bounds",
      `cannot build a ${w}x${h} grid: dimensions must be whole and non-negative`,
    );
  }
  // Strings are immutable, so every row can share one instance safely.
  const row = TRANSPARENT.repeat(w);
  return Array.from({ length: h }, () => row);
}

/**
 * Force arbitrary model output into a well-formed `w`×`h` grid — spec §6.3.
 *
 * `qwen3:8b` emits mis-sized rows routinely, so this is expected input rather
 * than an error path. Every repaired cell increments `repairs`, which is the
 * honest quality signal the draft stage thresholds on; `repairedRows` feeds
 * Wave 3's `row-repaired` warning, which is knowable only here.
 *
 * Dropped rows raise `repairs` but cannot appear in `repairedRows` — they have
 * no index in the finished grid to point at.
 *
 * `paletteSize` is **required** — spec §6.3 amendment A4. An index at or past
 * the end of the palette is repaired to `.` and charged exactly like an invalid
 * character: a generator reaching past a 4-colour ramp is being sloppy in the
 * way the other repair rules already forgive, and forgiving it costs a
 * character rather than a regeneration. Making the parameter optional would let
 * a caller silently keep the palette-blind behaviour that let an off-palette
 * draft reach the renderer, where `palette.colors[i]` is `undefined`.
 */
export function normalize(
  rows: string[],
  w: number,
  h: number,
  paletteSize: number,
) {
  const grid: Grid = [];
  const repairedRows: number[] = [];
  let repairs = 0;

  for (let y = 0; y < h; y++) {
    const src = rows[y] ?? "";
    let out = "";
    let rowRepairs = 0;

    for (let x = 0; x < w; x++) {
      const c = src[x];
      if (c === undefined) {
        out += TRANSPARENT;
        rowRepairs++;
      } // too short
      else if (c === TRANSPARENT) {
        out += c;
      } // transparent is valid at every palette size
      else if (charIndex(c) >= 0 && charIndex(c) < paletteSize) {
        out += c;
      } // an index this palette actually has
      else {
        out += TRANSPARENT;
        rowRepairs++;
      } // invalid character, or an index past the palette (A4)
    }
    if (src.length > w) rowRepairs += src.length - w; // truncated

    if (rowRepairs > 0) repairedRows.push(y);
    repairs += rowRepairs;
    grid.push(out);
  }
  if (rows.length > h) repairs += (rows.length - h) * w; // extra rows dropped
  return { grid, repairs, repairedRows };
}

/** The character at `(x, y)`. Throws on coordinates the grid does not contain. */
export function getPixel(g: Grid, x: number, y: number): string {
  const h = g.length;
  const w = g[0]?.length ?? 0;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= w ||
    y >= h
  ) {
    throw new GridError("out-of-bounds", `(${x},${y}) outside ${w}x${h}`);
  }
  return g[y][x];
}

/**
 * Write one cell, returning a new grid.
 *
 * This is the chokepoint the Global Constraints require: agent and mouse click
 * hit this identical validation. `paletteSize` is passed in rather than read
 * from a doc so the function stays pure — a 4-colour `gameboy` sprite rejects
 * index 9 here, not three layers up.
 */
export function setPixel(
  g: Grid,
  x: number,
  y: number,
  ch: string,
  paletteSize: number,
): Grid {
  const h = g.length,
    w = g[0]?.length ?? 0;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= w ||
    y >= h
  )
    throw new GridError("out-of-bounds", `(${x},${y}) outside ${w}x${h}`);
  if (ch !== TRANSPARENT) {
    const i = charIndex(ch);
    if (i < 0) throw new GridError("bad-char", `'${ch}' is not '.' or 0-f`);
    if (i >= paletteSize)
      throw new GridError(
        "off-palette",
        `index ${i} exceeds palette size ${paletteSize}`,
      );
  }
  const next = g.slice();
  next[y] = g[y].slice(0, x) + ch + g[y].slice(x + 1);
  return next;
}

/**
 * The character check `setPixel` performs, for the other writers.
 *
 * `setPixel` keeps its checks inline because the plan pins its body verbatim;
 * this helper is spelled to match it exactly, message for message, and
 * `tests/shared/grid.test.ts` asserts the two agree.
 */
function assertChar(ch: string, paletteSize: number): void {
  if (ch === TRANSPARENT) return;
  const i = charIndex(ch);
  if (i < 0) throw new GridError("bad-char", `'${ch}' is not '.' or 0-f`);
  if (i >= paletteSize)
    throw new GridError(
      "off-palette",
      `index ${i} exceeds palette size ${paletteSize}`,
    );
}

/**
 * Fill `x0`..`x1` of row `y`, **inclusive of `x1`**, returning a new grid.
 *
 * Inclusive because the agent's `fill_row` tool speaks in cells it can see, not
 * in half-open intervals; `x0 === x1` writes exactly one pixel. A reversed
 * range is rejected rather than quietly normalized — a model that swapped its
 * arguments should be told so.
 */
export function fillRow(
  g: Grid,
  y: number,
  x0: number,
  x1: number,
  ch: string,
  paletteSize: number,
): Grid {
  const h = g.length;
  const w = g[0]?.length ?? 0;
  if (!Number.isInteger(y) || y < 0 || y >= h) {
    throw new GridError("out-of-bounds", `row ${y} outside ${w}x${h}`);
  }
  if (!Number.isInteger(x0) || !Number.isInteger(x1) || x0 < 0 || x1 >= w) {
    throw new GridError(
      "out-of-bounds",
      `span ${x0}..${x1} outside row width ${w}`,
    );
  }
  if (x0 > x1) {
    throw new GridError(
      "out-of-bounds",
      `span ${x0}..${x1} runs backwards; x1 is inclusive and must be >= x0`,
    );
  }
  assertChar(ch, paletteSize);

  const next = g.slice();
  next[y] = g[y].slice(0, x0) + ch.repeat(x1 - x0 + 1) + g[y].slice(x1 + 1);
  return next;
}

/**
 * Every cell where `a` and `b` disagree, in row-major order.
 *
 * Backs `Round.diffFromPrev`, and an empty result is the `empty-diff` stop
 * condition — the cheapest signal that a revise stage accomplished nothing.
 * Mismatched shapes throw instead of comparing an overlap: two grids of
 * different sizes are not two versions of one sprite, and returning a partial
 * answer would let that confusion reach the history file.
 */
export function diff(a: Grid, b: Grid): PixelDiff[] {
  if (a.length !== b.length) {
    throw new GridError(
      "out-of-bounds",
      `grids differ in height: ${a.length} vs ${b.length}`,
    );
  }
  const out: PixelDiff[] = [];
  for (let y = 0; y < a.length; y++) {
    const ra = a[y];
    const rb = b[y];
    if (ra.length !== rb.length) {
      throw new GridError(
        "out-of-bounds",
        `row ${y} differs in width: ${ra.length} vs ${rb.length}`,
      );
    }
    for (let x = 0; x < ra.length; x++) {
      if (ra[x] !== rb[x]) out.push({ x, y, from: ra[x], to: rb[x] });
    }
  }
  return out;
}
