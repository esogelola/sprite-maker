/**
 * Hand-built `SpriteDoc` fixtures — spec §6.2, §6.5.
 *
 * Two rules govern this file, and both exist because breaking either produces a
 * failure that points somewhere other than its cause.
 *
 * **1. Every fixture is the return value of `SpriteDocSchema.parse(...)` called
 * on an untyped object literal — never a bare type annotation on the literal
 * itself.** `SpriteDocSchema`'s row-count, row-width and off-palette checks live
 * in a `superRefine`, which is runtime-only. A fixture declared against the
 * inferred document type type-checks while silently bypassing every one of
 * them, so `lint()` would then be pinned against documents production can never
 * hand it. Parsing here means a malformed fixture fails at module load, loudly,
 * with the offending row named.
 *
 * **2. Every fixture's `meta.round` is `1`, not `0`.** Wave 2d tightened
 * `SpriteDoc.meta.round` to `positive()` because spec §7.5 pins the draft as
 * round 1. These are `parse` calls evaluated at import time, so a literal
 * carrying `round: 0` throws before a single test runs and surfaces as the whole
 * suite failing to collect.
 *
 * **Contrived palettes are inlined deliberately.** `test-struct` and
 * `test-contrast` are not bundled, so `getPalette(doc.palette.id)` throws on
 * them. That is the point: `lint()` must read `doc.palette.colors` and never
 * reach for the registry, and these fixtures are what makes the difference
 * observable rather than a matter of code reading.
 */

import { SpriteDocSchema } from "@shared/schema";

// ---------------------------------------------------------------------------
// palettes
// ---------------------------------------------------------------------------

/**
 * The real `gameboy` ramp (spec §6.1a), inlined rather than imported so a
 * fixture reads as a self-contained document.
 *
 * `tests/main/lint.test.ts` pins these values against `getPalette("gameboy")`,
 * so the copy cannot drift from the library without a test saying so.
 *
 * Its luminance structure is what makes it the linter's canary:
 * `0 ↔ 1` is Δ 0.0661 and `2 ↔ 3` is Δ 0.0794 — both under the 0.08
 * `low-contrast` threshold, the latter by 0.8%. Every other pair clears it.
 */
export const GAMEBOY_REF = {
  id: "gameboy",
  colors: [
    "#0f380f", // 0  darkest   L 0.029644
    "#306230", // 1  dark      L 0.095771
    "#8bac0f", // 2  light     L 0.350285
    "#9bbc0f", // 3  lightest  L 0.429695
  ],
};

/** The real `pico-8` palette (spec §6.1a), inlined for the same reason. */
export const PICO_8_REF = {
  id: "pico-8",
  colors: [
    "#000000", // 0  black
    "#1d2b53", // 1  dark blue
    "#7e2553", // 2  dark purple
    "#008751", // 3  dark green
    "#ab5236", // 4  brown
    "#5f574f", // 5  dark grey
    "#c2c3c7", // 6  light grey
    "#fff1e8", // 7  white
    "#ff004d", // 8  red
    "#ffa300", // 9  orange
    "#ffec27", // a  yellow
    "#00e436", // b  green
    "#29adff", // c  blue
    "#83769c", // d  lavender
    "#ff77a8", // e  pink
    "#ffccaa", // f  light peach
  ],
};

/**
 * A contrived 4-colour palette with **no** low-contrast pair, so the structural
 * fixtures below exercise `orphan-pixel` and `outline-gap` without dragging
 * `low-contrast` noise along with them.
 *
 * Deltas: 0↔1 0.2126, 0↔2 0.7152, 0↔3 1.0000, 1↔2 0.5026, 1↔3 0.7874,
 * 2↔3 0.2848 — every one clear of the 0.08 threshold.
 */
export const STRUCT_PALETTE_REF = {
  id: "test-struct",
  colors: [
    "#000000", // 0  L 0.000000
    "#ff0000", // 1  L 0.212600
    "#00ff00", // 2  L 0.715200
    "#ffffff", // 3  L 1.000000
  ],
};

/**
 * A contrived 4-colour palette carrying **exactly one** low-contrast pair,
 * `2 ↔ 3` at Δ 0.0204. Every other pair clears 0.08 comfortably, so a
 * `low-contrast` warning on a fixture using this palette can only be `[2, 3]`.
 */
export const CONTRAST_PALETTE_REF = {
  id: "test-contrast",
  colors: [
    "#000000", // 0  L 0.000000
    "#ffffff", // 1  L 1.000000
    "#767676", // 2  L 0.181164
    "#7c7c7c", // 3  L 0.201556
  ],
};

/**
 * A contrived 4-colour palette whose indices **1, 2 and 3 are pairwise
 * sub-threshold**: 1↔2 Δ 0.0204, 1↔3 Δ 0.0421, 2↔3 Δ 0.0217. Index 0 clears all
 * three comfortably (Δ 0.18 and up), so it can sit in a sprite without joining
 * a pair.
 *
 * `CONTRAST_PALETTE_REF` carries exactly one low-contrast pair by construction,
 * which makes every fixture built on it blind to how `lint()` *orders* multiple
 * pairs. Three mutually-conflicting greys produce three pairs of which two share
 * an `i`, and that is the only shape that reaches the secondary comparator.
 *
 * Not exotic: spec amendment A6 records fifteen sub-threshold index pairs in
 * `pico-8` alone, so a real sprite routinely puts one index in contact with two
 * others it cannot be told apart from.
 */
export const TRIPLE_CONTRAST_PALETTE_REF = {
  id: "test-triple",
  colors: [
    "#000000", // 0  L 0.000000
    "#767676", // 1  L 0.181164
    "#7c7c7c", // 2  L 0.201556
    "#828282", // 3  L 0.223228
  ],
};

// ---------------------------------------------------------------------------
// row helpers
// ---------------------------------------------------------------------------

/** `n` transparent cells. */
const dots = (n: number) => ".".repeat(n);

/** An `n`×`n` fully transparent canvas. */
const blankRows = (n: number) => Array.from({ length: n }, () => dots(n));

/** `count` identical rows of `w` cells, all holding `ch`. */
const band = (ch: string, count: number, w: number) =>
  Array.from({ length: count }, () => ch.repeat(w));

/**
 * An `n`×`n` transparent canvas with `cells` — `[x, y, char]` triples — painted
 * onto it.
 *
 * The 32×32 and 64×64 border fixtures below carry findings on all four edges at
 * once, and sixty-four rows of sixty-four characters *hide* a one-column
 * transposition rather than expose it. A coordinate list says `(0, 22)` in the
 * same `(x, y)` vocabulary the `cells` array of a `LintWarning` uses, so the
 * fixture and the assertion it backs can be read against each other directly.
 *
 * Row literals stay the rule for the 16×16 fixtures: at that size the picture
 * *is* the argument, and a coordinate list would hide the shape.
 */
const canvas = (
  n: number,
  cells: ReadonlyArray<readonly [number, number, string]>,
): string[] => {
  const rows = blankRows(n);
  for (const [x, y, ch] of cells) {
    rows[y] = rows[y].slice(0, x) + ch + rows[y].slice(x + 1);
  }
  return rows;
};

/**
 * The invariant half of a `SpriteDoc` literal.
 *
 * Returns `Record<string, unknown>` rather than a typed shape on purpose: the
 * value is destined for `SpriteDocSchema.parse`, and typing it here would start
 * re-introducing the compile-time-only guarantees rule 1 exists to refuse.
 */
function base(id: string, prompt: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    createdAt: "2026-07-29T00:00:00.000Z",
    prompt,
    intent: { subject: prompt },
    meta: {
      generatorModel: "qwen3:8b",
      criticModel: "qwen3-vl:8b-instruct-q4_K_M",
      // 1, never 0 — see rule 2 in this file's header.
      round: 1,
      repairs: 0,
      repairedRows: [],
      parentId: null,
    },
  };
}

// ---------------------------------------------------------------------------
// the warning-free sprite
// ---------------------------------------------------------------------------

/**
 * 16×16 on `gameboy`, four horizontal bands in index order **0, 2, 1, 3**.
 * The one shape in this file that yields **zero warnings of every code**.
 *
 * "Zero warnings" is a property of the palette *and* the sprite. All four
 * indices appear, so nothing is unused; the canvas is fully opaque, so there is
 * no orphan and no gap; `repairedRows` is empty; and the band order places only
 * clear-contrast pairs in contact — 0↔2 Δ 0.3206, 2↔1 Δ 0.2545, 1↔3 Δ 0.3339 —
 * while keeping `gameboy`'s two sub-threshold pairs (0↔1 and 2↔3) apart.
 *
 * A 16-colour palette could not do this: every bundled 16-entry palette carries
 * 15–25 low-contrast pairs, and a sprite using all sixteen indices necessarily
 * puts some of them side by side.
 *
 * Its hundreds of same-index adjacencies are also the check on `low-contrast`'s
 * `i < j` guard: without it, every one of them reports Δ 0 against itself.
 */
export const SOLID_BLOCK = SpriteDocSchema.parse({
  ...base("fx-solid-block", "four flat bands"),
  size: { w: 16, h: 16 },
  palette: GAMEBOY_REF,
  rows: [
    ...band("0", 4, 16),
    ...band("2", 4, 16),
    ...band("1", 4, 16),
    ...band("3", 4, 16),
  ],
});

// ---------------------------------------------------------------------------
// degenerate canvases
// ---------------------------------------------------------------------------

/**
 * 16×16 of nothing. The `symmetryScore` divide-by-zero case: with no
 * non-transparent cells the fraction is `0/0`, and a naive implementation
 * returns `NaN`, which fails `LintReportSchema`'s 0..1 bound and serializes to
 * `null` — an opaque round-trip failure two stages from its cause. Spec §6.5
 * rules a blank canvas trivially symmetric, so this scores **1**.
 *
 * Reachable in production: a model that returns 16 rows of dots lands here with
 * `repairs === 0`, so nothing upstream rejects it.
 */
export const BLANK = SpriteDocSchema.parse({
  ...base("fx-blank", "an empty canvas"),
  size: { w: 16, h: 16 },
  palette: GAMEBOY_REF,
  rows: blankRows(16),
});

// ---------------------------------------------------------------------------
// orphan-pixel
// ---------------------------------------------------------------------------

/**
 * A solid 4×4 block at (2,2)–(5,5) plus one isolated cell at **(12, 12)**.
 * Exactly one orphan; every block cell has an orthogonal neighbour.
 */
export const ONE_ORPHAN = SpriteDocSchema.parse({
  ...base("fx-one-orphan", "a block and a stray pixel"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "................", //  0
    "................", //  1
    "..1111..........", //  2
    "..1111..........", //  3
    "..1111..........", //  4
    "..1111..........", //  5
    "................", //  6
    "................", //  7
    "................", //  8
    "................", //  9
    "................", // 10
    "................", // 11
    "............1...", // 12
    "................", // 13
    "................", // 14
    "................", // 15
  ],
});

/**
 * Two cells touching only at a corner: (4,4) and (5,5).
 *
 * The sharp edge in spec §6.5's definition — orphanhood is decided on the
 * **four orthogonal** neighbours, so diagonal attachment does not rescue a
 * cell. Both are orphans, and an implementation scanning eight neighbours
 * reports neither.
 */
export const DIAGONAL_ONLY = SpriteDocSchema.parse({
  ...base("fx-diagonal-only", "two diagonally touching pixels"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "................", //  0
    "................", //  1
    "................", //  2
    "................", //  3
    "....1...........", //  4
    ".....1..........", //  5
    "................", //  6
    "................", //  7
    "................", //  8
    "................", //  9
    "................", // 10
    "................", // 11
    "................", // 12
    "................", // 13
    "................", // 14
    "................", // 15
  ],
});

/**
 * A single cell at (0, 0), hard against two canvas edges.
 *
 * The lenient-neighbour fixture. Deciding this cell requires reading (-1, 0)
 * and (0, -1), and `shared/grid.ts`'s `getPixel` **throws** there — correctly,
 * since a mutation outside the canvas is a bug. Spec §6.5 says out-of-canvas
 * counts as transparent for `orphan-pixel` and `outline-gap`, so `lint()` needs
 * its own lenient reader; a linter built on `getPixel` throws on this fixture
 * rather than reporting the orphan.
 */
export const CORNER_PIXEL = SpriteDocSchema.parse({
  ...base("fx-corner-pixel", "one pixel in the top-left corner"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: ["1..............."].concat(blankRows(16).slice(1)),
});

/**
 * A single cell at **(7, 15)** — the bottom row.
 *
 * `CORNER_PIXEL` pins (0, 0) because the canvas edges are where a scan goes
 * wrong, and the *low* edges were the only ones it pinned: every other orphan in
 * this file sits at (12, 12), (4, 4) or (5, 5). A row loop written `y < h - 1`
 * — an off-by-one that reads as deliberate next to the `y + 1` neighbour lookup
 * beside it — drops this orphan and nothing else in the suite notices. A stray
 * pixel on the bottom row is ordinary `qwen3` output, and spec §11's headline
 * quality bar is "no orphans, no outline gaps".
 */
export const BOTTOM_ROW_ORPHAN = SpriteDocSchema.parse({
  ...base("fx-bottom-row-orphan", "one stray pixel on the bottom row"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [...blankRows(16).slice(0, 15), ".......1........"],
});

/**
 * A single cell at **(15, 7)** — the last column, and the other axis of the
 * same defect: a column loop written `x < w - 1` drops it while every
 * mid-canvas orphan above still reports.
 */
export const LAST_COLUMN_ORPHAN = SpriteDocSchema.parse({
  ...base("fx-last-column-orphan", "one stray pixel in the last column"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    ...blankRows(16).slice(0, 7),
    "...............1", //  7
    ...blankRows(16).slice(8),
  ],
});

/**
 * One cell in **each** of the four corners: (0,0), (15,0), (0,15), (15,15).
 *
 * Three of those four positions appear nowhere else in this file, and the
 * fixture buys two things a single corner cannot.
 *
 * It is the only fixture that catches a **wrapped** attachment test. Deciding
 * (0,0) means reading (-1,0) and (0,-1), and the usual way an out-of-bounds
 * crash gets "fixed" is `rows[(y + 1) % h][(x + 1) % w]`. That satisfies
 * `CORNER_PIXEL` — (0,0)'s wrapped neighbours (15,0) and (0,15) are transparent
 * there — and it satisfies `BOTTOM_ROW_ORPHAN` and `LAST_COLUMN_ORPHAN` for the
 * same reason. Here the wrapped neighbours are filled, so a wrapping
 * implementation reports **no** orphan at all, on all four cells.
 *
 * It also pins the emission order at the extremes: `cells` is row-major, so
 * (15,0) precedes (0,15) — the two positions an implementation ordering by
 * column, or by distance from the origin, swaps.
 */
export const FOUR_CORNERS = SpriteDocSchema.parse({
  ...base("fx-four-corners", "one pixel in each corner"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "1..............1", //  0
    ...blankRows(16).slice(1, 15),
    "1..............1", // 15
  ],
});

/**
 * Eight isolated cells: one in each corner **and** one in the middle of each
 * edge — (0,0), (7,0), (15,0), (0,7), (15,7), (0,15), (7,15), (15,15).
 *
 * `CORNER_PIXEL`, `BOTTOM_ROW_ORPHAN`, `LAST_COLUMN_ORPHAN` and `FOUR_CORNERS`
 * each pin *a* border cell; this pins **the border**. The four mid-edge
 * positions matter because a corner is on two edges at once: a scan that drops
 * only column 0 still reports (0,0) if it also reports (15,0), and a `cells`
 * array of four corner positions cannot say which edge went missing. With a
 * mid-edge cell on every side, dropping any one of the four borders changes the
 * `cells` array in a way that names the border that was dropped.
 *
 * It is also the only fixture where **every** filled cell is an orphan, which
 * is what pins `paletteUsed` against an implementation that counts a colour
 * only once it has seen it on an *attached* cell. And its metrics are chosen to
 * separate the four borders numerically: `coverage` 8/256 and `symmetryScore`
 * 6/8 = 0.75 — the mid-edge cells at x = 7 mirror onto transparency and the
 * other six mirror onto each other. Skipping the top or bottom border gives
 * 4/5 = 0.8, skipping either column gives 3/5 = 0.6, and skipping the corners
 * alone gives 2/4 = 0.5. No two of those collide.
 */
export const BORDER_ORPHANS = SpriteDocSchema.parse({
  ...base("fx-border-orphans", "a stray pixel on every edge and corner"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "1......1.......1", //  0
    ...blankRows(16).slice(1, 7),
    "1..............1", //  7
    ...blankRows(16).slice(8, 15),
    "1......1.......1", // 15
  ],
});

// ---------------------------------------------------------------------------
// outline-gap
// ---------------------------------------------------------------------------

/**
 * A four-cell horizontal bar with a one-cell hole at **(6, 8)**: filled at
 * x = 4, 5 and 7, 8.
 *
 * Nothing sits above or below the bar, so the only way to find this gap is the
 * left/right test. The bar's own end cells are *not* orphans (each touches its
 * partner), and the transparent cells outside the bar are *not* gaps — (3,8)
 * has filled cells only to its right, and the out-of-canvas side of a cell
 * counts as transparent, never as filled.
 */
export const HORIZONTAL_GAP = SpriteDocSchema.parse({
  ...base("fx-horizontal-gap", "a bar with a hole in it"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    ...blankRows(16).slice(0, 8),
    "....11.11.......", //  8
    ...blankRows(16).slice(9),
  ],
});

/**
 * The same defect turned ninety degrees: column 8 filled at y = 4, 5 and 7, 8
 * with a one-cell hole at **(8, 6)**. Only the above/below test finds it.
 */
export const VERTICAL_GAP = SpriteDocSchema.parse({
  ...base("fx-vertical-gap", "a column with a hole in it"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "................", //  0
    "................", //  1
    "................", //  2
    "................", //  3
    "........1.......", //  4
    "........1.......", //  5
    "................", //  6  ← the gap
    "........1.......", //  7
    "........1.......", //  8
    "................", //  9
    "................", // 10
    "................", // 11
    "................", // 12
    "................", // 13
    "................", // 14
    "................", // 15
  ],
});

/**
 * `HORIZONTAL_GAP` moved to the **bottom row**: row 15 filled at x = 4, 5 and
 * 7, 8, with the hole at **(6, 15)**.
 *
 * Both existing gap fixtures sit at y = 8 and x = 8, so a scan that stops one
 * row short reports every gap in this file except this one. A hole in the
 * bottom edge of a silhouette — a character's feet — is exactly the defect the
 * critic loop exists to catch.
 */
export const BOTTOM_ROW_GAP = SpriteDocSchema.parse({
  ...base("fx-bottom-row-gap", "a bar with a hole in it on the bottom row"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [...blankRows(16).slice(0, 15), "....11.11......."],
});

/**
 * The remaining three edges in one sprite: a horizontal gap at **(6, 0)** on
 * row 0, and vertical gaps at **(0, 6)** and **(15, 6)** in the first and last
 * columns.
 *
 * `HORIZONTAL_GAP` and `VERTICAL_GAP` place their holes mid-canvas, and
 * `BOTTOM_ROW_GAP` covers the fourth edge, so together with this fixture every
 * boundary of the canvas carries a gap that some `cells` array names. Rows 0/15
 * and columns 0/15 are four independently-losable loop bounds; asserting all
 * three of these in one `cells` array also pins the row-major emission order
 * across a mixture of edges — (6,0) before (0,6) before (15,6).
 *
 * Nothing here is an orphan: each of the sixteen filled cells has an orthogonal
 * partner, so the fixture doubles as a check that a filled cell hard against an
 * edge is not mistaken for one.
 *
 * The last two pairs are **probes for the high borders**, and they are the
 * reason the gap list is asserted exactly rather than by membership.
 * `(13,10)–(14,10)` leaves (15,10) transparent with a filled cell on its left
 * and nothing but the canvas edge on its right; `(11,13)–(11,14)` leaves
 * (11,15) transparent with a filled cell above it and the edge below. Spec §6.5
 * counts both edges as transparent, so neither is a gap — but an implementation
 * reading past the canvas as *filled* (the "the shape is clipped here, so it
 * continues" reading) invents one at each. `CORNER_PIXEL` covers only the
 * x = −1 and y = −1 half of that mistake.
 */
export const EDGE_GAPS = SpriteDocSchema.parse({
  ...base("fx-edge-gaps", "holes in the top row and both edge columns"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "....11.11.......", //  0  ← gap at (6, 0)
    "................", //  1
    "................", //  2
    "................", //  3
    "1..............1", //  4
    "1..............1", //  5
    "................", //  6  ← gaps at (0, 6) and (15, 6)
    "1..............1", //  7
    "1..............1", //  8
    "................", //  9
    ".............11.", // 10  ← probe: (15,10) is not a gap
    "................", // 11
    "................", // 12
    "...........1....", // 13
    "...........1....", // 14  ← probe: (11,15) is not a gap
    "................", // 15
  ],
});

/**
 * A solid 14×14 block inset **one pixel from every edge** — the whole border
 * ring is transparent and every ring cell has the canvas edge on one side and
 * the block on the other.
 *
 * This is the fixture for the leniency contract as a whole, and it is what
 * `CORNER_PIXEL` could never be. A gap needs non-transparent cells on
 * **opposite** sides, so a cell whose only filled neighbour is the block is a
 * gap exactly when the implementation counts the *out-of-canvas* side as
 * filled. Every one of the four mistakes therefore shows up here, on fourteen
 * cells each rather than on one:
 *
 * - out-of-canvas left counts as filled → 14 invented gaps down column 0;
 * - out-of-canvas above → 14 across row 0;
 * - right → column 15; below → row 15.
 *
 * The four corners stay silent under all four mutations — (0,0)'s in-canvas
 * neighbours (1,0) and (0,1) are both transparent — so the fixture separates
 * "reads past the canvas as filled" from "reports the corners wrongly".
 *
 * A one-pixel margin is not a contrivance: it is what a generator produces
 * whenever it centres a 14-wide subject on a 16-wide canvas.
 */
export const ONE_PIXEL_MARGIN = SpriteDocSchema.parse({
  ...base("fx-one-pixel-margin", "a block inset one pixel from every edge"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "................", //  0
    ...Array.from({ length: 14 }, () => `.${"1".repeat(14)}.`), // 1-14
    "................", // 15
  ],
});

/**
 * Four gaps whose flanks are **one cell thick**: a horizontal pair at (3,6) and
 * (3,7) with single-column bars either side, and a vertical pair at (8,11) and
 * (9,11) with single-row bars above and below.
 *
 * Every other gap fixture flanks its hole with a bar **two or more cells long**
 * in the direction of the test, so `at(x - 1, y)` and `at(x - 2, y)` are both
 * filled and the two are indistinguishable. That makes the whole file blind to
 * an implementation that reads the wrong offset — `left` two cells out rather
 * than one — which finds every gap this suite otherwise contains and none of
 * the gaps in this one.
 *
 * The same thickness is what pins the **orphan** neighbour offsets: each of the
 * eight filled cells here has exactly one orthogonal partner, immediately
 * adjacent, so reading a neighbour one cell further out turns all eight into
 * orphans. The bars are laid at right angles to their hole — the horizontal
 * hole's flanks are vertical pairs, the vertical hole's flanks are horizontal
 * pairs — so the gap and the attachment are decided on different axes and a
 * mutation to either shows up alone.
 */
export const SINGLE_CELL_FLANKS = SpriteDocSchema.parse({
  ...base("fx-single-cell-flanks", "holes with one-cell-thick flanks"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "................", //  0
    "................", //  1
    "................", //  2
    "................", //  3
    "................", //  4
    "................", //  5
    "..1.2...........", //  6  ← gap at (3, 6); flanks are one column wide
    "..1.2...........", //  7  ← gap at (3, 7)
    "................", //  8
    "................", //  9
    "........12......", // 10
    "................", // 11  ← gaps at (8, 11) and (9, 11); flanks one row tall
    "........21......", // 12
    "................", // 13
    "................", // 14
    "................", // 15
  ],
});

/**
 * Six gaps whose two flanks hold **different** palette indices, spread over
 * both orientations and all four borders:
 *
 * - (6, 0)  — horizontal, top row, `2` left and `3` right
 * - (0, 5)  — vertical, first column, `1` above and `2` below
 * - (15, 5) — vertical, last column, `3` above and `0` below
 * - (11, 11) — vertical, mid-canvas, `1` above and `0` below
 * - (4, 12) — horizontal, mid-canvas, `2` left and `0` right
 * - (6, 15) — horizontal, bottom row, `0` left and `1` right
 *
 * Every other gap fixture in this file flanks its hole with the *same* index —
 * `HORIZONTAL_GAP` uses `1` on both sides, `EDGE_GAPS` likewise — so all of
 * them survive an implementation that requires the flanks to match before
 * calling the hole a gap. Spec §6.5 says "non-transparent cells on opposite
 * sides" and says nothing about their colours, and the mismatched case is the
 * *common* one: a gap in an outline where the outline meets the fill has an
 * outline index on one side and a fill index on the other.
 *
 * Four index pairs are used rather than one so a mutation keyed to a particular
 * pair has nowhere to hide, and the two mid-canvas holes keep the fixture from
 * conflating "mismatched flanks" with "on a border".
 *
 * Nothing here is an orphan — every filled cell is half of a two-cell bar — and
 * `test-struct` has no sub-threshold pair, so the report is gaps and nothing
 * else.
 */
export const MISMATCHED_FLANK_GAPS = SpriteDocSchema.parse({
  ...base("fx-mismatched-flank-gaps", "holes flanked by two different colours"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "....22.33.......", //  0  ← gap at (6, 0), flanked 2 | 3
    "................", //  1
    "................", //  2
    "1..............3", //  3
    "1..............3", //  4
    "................", //  5  ← gaps at (0, 5) flanked 1|2 and (15, 5) flanked 3|0
    "2..............0", //  6
    "2..............0", //  7
    "................", //  8
    "...........1....", //  9
    "...........1....", // 10
    "................", // 11  ← gap at (11, 11), flanked 1 | 0
    "..22.00....0....", // 12  ← gap at (4, 12), flanked 2 | 0
    "...........0....", // 13
    "................", // 14
    "....00.11.......", // 15  ← gap at (6, 15), flanked 0 | 1
  ],
});

// ---------------------------------------------------------------------------
// low-contrast
// ---------------------------------------------------------------------------

/**
 * Two cells, indices 2 and 3 of `test-contrast`, orthogonally adjacent at
 * (7, 8) and (8, 8). Δ luminance 0.0204 — one warning, `indices: [2, 3]`, both
 * cells listed.
 *
 * Every other cell is transparent, which is also the fixture's second job:
 * `charIndex('.')` is `-1`, so a luminance lookup that does not exclude
 * transparent neighbours reads `colors[-1]`, gets `undefined`, and crashes in
 * the hex parser.
 */
export const LOW_CONTRAST_PAIR = SpriteDocSchema.parse({
  ...base("fx-low-contrast-pair", "two near-identical greys side by side"),
  size: { w: 16, h: 16 },
  palette: CONTRAST_PALETTE_REF,
  rows: [
    ...blankRows(16).slice(0, 8),
    ".......23.......", //  8
    ...blankRows(16).slice(9),
  ],
});

/**
 * **30** orthogonally adjacent 2↔3 pairs — 16 between rows 7 and 8, 14 between
 * rows 8 and 9 — which spec §6.5 says is still **one** warning, because the
 * cardinality is per index pair and not per adjacency.
 *
 * Its `cells` list carries all 46 cells that participate: rows 7 and 8 entire,
 * plus x = 0..13 of row 9.
 */
export const LOW_CONTRAST_MANY = SpriteDocSchema.parse({
  ...base("fx-low-contrast-many", "thirty adjacent low-contrast pairs"),
  size: { w: 16, h: 16 },
  palette: CONTRAST_PALETTE_REF,
  rows: [
    ...blankRows(16).slice(0, 7),
    "2222222222222222", //  7
    "3333333333333333", //  8
    "22222222222222..", //  9
    ...blankRows(16).slice(10),
  ],
});

/**
 * `SOLID_BLOCK`'s band order rotated to **0, 2, 3, 1**, which brings
 * `gameboy`'s 2 and 3 into contact.
 *
 * The formula canary. Δ(2, 3) is 0.0794 against a 0.08 threshold — a 0.8%
 * margin, and the first thing a rounded or re-derived relative-luminance
 * implementation loses. Exactly one `low-contrast` warning, `indices: [2, 3]`,
 * 32 cells (rows 7 and 8); the 0↔2 and 3↔1 contacts clear the threshold and are
 * silent.
 */
export const GAMEBOY_CANARY = SpriteDocSchema.parse({
  ...base("fx-gameboy-canary", "the gameboy 2/3 contrast canary"),
  size: { w: 16, h: 16 },
  palette: GAMEBOY_REF,
  rows: [
    ...band("0", 4, 16),
    ...band("2", 4, 16),
    ...band("3", 4, 16),
    ...band("1", 4, 16),
  ],
});

/**
 * `gameboy` indices 0 and 1 side by side on the **bottom row**: row 15 reads
 * `0011`, so the single 0↔1 contact is at (1, 15) and (2, 15). Δ luminance
 * 0.0661 — one warning, `indices: [0, 1]`, two cells.
 *
 * Every other `low-contrast` fixture puts its pair on rows 7–9, which is why
 * the pair spans two columns rather than two rows: a horizontal pair keeps both
 * participating cells *on* the edge being tested, where a vertical one would
 * leave half the evidence on row 14 and let a bottom-row-skipping scan still
 * report the warning with a shorter `cells` list.
 *
 * The pair is `0 ↔ 1` rather than `GAMEBOY_CANARY`'s `2 ↔ 3` because the two
 * leading same-index adjacencies — (0,15)↔(1,15) and (2,15)↔(3,15) — are then
 * on the edge as well, so the `i === j` guard is exercised at the boundary too.
 */
export const BOTTOM_ROW_CONTRAST = SpriteDocSchema.parse({
  ...base("fx-bottom-row-contrast", "a low-contrast pair on the bottom row"),
  size: { w: 16, h: 16 },
  palette: GAMEBOY_REF,
  rows: [...blankRows(16).slice(0, 15), "0011............"],
});

/** The same four cells on **row 0** — the opposite bound of the same loop. */
export const TOP_ROW_CONTRAST = SpriteDocSchema.parse({
  ...base("fx-top-row-contrast", "a low-contrast pair on the top row"),
  size: { w: 16, h: 16 },
  palette: GAMEBOY_REF,
  rows: ["0011............", ...blankRows(16).slice(1)],
});

/**
 * Eight `2 ↔ 3` contacts of `test-contrast`, one straddling **each corner** and
 * one in the middle of **each edge** — sixteen cells, still a single warning
 * because the cardinality is per index pair.
 *
 * `TOP_ROW_CONTRAST` and `BOTTOM_ROW_CONTRAST` pin two of the four borders and
 * neither of them puts a participating cell *in a corner*: their pairs sit at
 * x = 1 and x = 2. So an implementation that forms pairs everywhere except the
 * four corner cells reports both of them intact, and reports this fixture with
 * (0,0), (15,0), (0,15) and (15,15) missing from `cells`.
 *
 * The pairs on the left and right edges run **vertically** — (0,7)/(0,8) and
 * (15,7)/(15,8) — so that both members of each pair sit inside the column being
 * tested. A horizontal pair straddling column 0 would leave half its evidence
 * at x = 1, where a column-0-blind implementation still finds it and emits the
 * warning with a shorter `cells` list, which is the weaker assertion.
 *
 * `symmetryScore` is 12/16 = 0.75: the corner pairs mirror onto each other,
 * the two mid-edge pairs on rows 0 and 15 do not.
 */
export const BORDER_CONTRAST = SpriteDocSchema.parse({
  ...base("fx-border-contrast", "low-contrast pairs on every edge and corner"),
  size: { w: 16, h: 16 },
  palette: CONTRAST_PALETTE_REF,
  rows: [
    "23.....23.....32", //  0
    ...blankRows(16).slice(1, 7),
    "2..............2", //  7
    "3..............3", //  8
    ...blankRows(16).slice(9, 15),
    "23.....23.....32", // 15
  ],
});

/**
 * A 2×2 block at (7,7)–(8,8) reading `12` over `13`, on the three
 * mutually-sub-threshold greys of `test-triple`. **Three** low-contrast pairs —
 * (1,2), (1,3) and (2,3) — of which two share `i = 1`.
 *
 * `orderedPairs` sorts `a.i === b.i ? a.j - b.j : a.i - b.i`, and across every
 * other fixture in this file no sprite produces two pairs with the same `i`:
 * `SPRITE_32` yields (3,4) and (4,5), `SPRITE_64` yields five pairs with five
 * distinct `i`. So the equal-`i` branch of that comparator was dead to the whole
 * suite, and reversing it changed no assertion.
 *
 * Three pairwise-adjacent indices cannot be drawn with three cells — no square
 * lattice holds a triangle — so the fourth cell repeats index 1 diagonally
 * opposite itself. That also puts a same-index adjacency (7,7)↔(7,8) inside the
 * block, keeping the `i === j` guard under test here too.
 *
 * The insertion order of the pairs is (1,2), (2,3), (1,3) — the order the
 * row-major scan first meets them — and the sorted order is (1,2), (1,3),
 * (2,3). The two differ, so the fixture pins the sort itself as well as its
 * tie-break: an implementation that emits pairs in discovery order fails it,
 * and so does one that compares `b.j - a.j` when the `i`s match.
 */
export const TRIPLE_CONTRAST = SpriteDocSchema.parse({
  ...base("fx-triple-contrast", "three mutually indistinguishable greys"),
  size: { w: 16, h: 16 },
  palette: TRIPLE_CONTRAST_PALETTE_REF,
  rows: [
    ...blankRows(16).slice(0, 7),
    ".......12.......", //  7
    ".......13.......", //  8
    ...blankRows(16).slice(9),
  ],
});

// ---------------------------------------------------------------------------
// unused-palette-entry
// ---------------------------------------------------------------------------

/**
 * A hollow border ring in which **each palette index lives on exactly one
 * edge**: `1` along row 0, `0` down column 0, `3` down column 15, `2` along
 * row 15. All four corners are transparent, so no index is shared between two
 * edges.
 *
 * `unused-palette-entry` is populated cell by cell inside the same nested x/y
 * scan as `orphan-pixel` — `used.add(i)` sits two lines below `filled++` — so
 * it is exactly as geometry-dependent as the structural codes, and every one of
 * the four border-blind variants of that one line is invisible to the rest of
 * this file. Here each variant deletes a colour that is plainly present in
 * `rows` and emits a false `unused-palette-entry` for it:
 *
 * - a scan blind to row 0 loses index 1; to row 15, index 2;
 * - blind to column 0, index 0; to column 15, index 3.
 *
 * The correct report names **no** unused entry and `paletteUsed` 4.
 *
 * The transparent corners do a second job. (0,0) has a filled cell to its right
 * and another below it, and nothing but the canvas edge above and to its left —
 * so an implementation reading past the canvas as filled invents an
 * `outline-gap` there, and at the other three corners for the mirrored reason.
 * The correct report has no gaps at all.
 */
/**
 * Four isolated cells, one per corner, each holding a **different** palette
 * index: `0` at (0,0), `1` at (15,0), `2` at (0,15), `3` at (15,15).
 *
 * `FOUR_CORNERS` puts index 1 in all four corners, so an implementation that
 * misses exactly one of them still records the colour from the other three and
 * reports nothing. Here each corner is the sole home of its index, which turns
 * "a scan that misses one corner" from an invisible fault into a false
 * `unused-palette-entry` naming the corner that went missing. Four corners,
 * four indices, four independently observable failures.
 *
 * `symmetryScore` is 0: no corner mirrors onto a matching index. That is the
 * one number this fixture cannot pin, which is why it does not try.
 */
export const CORNER_PALETTE = SpriteDocSchema.parse({
  ...base("fx-corner-palette", "a different colour in each corner"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "0..............1", //  0
    ...blankRows(16).slice(1, 15),
    "2..............3", // 15
  ],
});

export const BORDER_PALETTE = SpriteDocSchema.parse({
  ...base("fx-border-palette", "one palette index on each edge of the canvas"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    ".11111111111111.", //  0
    ...Array.from({ length: 14 }, () => `0${dots(14)}3`), // 1-14
    ".22222222222222.", // 15
  ],
});

// ---------------------------------------------------------------------------
// symmetry
// ---------------------------------------------------------------------------

/**
 * A blob mirrored exactly about the vertical centre axis (x ↔ 15 − x).
 * `symmetryScore` 1.0 over 26 non-transparent cells.
 */
export const PERFECT_MIRROR = SpriteDocSchema.parse({
  ...base("fx-perfect-mirror", "a bilaterally symmetric blob"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "................", //  0
    "................", //  1
    "................", //  2
    "................", //  3
    "......1111......", //  4
    ".....112211.....", //  5
    ".....122221.....", //  6
    ".....112211.....", //  7
    "......1111......", //  8
    "................", //  9
    "................", // 10
    "................", // 11
    "................", // 12
    "................", // 13
    "................", // 14
    "................", // 15
  ],
});

/**
 * A block hugging the left edge, with a two-cell spur straddling the centre
 * axis at (7, 4) and (8, 4).
 *
 * 58 non-transparent cells, of which exactly the two spur cells mirror onto
 * each other: `symmetryScore` 2/58 ≈ 0.0345. Deliberately **not** zero — a
 * score of 0 is also what a stubbed-out implementation returns, and
 * `PERFECT_MIRROR` alone cannot tell the two apart.
 */
export const FULLY_ASYMMETRIC = SpriteDocSchema.parse({
  ...base("fx-fully-asymmetric", "a shape pushed hard to one side"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "................", //  0
    "................", //  1
    "................", //  2
    "................", //  3
    "111111111.......", //  4
    "1111111.........", //  5
    "1111111.........", //  6
    "1111111.........", //  7
    "1111111.........", //  8
    "1111111.........", //  9
    "1111111.........", // 10
    "1111111.........", // 11
    "................", // 12
    "................", // 13
    "................", // 14
    "................", // 15
  ],
});

// ---------------------------------------------------------------------------
// row-repaired
// ---------------------------------------------------------------------------

/**
 * A flat 16×16 fill whose `meta.repairedRows` names rows **3 and 9**.
 *
 * `row-repaired` is the one warning that cannot be derived from the grid: once
 * `normalize` has padded a short row, the result is indistinguishable from a
 * row the model got right, which is why spec §6.2 requires `repairedRows` to be
 * carried on the document at all. Two rows, two warnings, one per row.
 *
 * `meta.repairs` is 5 rather than 0 because a document claiming repaired rows
 * and zero repairs is incoherent — the pair is written together by `normalize`.
 */
export const ROW_REPAIRED = SpriteDocSchema.parse({
  ...base("fx-row-repaired", "a sprite whose rows 3 and 9 were repaired"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: band("1", 16, 16),
  meta: {
    generatorModel: "qwen3:8b",
    criticModel: "qwen3-vl:8b-instruct-q4_K_M",
    round: 1,
    repairs: 5,
    repairedRows: [3, 9],
    parentId: null,
  },
});

/**
 * Two bands with a **fully transparent row 5 between them**, and
 * `meta.repairedRows` naming **5 and 8** — one row with no non-transparent cell
 * at all, one ordinary filled row.
 *
 * This is what `normalize` actually produces. Spec §6.3 pads a short row and
 * substitutes a missing one, and the padding character is transparent, so the
 * common repaired row *is* the blank one. Spec §6.5 defines `row-repaired` as
 * one warning per entry in `repairedRows`, unconditionally — the code exists to
 * surface exactly this generator failure, and an implementation that skips a row
 * with nothing in it hides the worst case while reporting the mild one.
 *
 * Every other `row-repaired` fixture is fully opaque (`ROW_REPAIRED`,
 * `ROW_REPAIRED_32` and `ROW_REPAIRED_64` are all solid `band("1", …)` fills),
 * so nothing in the suite paired `repairedRows` with a blank row and the
 * suppression survived. Naming both kinds of row in one fixture is what makes
 * the difference observable: the warnings must be two, not one.
 *
 * Row 5 also produces twelve `outline-gap` cells at x = 2..13 — the hole a
 * repaired row leaves in a silhouette — which is why `row-repaired` is asserted
 * by code rather than against the whole report.
 */
export const BLANK_ROW_REPAIRED = SpriteDocSchema.parse({
  ...base("fx-blank-row-repaired", "a repaired row that came back empty"),
  size: { w: 16, h: 16 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    "................", //  0
    "................", //  1
    "..111111111111..", //  2
    "..111111111111..", //  3
    "..111111111111..", //  4
    "................", //  5  ← repaired, and entirely transparent
    "..111111111111..", //  6
    "..111111111111..", //  7
    "..111111111111..", //  8  ← repaired, and holds cells
    "..111111111111..", //  9
    "................", // 10
    "................", // 11
    "................", // 12
    "................", // 13
    "................", // 14
    "................", // 15
  ],
  meta: {
    generatorModel: "qwen3:8b",
    criticModel: "qwen3-vl:8b-instruct-q4_K_M",
    round: 1,
    repairs: 19,
    repairedRows: [5, 8],
    parentId: null,
  },
});

/**
 * The same warning at 32×32, with the repaired rows at the **first and last**
 * row of the canvas.
 *
 * Two things `ROW_REPAIRED` cannot pin on its own. A `row-repaired` warning
 * lists that row's cells, so its length must follow the canvas width — at
 * 16×16 a hard-coded 16 is indistinguishable from `size.w`. And rows 0 and 31
 * are where an implementation that trims or offsets the row range goes wrong.
 */
export const ROW_REPAIRED_32 = SpriteDocSchema.parse({
  ...base("fx-row-repaired-32", "a 32-wide sprite with two repaired rows"),
  size: { w: 32, h: 32 },
  palette: STRUCT_PALETTE_REF,
  rows: band("1", 32, 32),
  meta: {
    generatorModel: "qwen3:8b",
    criticModel: "qwen3-vl:8b-instruct-q4_K_M",
    round: 1,
    repairs: 41,
    repairedRows: [0, 31],
    parentId: null,
  },
});

// ---------------------------------------------------------------------------
// 32×32
// ---------------------------------------------------------------------------

/**
 * A 32×32 tree on `pico-8` — the only large fixture, and the one Wave 4 renders
 * to a golden PNG.
 *
 * Chosen for what a renderer test needs rather than for the linter: it carries
 * transparency (so a decoded cell can be checked for alpha 0), four palette
 * indices **including index 3**, adjacent cells of differing colour in every
 * direction (so a nearest-neighbour block of 256 identical sub-pixels is a real
 * assertion rather than a trivial one), and top/bottom asymmetry — a transposed
 * or row-major-confused renderer produces a visibly different image, which a
 * concentric or radially symmetric pattern would have hidden.
 *
 * Structurally clean: no orphans, no outline gaps, `symmetryScore` 1.0 about
 * the vertical axis, coverage 448/1024. It does carry two `low-contrast` pairs
 * — 3↔4 at Δ 0.0296 where the canopy outline meets the trunk, and 4↔5 at
 * Δ 0.0515 where the trunk meets the ground — plus 12 unused entries, which is
 * ordinary for a 16-colour palette and is why `SOLID_BLOCK`, not this, is the
 * warning-free fixture.
 */
export const SPRITE_32 = SpriteDocSchema.parse({
  ...base("fx-sprite-32", "pixel art tree, front view"),
  size: { w: 32, h: 32 },
  palette: PICO_8_REF,
  rows: [
    "................................", //  0
    "................................", //  1
    "................................", //  2
    "................................", //  3
    "...........3333333333...........", //  4
    "........333bbbbbbbbbb333........", //  5
    ".......3bbbbbbbbbbbbbbbb3.......", //  6
    "......3bbbbbbbbbbbbbbbbbb3......", //  7
    ".....3bbbbbbbbbbbbbbbbbbbb3.....", //  8
    "....3bbbbbbbbbbbbbbbbbbbbbb3....", //  9
    "....3bbbbbbbbbbbbbbbbbbbbbb3....", // 10
    "....3bbbbbbbbbbbbbbbbbbbbbb3....", // 11
    "...3bbbbbbbbbbbbbbbbbbbbbbbb3...", // 12
    "...3bbbbbbbbbbbbbbbbbbbbbbbb3...", // 13
    "...3bbbbbbbbbbbbbbbbbbbbbbbb3...", // 14
    "....3bbbbbbbbbbbbbbbbbbbbbb3....", // 15
    "....3bbbbbbbbbbbbbbbbbbbbbb3....", // 16
    "....3bbbbbbbbbbbbbbbbbbbbbb3....", // 17
    ".....3bbbbbbbbbbbbbbbbbbbb3.....", // 18
    "......3bbbbbbbbbbbbbbbbbb3......", // 19
    ".......3bbbbbbbbbbbbbbbb3.......", // 20
    "........333bbb4444bbb333........", // 21
    "...........3334444333...........", // 22
    "..............4444..............", // 23
    "..............4444..............", // 24
    "..............4444..............", // 25
    "..............4444..............", // 26
    "..............4444..............", // 27
    "..............4444..............", // 28
    "..............4444..............", // 29
    "...55555555555555555555555555...", // 30
    "................................", // 31
  ],
});

/**
 * The border ring at **32×32**: an orphan in each corner and a mismatched-flank
 * gap in the middle of each edge — (12,0), (0,12), (31,12) and (12,31).
 *
 * Every other border fixture in this file is 16×16, where `w - 1` and `h - 1`
 * are both 15 and a hard-coded 15 is indistinguishable from `size.w - 1`. At 32
 * the two are twenty-nine apart, and `SPRITE_32` — the only other 32×32 sprite
 * with pixels in it — keeps its whole subject four cells clear of every edge, so
 * nothing in the suite currently reads the border of a 32-wide canvas at all.
 */
export const BORDER_RING_32 = SpriteDocSchema.parse({
  ...base("fx-border-ring-32", "a 32-wide canvas with findings on every edge"),
  size: { w: 32, h: 32 },
  palette: STRUCT_PALETTE_REF,
  rows: canvas(32, [
    // corners — four orphans
    [0, 0, "1"],
    [31, 0, "1"],
    [0, 31, "1"],
    [31, 31, "1"],
    // top edge: gap at (12, 0), flanked 2 | 3
    [10, 0, "2"],
    [11, 0, "2"],
    [13, 0, "3"],
    [14, 0, "3"],
    // left edge: gap at (0, 12), flanked 2 | 0
    [0, 10, "2"],
    [0, 11, "2"],
    [0, 13, "0"],
    [0, 14, "0"],
    // right edge: gap at (31, 12), flanked 1 | 2
    [31, 10, "1"],
    [31, 11, "1"],
    [31, 13, "2"],
    [31, 14, "2"],
    // bottom edge: gap at (12, 31), flanked 3 | 0
    [10, 31, "3"],
    [11, 31, "3"],
    [13, 31, "0"],
    [14, 31, "0"],
  ]),
});

/**
 * `BORDER_PALETTE` at **32×32**: the same hollow ring with one palette index
 * per edge — `1` along row 0, `0` down column 0, `3` down column 31, `2` along
 * row 31, transparent corners.
 *
 * The size closes the same hard-coded-bound hole `BORDER_CONTRAST_32` closes,
 * for the palette code. `BORDER_RING_32` uses all four indices but spreads each
 * of them over two edges, so a scan that skips column 31 still finds every
 * colour somewhere else; here index 3 has nowhere else to be.
 */
export const BORDER_PALETTE_32 = SpriteDocSchema.parse({
  ...base("fx-border-palette-32", "one palette index on each edge, 32 wide"),
  size: { w: 32, h: 32 },
  palette: STRUCT_PALETTE_REF,
  rows: [
    `.${"1".repeat(30)}.`, //  0
    ...Array.from({ length: 30 }, () => `0${dots(30)}3`), // 1-30
    `.${"2".repeat(30)}.`, // 31
  ],
});

/**
 * `BORDER_CONTRAST` at **32×32**: a `2 ↔ 3` contact straddling each corner and
 * one in the middle of each edge, sixteen cells in one warning.
 *
 * `low-contrast` is otherwise pinned at the border only at 16 and 64, which
 * leaves one defect shape unobserved — a **hard-coded canvas size**. An
 * implementation that writes `x === 31` where it means `x === size.w - 1`
 * touches the border only on a 32-wide canvas: at 16 the test never fires and
 * at 64 it lands on an interior column, where `SPRITE_64` has no pair for it to
 * lose. `BORDER_RING_32` cannot cover this because `test-struct` is built to
 * have no sub-threshold pair at all.
 */
export const BORDER_CONTRAST_32 = SpriteDocSchema.parse({
  ...base("fx-border-contrast-32", "low-contrast pairs on every edge at 32×32"),
  size: { w: 32, h: 32 },
  palette: CONTRAST_PALETTE_REF,
  rows: canvas(32, [
    // top edge, left to right: corner, middle, corner
    [0, 0, "2"],
    [1, 0, "3"],
    [15, 0, "2"],
    [16, 0, "3"],
    [30, 0, "3"],
    [31, 0, "2"],
    // left and right edges, vertical pairs so both cells sit in the column
    [0, 15, "2"],
    [0, 16, "3"],
    [31, 15, "2"],
    [31, 16, "3"],
    // bottom edge
    [0, 31, "2"],
    [1, 31, "3"],
    [15, 31, "2"],
    [16, 31, "3"],
    [30, 31, "3"],
    [31, 31, "2"],
  ]),
});

// ---------------------------------------------------------------------------
// 64×64
// ---------------------------------------------------------------------------

/**
 * The border ring at **64×64**, on `pico-8`, carrying every geometric code at
 * once.
 *
 * Spec §2 and §6.2 admit three canvas sizes and this is the first fixture at
 * the third. Until it existed a linter that clamped its scan to 32 — `const w =
 * Math.min(doc.size.w, 32)`, the shape a "guard against a runaway loop" takes —
 * passed the entire suite while linting a quarter of a 64×64 sprite. The lone
 * orphan at **(40, 40)** is past 32 on *both* axes, so it dies to a clamp on
 * either one.
 *
 * Each edge carries the same four things, and each of the ten indices in use
 * lives on exactly one edge (or in the far quadrant), so a scan blind to one
 * border loses that border's colours from `paletteUsed` and invents
 * `unused-palette-entry` warnings for them:
 *
 * | region        | indices | orphan            | gaps                 | low-contrast pair |
 * |---------------|---------|-------------------|----------------------|-------------------|
 * | column 0      | 1, 2    | (0,0), (0,63)     | (0,22)               | (0,40)/(0,41)     |
 * | row 0         | 3, 4    | —                 | (22,0), (41,0)       | (10,0)/(11,0)     |
 * | column 63     | 6, 11   | (63,0), (63,63)   | (63,22)              | (63,40)/(63,41)   |
 * | row 63        | 12, 14  | —                 | (22,63), (41,63)     | (10,63)/(11,63)   |
 * | x,y ≥ 40      | 8, 13   | (40,40)           | (42,50)              | (50,55)/(51,55)   |
 *
 * Every gap is flanked by two **different** indices, so the mismatched-flank
 * case is pinned at this size too. The five low-contrast pairs are the five
 * sub-threshold `pico-8` pairs 1↔2 (Δ 0.0377), 3↔4 (Δ 0.0296), 6↔11 (Δ 0.0113),
 * 8↔13 (Δ 0.0161) and 12↔14 (Δ 0.0030); no other adjacency in the sprite puts
 * two distinct indices in contact, so exactly five `low-contrast` warnings of
 * two cells each are correct.
 *
 * The two four-cell bars on rows 0 and 63 are placed symmetrically about the
 * vertical axis (x = 20,21,23,24 and their mirrors 39,40,42,43) while the two
 * columns are not, which makes `symmetryScore` 16/43 — a value that moves under
 * a scan blind to any single border: 8/33 for either row, 16/35 for either
 * column.
 */
export const SPRITE_64 = SpriteDocSchema.parse({
  ...base("fx-sprite-64", "a 64-wide canvas with findings on every edge"),
  size: { w: 64, h: 64 },
  palette: PICO_8_REF,
  rows: canvas(64, [
    // column 0 — indices 1 and 2
    [0, 0, "1"], //  corner orphan
    [0, 20, "1"],
    [0, 21, "1"], //  gap at (0, 22), flanked 1 | 2
    [0, 23, "2"],
    [0, 24, "2"],
    [0, 40, "1"],
    [0, 41, "2"], //  low-contrast 1↔2
    [0, 63, "1"], //  corner orphan
    // row 0 — indices 3 and 4
    [10, 0, "3"],
    [11, 0, "4"], //  low-contrast 3↔4
    [20, 0, "3"],
    [21, 0, "3"], //  gap at (22, 0), flanked 3 | 4
    [23, 0, "4"],
    [24, 0, "4"],
    [39, 0, "4"],
    [40, 0, "4"], //  gap at (41, 0), flanked 4 | 3
    [42, 0, "3"],
    [43, 0, "3"],
    // column 63 — indices 6 and 11
    [63, 0, "6"], //  corner orphan
    [63, 20, "6"],
    [63, 21, "6"], //  gap at (63, 22), flanked 6 | 11
    [63, 23, "b"],
    [63, 24, "b"],
    [63, 40, "6"],
    [63, 41, "b"], //  low-contrast 6↔11
    [63, 63, "6"], //  corner orphan
    // row 63 — indices 12 and 14
    [10, 63, "c"],
    [11, 63, "e"], //  low-contrast 12↔14
    [20, 63, "c"],
    [21, 63, "c"], //  gap at (22, 63), flanked 12 | 14
    [23, 63, "e"],
    [24, 63, "e"],
    [39, 63, "e"],
    [40, 63, "e"], //  gap at (41, 63), flanked 14 | 12
    [42, 63, "c"],
    [43, 63, "c"],
    // the far quadrant, x and y both past 32 — indices 8 and 13
    [40, 40, "8"], //  the lone orphan a 32-clamp cannot see
    [40, 50, "8"],
    [41, 50, "8"], //  gap at (42, 50), flanked 8 | 13
    [43, 50, "d"],
    [44, 50, "d"],
    [50, 55, "8"],
    [51, 55, "d"], //  low-contrast 8↔13
  ]),
});

/**
 * A fully opaque 64×64 whose `meta.repairedRows` names the **first and last**
 * rows.
 *
 * `row-repaired` builds its `cells` from `size.w` rather than from the grid, so
 * it is the one code that reads the canvas width without reading the canvas.
 * At 64 that matters: an implementation clamping `w` to 32 emits a 32-cell
 * `row-repaired` for a 64-wide row, and `ROW_REPAIRED_32` cannot see it. The
 * fixture doubles as the fully-opaque 64×64 case — `coverage` is exactly 1,
 * which a clamped scan reports as 0.25.
 */
export const ROW_REPAIRED_64 = SpriteDocSchema.parse({
  ...base("fx-row-repaired-64", "a 64-wide sprite with two repaired rows"),
  size: { w: 64, h: 64 },
  palette: STRUCT_PALETTE_REF,
  rows: band("1", 64, 64),
  meta: {
    generatorModel: "qwen3:8b",
    criticModel: "qwen3-vl:8b-instruct-q4_K_M",
    round: 1,
    repairs: 83,
    repairedRows: [0, 63],
    parentId: null,
  },
});

// ---------------------------------------------------------------------------
// the roster
// ---------------------------------------------------------------------------

/**
 * Every fixture, keyed by name, so a suite can assert a whole-file property
 * — "each one parses", "each one's report validates" — and name the offender
 * when it fails. Deliberately not annotated: the inferred type keeps the
 * `SpriteDocSchema.parse` provenance of each entry visible.
 */
export const ALL_FIXTURES = {
  SOLID_BLOCK,
  BLANK,
  ONE_ORPHAN,
  DIAGONAL_ONLY,
  CORNER_PIXEL,
  BOTTOM_ROW_ORPHAN,
  LAST_COLUMN_ORPHAN,
  FOUR_CORNERS,
  BORDER_ORPHANS,
  HORIZONTAL_GAP,
  VERTICAL_GAP,
  BOTTOM_ROW_GAP,
  EDGE_GAPS,
  ONE_PIXEL_MARGIN,
  SINGLE_CELL_FLANKS,
  MISMATCHED_FLANK_GAPS,
  LOW_CONTRAST_PAIR,
  LOW_CONTRAST_MANY,
  GAMEBOY_CANARY,
  BOTTOM_ROW_CONTRAST,
  TOP_ROW_CONTRAST,
  BORDER_CONTRAST,
  TRIPLE_CONTRAST,
  CORNER_PALETTE,
  BORDER_PALETTE,
  PERFECT_MIRROR,
  FULLY_ASYMMETRIC,
  ROW_REPAIRED,
  BLANK_ROW_REPAIRED,
  ROW_REPAIRED_32,
  ROW_REPAIRED_64,
  SPRITE_32,
  BORDER_RING_32,
  BORDER_CONTRAST_32,
  BORDER_PALETTE_32,
  SPRITE_64,
};
