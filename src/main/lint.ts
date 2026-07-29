/**
 * The deterministic half of the review system — spec §6.5.
 *
 * Spec §4.2 splits the review in two: the vision critic returns issue-level
 * findings with bounding regions, and this module produces genuine per-cell
 * findings. An orphan pixel is a *decidable* property — a cell whose four
 * orthogonal neighbours are all transparent — computable in microseconds with
 * zero hallucination risk, which is exactly what a 7B VLM looking at a
 * resampled thumbnail cannot give.
 *
 * Zero inference, zero I/O, no mutation of its argument. `lint()` runs on every
 * round, on every hand edit and inside the bench, so it stays a pure function of
 * the document it is handed.
 *
 * **There is no failure path** (ruling R3): `lint()` receives an
 * already-validated `SpriteDoc`, and amendment A4 made every structural
 * violation an `errors` field could have described unrepresentable before this
 * function is reached. Hence `LintReport` has no `errors` and §7.1's machine has
 * no `LINTING → FAILED` edge.
 *
 * **The palette comes off the document, never out of the registry.** `lint()`
 * reads `doc.palette.colors` and never calls `getPalette(doc.palette.id)` —
 * spec §6.2 snapshots the palette onto the document precisely so a saved sprite
 * renders standalone, and a registry lookup would throw on any document whose
 * palette is not bundled.
 */

import { TRANSPARENT, charIndex, type Grid } from "@shared/grid";
import type { LintReport, LintWarning, SpriteDoc } from "@shared/schema";

/** `[x, y]`, matching `LintWarning.cells`. */
type Cell = [number, number];

/**
 * Below this WCAG relative-luminance difference, two orthogonally adjacent
 * palette indices read as one shape rather than two — spec §6.5.
 *
 * `gameboy` indices 2 and 3 sit at Δ 0.0794 against it: a 0.8% margin, and the
 * canary for any change to `relativeLuminance` below.
 */
export const LOW_CONTRAST_THRESHOLD = 0.08;

/**
 * The character at `(x, y)`, treating everything outside the canvas as
 * transparent.
 *
 * Spec §6.5 defines `orphan-pixel` and `outline-gap` with "out-of-canvas counts
 * as transparent", but `shared/grid.ts`'s `getPixel` **throws** out of bounds —
 * and that is correct there, because a *mutation* outside the canvas is a bug
 * the agent needs told about. Leniency belongs to this reader alone, so it is
 * spelled here rather than added to `grid.ts`: a lenient `getPixel` would
 * silently swallow the out-of-range `place_pixel` calls Wave 8 exists to catch.
 */
function at(g: Grid, x: number, y: number): string {
  if (y < 0 || y >= g.length) return TRANSPARENT;
  const row = g[y];
  if (x < 0 || x >= row.length) return TRANSPARENT;
  return row[x];
}

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
 * Exported because Wave 4's `pickCriticBackground` needs the same figure — spec
 * §4.5 has it pick the background colour with maximum luminance distance from
 * the palette entries a sprite actually uses — and a second implementation of
 * this formula is the exact defect the paragraph above warns about.
 */
export function relativeLuminance(hex: string): number {
  const r = linearize(parseInt(hex.slice(1, 3), 16) / 255);
  const g = linearize(parseInt(hex.slice(3, 5), 16) / 255);
  const b = linearize(parseInt(hex.slice(5, 7), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** `pixel` / `pixels`, so a one-orphan message does not read as a typo. */
function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** One `low-contrast` pair under construction. */
interface Pair {
  i: number;
  j: number;
  cells: Cell[];
  /** Row-major cell keys already recorded, so a cell is listed once per pair. */
  seen: Set<number>;
}

/**
 * Deterministic checks over a sprite — spec §6.5's table, and nothing else.
 *
 * The five codes, their cardinality and their `cells`/`indices` contents are
 * fixed by that table. This implements it literally: no sixth code, no severity
 * ordering, no threshold the spec does not name.
 */
export function lint(doc: SpriteDoc): LintReport {
  const { w, h } = doc.size;
  const rows: Grid = doc.rows;
  const colors = doc.palette.colors;

  // One luminance per palette entry, computed once rather than per adjacency: a
  // 64×64 sprite has ~8k orthogonal pairs and only ever 16 colours.
  const luminance = colors.map(relativeLuminance);

  const orphans: Cell[] = [];
  const gaps: Cell[] = [];
  const used = new Set<number>();
  const pairs = new Map<string, Pair>();

  /** Non-transparent cells — `coverage`'s numerator and `symmetry`'s divisor. */
  let filled = 0;
  /** Non-transparent cells whose mirror about the vertical axis matches. */
  let mirrored = 0;

  // Row-major, so every `cells` array comes out in reading order without a
  // later sort — the dock renders these in sequence and the bench diffs them.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = at(rows, x, y);
      const i = charIndex(ch);

      if (i < 0) {
        // Transparent. Only a transparent cell can be an outline gap: a hole in
        // a silhouette, with the shape continuing on both sides of it.
        const left = charIndex(at(rows, x - 1, y)) >= 0;
        const right = charIndex(at(rows, x + 1, y)) >= 0;
        const above = charIndex(at(rows, x, y - 1)) >= 0;
        const below = charIndex(at(rows, x, y + 1)) >= 0;
        if ((left && right) || (above && below)) gaps.push([x, y]);
        continue;
      }

      filled++;
      used.add(i);
      // Mirror about the vertical centre axis. A transparent mirror counts as a
      // mismatch, which is what makes a one-sided sprite score near zero.
      if (at(rows, w - 1 - x, y) === ch) mirrored++;

      let attached = false;
      /** The four orthogonal neighbours, in reading order. */
      const neighbours: Cell[] = [
        [x, y - 1],
        [x - 1, y],
        [x + 1, y],
        [x, y + 1],
      ];

      for (const [nx, ny] of neighbours) {
        const j = charIndex(at(rows, nx, ny));
        if (j < 0) continue; // transparent — and out-of-canvas reads the same

        // Any non-transparent orthogonal neighbour rescues the cell from
        // orphanhood. A diagonal one does not: spec §6.5 is explicit, and it is
        // the definition's sharpest edge.
        attached = true;

        // Spec §6.5: a pair is two **distinct** indices. `i === j` has
        // Δ luminance 0, so without this guard every filled sprite reports
        // low-contrast against itself — a solid block would fire on hundreds of
        // adjacencies while being the cleanest sprite in the suite.
        if (j === i) continue;

        const lo = Math.min(i, j);
        const hi = Math.max(i, j);
        // Unreachable on a validated document — `SpriteDocSchema` refuses an
        // index past the palette — but an undefined luminance would make the
        // comparison below `NaN >= threshold`, i.e. `false`, and report a pair
        // that does not exist. Guarded rather than trusted.
        if (luminance[lo] === undefined || luminance[hi] === undefined) continue;
        if (Math.abs(luminance[lo] - luminance[hi]) >= LOW_CONTRAST_THRESHOLD) {
          continue;
        }

        const key = `${lo},${hi}`;
        let pair = pairs.get(key);
        if (pair === undefined) {
          pair = { i: lo, j: hi, cells: [], seen: new Set<number>() };
          pairs.set(key, pair);
        }
        // One warning per index pair, not per adjacency — and one entry per
        // cell, so a cell touching the other index on two sides is listed once.
        const cellKey = y * w + x;
        if (!pair.seen.has(cellKey)) {
          pair.seen.add(cellKey);
          pair.cells.push([x, y]);
        }
      }

      if (!attached) orphans.push([x, y]);
    }
  }

  // Emitted in spec §6.5's table order. Warning order is not part of the
  // contract, but a stable one keeps `SessionHistory` diffable between rounds.
  const warnings: LintWarning[] = [];

  // One warning total, listing every orphan cell. `indices` is absent: an
  // orphan is a fact about a position, not about a colour.
  if (orphans.length > 0) {
    warnings.push({
      code: "orphan-pixel",
      cells: orphans,
      message:
        `${orphans.length} orphan ${plural(orphans.length, "pixel")} — ` +
        `non-transparent ${plural(orphans.length, "cell")} whose four ` +
        `orthogonal neighbours are all transparent`,
    });
  }

  // Likewise one warning total, listing every gap cell.
  if (gaps.length > 0) {
    warnings.push({
      code: "outline-gap",
      cells: gaps,
      message:
        `${gaps.length} outline ${plural(gaps.length, "gap")} — ` +
        `transparent ${plural(gaps.length, "cell")} with non-transparent ` +
        `cells on opposite sides`,
    });
  }

  // Sorted by index pair so the dock lists them predictably; insertion order
  // would depend on where in the sprite each pair first happened to appear.
  const orderedPairs = [...pairs.values()].sort((a, b) =>
    a.i === b.i ? a.j - b.j : a.i - b.i,
  );
  for (const pair of orderedPairs) {
    const delta = Math.abs(luminance[pair.i] - luminance[pair.j]);
    warnings.push({
      code: "low-contrast",
      cells: pair.cells,
      indices: [pair.i, pair.j],
      message:
        `palette indices ${pair.i} (${colors[pair.i]}) and ${pair.j} ` +
        `(${colors[pair.j]}) are orthogonally adjacent but differ in relative ` +
        `luminance by only ${delta.toFixed(4)} (threshold ` +
        `${LOW_CONTRAST_THRESHOLD}) — ${pair.cells.length} ` +
        `${plural(pair.cells.length, "cell")} affected`,
    });
  }

  // Against the palette *this document carries*, not the 16-entry encoding
  // ceiling: a 4-colour `gameboy` sprite has four entries to account for, and
  // indices 4-15 name colours no row of it could reference.
  for (let i = 0; i < colors.length; i++) {
    if (used.has(i)) continue;
    warnings.push({
      code: "unused-palette-entry",
      cells: [],
      indices: [i],
      message: `palette index ${i} (${colors[i]}) never appears in the sprite`,
    });
  }

  // Knowable only from `meta`: once `normalize` has padded a short row, the
  // result is indistinguishable from a row the model got right (spec §6.2).
  for (const y of doc.meta.repairedRows) {
    warnings.push({
      code: "row-repaired",
      cells: Array.from({ length: w }, (_, x): Cell => [x, y]),
      message: `row ${y} was repaired while parsing the draft (spec §6.3)`,
    });
  }

  return {
    warnings,
    metrics: {
      coverage: filled / (w * h),
      paletteUsed: used.size,
      orphanCount: orphans.length,
      // **A sprite with no non-transparent cells scores 1** (spec §6.5) — a
      // blank canvas is trivially symmetric. Without this the fraction is
      // `0/0 = NaN`, which fails `LintReportSchema`'s 0..1 bound and serializes
      // to `null`, surfacing as an opaque round-trip failure two stages from
      // its cause. It is reachable: a model returning 16 rows of dots lands
      // here with `repairs === 0`, so nothing upstream rejects it.
      symmetryScore: filled === 0 ? 1 : mirrored / filled,
    },
  };
}
