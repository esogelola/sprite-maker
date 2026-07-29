import { describe, expect, it } from "vitest";

import { lint } from "@main/lint";
import { getPalette } from "@shared/palettes";
import {
  LINT_CODES,
  LintReportSchema,
  SpriteDocSchema,
  type LintCode,
  type LintReport,
  type LintWarning,
} from "@shared/schema";
import {
  ALL_FIXTURES,
  BLANK,
  BLANK_ROW_REPAIRED,
  BORDER_CONTRAST,
  BORDER_CONTRAST_32,
  BORDER_ORPHANS,
  BORDER_PALETTE,
  BORDER_PALETTE_32,
  BORDER_RING_32,
  BOTTOM_ROW_CONTRAST,
  BOTTOM_ROW_GAP,
  BOTTOM_ROW_ORPHAN,
  CORNER_PALETTE,
  CORNER_PIXEL,
  DIAGONAL_ONLY,
  EDGE_GAPS,
  FOUR_CORNERS,
  FULLY_ASYMMETRIC,
  GAMEBOY_CANARY,
  GAMEBOY_REF,
  HORIZONTAL_GAP,
  LAST_COLUMN_ORPHAN,
  LOW_CONTRAST_MANY,
  LOW_CONTRAST_PAIR,
  MISMATCHED_FLANK_GAPS,
  ONE_ORPHAN,
  ONE_PIXEL_MARGIN,
  PERFECT_MIRROR,
  PICO_8_REF,
  ROW_REPAIRED,
  ROW_REPAIRED_32,
  ROW_REPAIRED_64,
  SINGLE_CELL_FLANKS,
  SOLID_BLOCK,
  SPRITE_32,
  SPRITE_64,
  TOP_ROW_CONTRAST,
  TRIPLE_CONTRAST,
  VERTICAL_GAP,
} from "../fixtures/sprites";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const FIXTURE_ENTRIES = Object.entries(ALL_FIXTURES);

/** Every warning of `code`, in the order `lint()` emitted them. */
function byCode(report: LintReport, code: LintCode): LintWarning[] {
  return report.warnings.filter((w) => w.code === code);
}

/** Asserts exactly one warning of `code` and hands it back. */
function only(report: LintReport, code: LintCode): LintWarning {
  const found = byCode(report, code);
  expect(found).toHaveLength(1);
  return found[0];
}

/** `[[0, y], [1, y], … [w-1, y]]` — what `row-repaired` must list for row `y`. */
const rowCells = (y: number, w: number) =>
  Array.from({ length: w }, (_, x) => [x, y]);

/** Row-major cells of a whole row, used to build low-contrast expectations. */
const span = (y: number, x0: number, x1: number) =>
  Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y]);

/**
 * Which of the four canvas edges `cells` reaches.
 *
 * The unit of coverage in this file is **the border**, not any one row or
 * column of it. Round 1 of this suite pinned the bottom row and the last
 * column — the two edges a rejection happened to name — and left the top row
 * and the first column open, because there was no way to say "all four" and
 * have the saying be checked. This is that check: a fixture whose findings stop
 * reaching an edge stops being a border fixture, and `edgesReached` says so
 * before the mutant that edge admits ever gets written.
 */
function edgesReached(cells: readonly number[][], w: number, h: number) {
  return {
    top: cells.some(([, y]) => y === 0),
    bottom: cells.some(([, y]) => y === h - 1),
    left: cells.some(([x]) => x === 0),
    right: cells.some(([x]) => x === w - 1),
  };
}

/** What `edgesReached` returns for findings that touch every edge. */
const ALL_EDGES = { top: true, bottom: true, left: true, right: true };

/** Every `[x, y]` at which `doc.rows` holds `ch`, row-major. */
const occurrences = (doc: { rows: readonly string[] }, ch: string) => {
  const out: number[][] = [];
  doc.rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === ch) out.push([x, y]);
    }),
  );
  return out;
};

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

// **Warning `message` text and the order warnings appear in are deliberately
// left unasserted.** Spec §6.5 types `message` as `string` with no content
// requirement and puts `indices` on the warning so consumers "do not have to
// regex free text", and `lint.ts` records that warning order is not part of the
// contract — so pinning either would freeze incidental behaviour as contract and
// turn a rewording into a red suite. The few `message` assertions below are the
// deliberate exception: each pins a *computed value* — a luminance delta, a row
// number — that no other field of the warning carries, never the prose around
// it. The silence is a decision, not an oversight.

describe("lint() contract (spec §6.5)", () => {
  it.each(FIXTURE_ENTRIES)("%s produces a schema-valid report", (_name, doc) => {
    // LintReportSchema is strict and bounds every metric to 0..1, so this is
    // what catches a NaN symmetryScore here rather than in Wave 9, where it
    // would surface as a SessionHistory that will not round-trip.
    expect(() => LintReportSchema.parse(lint(doc))).not.toThrow();
  });

  it.each(FIXTURE_ENTRIES)("%s is itself a valid SpriteDoc", (_name, doc) => {
    expect(() => SpriteDocSchema.parse(doc)).not.toThrow();
    // Wave 2d made meta.round positive(); a fixture carrying 0 would throw at
    // import and take the whole file down, so pin it explicitly.
    expect(doc.meta.round).toBe(1);
  });

  it("emits no code outside LINT_CODES", () => {
    for (const [, doc] of FIXTURE_ENTRIES) {
      for (const w of lint(doc).warnings) {
        expect(LINT_CODES).toContain(w.code);
      }
    }
  });

  it("reads doc.palette.colors and never getPalette()", () => {
    // The contrived fixtures name palettes the registry does not have. If
    // lint() looked its palette up by id instead of reading the snapshot on the
    // document, every one of these would throw.
    for (const doc of [ONE_ORPHAN, LOW_CONTRAST_PAIR, PERFECT_MIRROR]) {
      expect(() => getPalette(doc.palette.id)).toThrow();
      expect(() => lint(doc)).not.toThrow();
    }
  });

  it.each(FIXTURE_ENTRIES)("%s survives a JSON round trip", (_name, doc) => {
    // Wave 9 embeds a LintReport in every Round and persists SessionHistory
    // after each one, so the report has to come back off disk identical. This
    // is also the second net under NaN: JSON.stringify turns it into `null`,
    // which re-parses as a schema violation rather than a wrong number.
    const report = lint(doc);
    const roundTripped = LintReportSchema.parse(
      JSON.parse(JSON.stringify(report)),
    );
    expect(roundTripped).toEqual(report);
  });

  it("is pure — it does not mutate the document", () => {
    const before = structuredClone(SPRITE_32);
    lint(SPRITE_32);
    expect(SPRITE_32).toEqual(before);
  });

  it("is deterministic — two calls agree", () => {
    expect(lint(SPRITE_32)).toEqual(lint(SPRITE_32));
    expect(lint(GAMEBOY_CANARY)).toEqual(lint(GAMEBOY_CANARY));
  });

  it("keeps the inlined fixture palettes in step with the library", () => {
    // The fixtures inline their colours so a document reads standalone. This is
    // the guard that stops the copies drifting from shared/palettes.ts, which
    // would quietly invalidate every luminance figure in this file.
    expect(GAMEBOY_REF.colors).toEqual([...getPalette("gameboy").colors]);
    expect(PICO_8_REF.colors).toEqual([...getPalette("pico-8").colors]);
  });
});

// ---------------------------------------------------------------------------
// orphan-pixel
// ---------------------------------------------------------------------------

describe("orphan-pixel (spec §6.5)", () => {
  it("reports one warning listing every orphan cell", () => {
    const w = only(lint(ONE_ORPHAN), "orphan-pixel");
    expect(w.cells).toEqual([[12, 12]]);
    expect(lint(ONE_ORPHAN).metrics.orphanCount).toBe(1);
  });

  it("reports a diagonally attached cell — orthogonal neighbours only", () => {
    // The sharp edge: (4,4) and (5,5) touch at a corner, and an eight-neighbour
    // implementation reports neither.
    const report = lint(DIAGONAL_ONLY);
    const w = only(report, "orphan-pixel");
    expect(w.cells).toEqual([
      [4, 4],
      [5, 5],
    ]);
    expect(report.metrics.orphanCount).toBe(2);
  });

  it("is one warning total, not one per orphan", () => {
    expect(byCode(lint(DIAGONAL_ONLY), "orphan-pixel")).toHaveLength(1);
  });

  it("treats out-of-canvas as transparent at the corner", () => {
    // Deciding (0,0) means reading (-1,0) and (0,-1). grid.ts's getPixel throws
    // there, so a linter built on it fails this outright.
    const report = lint(CORNER_PIXEL);
    expect(only(report, "orphan-pixel").cells).toEqual([[0, 0]]);
    expect(report.metrics.orphanCount).toBe(1);
  });

  it("finds an orphan on the bottom row", () => {
    // The mirror of the CORNER_PIXEL case at the far edge: a scan bounded
    // `y < h - 1` reports every other orphan in this file and drops this one.
    const report = lint(BOTTOM_ROW_ORPHAN);
    expect(only(report, "orphan-pixel").cells).toEqual([[7, 15]]);
    expect(report.metrics.orphanCount).toBe(1);
  });

  it("finds an orphan in the last column", () => {
    const report = lint(LAST_COLUMN_ORPHAN);
    expect(only(report, "orphan-pixel").cells).toEqual([[15, 7]]);
    expect(report.metrics.orphanCount).toBe(1);
  });

  it("finds an orphan in each of the four corners, row-major", () => {
    // Three of these positions appear in no other fixture, and a wrapped
    // neighbour read — rows[(y+1) % h][(x+1) % w] — makes all four non-orphans
    // here while still satisfying CORNER_PIXEL.
    const report = lint(FOUR_CORNERS);
    expect(only(report, "orphan-pixel").cells).toEqual([
      [0, 0],
      [15, 0],
      [0, 15],
      [15, 15],
    ]);
    expect(report.metrics.orphanCount).toBe(4);
  });

  it("finds an orphan on every edge and in every corner", () => {
    // FOUR_CORNERS pins the corners, but a corner sits on two edges at once, so
    // a `cells` array made only of corners cannot say *which* edge a scan lost:
    // drop column 0 and (0,0) still has (15,0) beside it in the expectation.
    // BORDER_ORPHANS adds a cell in the middle of each edge, so every one of the
    // four borders owns a position no other border can account for.
    const report = lint(BORDER_ORPHANS);
    const cells = only(report, "orphan-pixel").cells;
    expect(cells).toEqual([
      [0, 0],
      [7, 0],
      [15, 0],
      [0, 7],
      [15, 7],
      [0, 15],
      [7, 15],
      [15, 15],
    ]);
    expect(report.metrics.orphanCount).toBe(8);
    expect(edgesReached(cells, 16, 16)).toEqual(ALL_EDGES);
  });

  it("finds an orphan in every corner at 32×32", () => {
    // Every other border fixture is 16×16, where a hard-coded 15 and `size.w-1`
    // are the same number. SPRITE_32 keeps its subject four cells clear of the
    // edges, so before BORDER_RING_32 nothing read the border of a 32-wide
    // canvas at all.
    const report = lint(BORDER_RING_32);
    const cells = only(report, "orphan-pixel").cells;
    expect(cells).toEqual([
      [0, 0],
      [31, 0],
      [0, 31],
      [31, 31],
    ]);
    expect(report.metrics.orphanCount).toBe(4);
    expect(edgesReached(cells, 32, 32)).toEqual(ALL_EDGES);
  });

  it("finds an orphan in every corner of a 64×64 canvas, and one past cell 31", () => {
    // Spec §6.2 admits 64×64 and no fixture used it, so a scan clamped to 32 —
    // `const w = Math.min(doc.size.w, 32)` — linted a quarter of a 64×64 sprite
    // and passed the whole suite. (40, 40) is past 32 on *both* axes, so it dies
    // to a clamp on either one.
    const report = lint(SPRITE_64);
    const cells = only(report, "orphan-pixel").cells;
    expect(cells).toEqual([
      [0, 0],
      [63, 0],
      [40, 40],
      [0, 63],
      [63, 63],
    ]);
    expect(report.metrics.orphanCount).toBe(5);
    expect(edgesReached(cells, 64, 64)).toEqual(ALL_EDGES);
  });

  it("does not mistake an edge-hugging filled cell for an orphan", () => {
    // EDGE_GAPS keeps twelve filled cells against the four canvas edges, each
    // with an orthogonal partner. None of them is an orphan.
    const report = lint(EDGE_GAPS);
    expect(byCode(report, "orphan-pixel")).toEqual([]);
    expect(report.metrics.orphanCount).toBe(0);
  });

  it("carries no indices", () => {
    const w = only(lint(ONE_ORPHAN), "orphan-pixel");
    expect(w.indices).toBeUndefined();
    expect("indices" in w).toBe(false);
  });

  it("reports nothing when every cell has an orthogonal neighbour", () => {
    for (const doc of [SOLID_BLOCK, PERFECT_MIRROR, BLANK, SPRITE_32]) {
      const report = lint(doc);
      expect(byCode(report, "orphan-pixel")).toEqual([]);
      expect(report.metrics.orphanCount).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// outline-gap
// ---------------------------------------------------------------------------

describe("outline-gap (spec §6.5)", () => {
  it("finds a transparent cell flanked left and right", () => {
    const report = lint(HORIZONTAL_GAP);
    const w = only(report, "outline-gap");
    expect(w.cells).toEqual([[6, 8]]);
    expect(w.indices).toBeUndefined();
  });

  it("finds a transparent cell flanked above and below", () => {
    expect(only(lint(VERTICAL_GAP), "outline-gap").cells).toEqual([[8, 6]]);
  });

  it("finds a gap on the bottom row", () => {
    // Both gaps above sit mid-canvas (y=8, x=8). A scan bounded `y < h - 1`
    // still reports those two and silently drops this one — and a hole in the
    // bottom edge of a silhouette is exactly what spec §11 bars.
    expect(only(lint(BOTTOM_ROW_GAP), "outline-gap").cells).toEqual([[6, 15]]);
  });

  it("finds gaps on row 0 and in the first and last columns", () => {
    // The three edges BOTTOM_ROW_GAP does not cover, in one report — and in
    // row-major order across a mixture of them.
    expect(only(lint(EDGE_GAPS), "outline-gap").cells).toEqual([
      [6, 0],
      [0, 6],
      [15, 6],
    ]);
  });

  it("does not read past any of the four canvas edges as filled", () => {
    // This replaces a test that made the same claim about CORNER_PIXEL, on the
    // premise that treating (-1,0) and (0,-1) as filled "invents a gap at
    // (1,0)". That premise is false. A gap needs non-transparent cells on
    // *opposite* sides, and (1,0)'s right-hand neighbour (2,0) is transparent,
    // so CORNER_PIXEL reports no gap whether the reader is lenient or not — the
    // test could not fail for the reason it named, and both the x = -1 and
    // y = -1 mistakes it claimed to cover walked straight through it.
    //
    // ONE_PIXEL_MARGIN can fail. Its whole border ring is transparent with the
    // canvas edge on one side and a solid block on the other, so counting the
    // out-of-canvas side as filled invents fourteen gaps down that edge:
    //
    //   left  → (0,1)…(0,14)      right → (15,1)…(15,14)
    //   above → (1,0)…(14,0)      below → (1,15)…(14,15)
    //
    // A one-pixel margin is what a generator produces every time it centres a
    // 14-wide subject on a 16-wide canvas.
    expect(byCode(lint(ONE_PIXEL_MARGIN), "outline-gap")).toEqual([]);

    // The same four mistakes one cell at a time: each of BORDER_PALETTE's four
    // corners is transparent with a filled cell on both of its in-canvas sides,
    // so a lenient read of either out-of-canvas side makes it a gap.
    expect(byCode(lint(BORDER_PALETTE), "outline-gap")).toEqual([]);

    // Kept from the replaced test — true, if weaker than it claimed.
    expect(byCode(lint(CORNER_PIXEL), "outline-gap")).toEqual([]);
  });

  it("reads the flank immediately beside the hole, not further out", () => {
    // Every other gap fixture flanks its hole with a bar two or more cells long
    // in the direction of the test, so `at(x-1, y)` and `at(x-2, y)` are both
    // filled and no assertion in the file can tell them apart. Reading one cell
    // too far out then finds every gap in the suite and none of these four.
    //
    // The flanks are also one cell thick *across* the hole's axis, which is what
    // keeps the eight filled cells from being orphans by exactly one neighbour:
    // reading the attachment offset one cell out makes all eight orphans.
    const report = lint(SINGLE_CELL_FLANKS);
    expect(only(report, "outline-gap").cells).toEqual([
      [3, 6], // horizontal hole, one-column flanks at x = 2 and x = 4
      [3, 7],
      [8, 11], // vertical hole, one-row flanks at y = 10 and y = 12
      [9, 11],
    ]);
    expect(byCode(report, "orphan-pixel")).toEqual([]);
    expect(report.metrics.orphanCount).toBe(0);
  });

  it("finds a gap whose two flanks hold different indices", () => {
    // Every other gap fixture flanks its hole with the *same* index, so all of
    // them survive an implementation that requires the flanks to match before
    // calling the hole a gap. Spec §6.5 says "non-transparent cells on opposite
    // sides" and says nothing about their colours — and the mismatched case is
    // the common one, because a hole in an outline where the outline meets the
    // fill has an outline index on one side and a fill index on the other.
    //
    // Six holes, both orientations, four different index pairs, and one on each
    // of the four borders plus two mid-canvas so "mismatched" is not conflated
    // with "on an edge".
    const report = lint(MISMATCHED_FLANK_GAPS);
    const cells = only(report, "outline-gap").cells;
    expect(cells).toEqual([
      [6, 0], // horizontal, top row:      2 | 3
      [0, 5], // vertical, first column:   1 | 2
      [15, 5], // vertical, last column:   3 | 0
      [11, 11], // vertical, mid-canvas:   1 | 0
      [4, 12], // horizontal, mid-canvas:  2 | 0
      [6, 15], // horizontal, bottom row:  0 | 1
    ]);
    expect(edgesReached(cells, 16, 16)).toEqual(ALL_EDGES);
    // The bars either side of each hole are two cells long, so none of the
    // twenty-four filled cells is an orphan and the report is gaps and nothing
    // else — test-struct carries no sub-threshold pair and uses all four indices.
    expect(report.warnings.map((w) => w.code)).toEqual(["outline-gap"]);
  });

  it("finds a gap on every edge at 32×32", () => {
    const report = lint(BORDER_RING_32);
    const cells = only(report, "outline-gap").cells;
    expect(cells).toEqual([
      [12, 0],
      [0, 12],
      [31, 12],
      [12, 31],
    ]);
    expect(edgesReached(cells, 32, 32)).toEqual(ALL_EDGES);
  });

  it("finds a gap on every edge of a 64×64 canvas, and one past cell 31", () => {
    const report = lint(SPRITE_64);
    const cells = only(report, "outline-gap").cells;
    expect(cells).toEqual([
      [22, 0],
      [41, 0], // row 0
      [0, 22], // column 0
      [63, 22], // column 63
      [42, 50], // the far quadrant, past 32 on both axes
      [22, 63],
      [41, 63], // row 63
    ]);
    expect(edgesReached(cells, 64, 64)).toEqual(ALL_EDGES);
  });

  it("does not count the far side of the last column or bottom row as filled", () => {
    // The high-edge half of the test above, which CORNER_PIXEL cannot reach.
    // EDGE_GAPS carries two probes: (15,10) is transparent with a filled cell
    // on its left and the canvas edge on its right, and (11,15) is transparent
    // with a filled cell above it and the edge below. Reading past the canvas
    // as filled rather than transparent invents a gap at each.
    const cells = only(lint(EDGE_GAPS), "outline-gap").cells;
    expect(cells).not.toContainEqual([15, 10]);
    expect(cells).not.toContainEqual([11, 15]);
  });

  it("does not fire on a filled cell with transparency on only one side", () => {
    // HORIZONTAL_GAP's row 8 is filled at x=4,5,7,8. Only x=6 has filled cells
    // on opposite sides; x=3 and x=9 each have one, and must stay silent.
    expect(only(lint(HORIZONTAL_GAP), "outline-gap").cells).toHaveLength(1);
  });

  it("reports nothing on a solid or empty canvas", () => {
    for (const doc of [SOLID_BLOCK, BLANK, PERFECT_MIRROR, SPRITE_32]) {
      expect(byCode(lint(doc), "outline-gap")).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// low-contrast
// ---------------------------------------------------------------------------

describe("low-contrast (spec §6.5)", () => {
  it("reports the pair and every participating cell", () => {
    const w = only(lint(LOW_CONTRAST_PAIR), "low-contrast");
    expect(w.indices).toEqual([2, 3]);
    expect(w.cells).toEqual([
      [7, 8],
      [8, 8],
    ]);
  });

  it("deduplicates: 30 adjacent pairs of the same two indices yield one warning", () => {
    const report = lint(LOW_CONTRAST_MANY);
    const w = only(report, "low-contrast");
    expect(w.indices).toEqual([2, 3]);
    // rows 7 and 8 entire, plus x=0..13 of row 9 — 46 cells, row-major.
    expect(w.cells).toEqual([
      ...span(7, 0, 15),
      ...span(8, 0, 15),
      ...span(9, 0, 13),
    ]);
  });

  it("reports a pair on the bottom row", () => {
    // Every other low-contrast fixture puts its pair on rows 7-9. gameboy 0↔1
    // is Δ 0.0661, and the two same-index contacts either side of it keep the
    // i === j guard under test at the edge as well.
    const report = lint(BOTTOM_ROW_CONTRAST);
    const w = only(report, "low-contrast");
    expect(w.indices).toEqual([0, 1]);
    expect(w.cells).toEqual([
      [1, 15],
      [2, 15],
    ]);
    expect(w.message).toContain("0.0661");
  });

  it("reports a pair on row 0", () => {
    const w = only(lint(TOP_ROW_CONTRAST), "low-contrast");
    expect(w.indices).toEqual([0, 1]);
    expect(w.cells).toEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  it("reports a pair on every edge and in every corner", () => {
    // TOP_ROW_CONTRAST and BOTTOM_ROW_CONTRAST cover two of the four edges, and
    // neither puts a participating cell *in* a corner — their pairs sit at x = 1
    // and x = 2. So an implementation that forms pairs everywhere except the
    // four corner cells passes both of them and reports this fixture with (0,0),
    // (15,0), (0,15) and (15,15) missing.
    //
    // The left- and right-edge pairs run vertically so that both members sit
    // inside the column under test; a horizontal pair straddling column 0 leaves
    // half its evidence at x = 1, where a column-0-blind implementation still
    // finds it and emits the warning with a shorter list.
    const report = lint(BORDER_CONTRAST);
    const w = only(report, "low-contrast");
    expect(w.indices).toEqual([2, 3]);
    expect(w.cells).toEqual([
      [0, 0],
      [1, 0],
      [7, 0],
      [8, 0],
      [14, 0],
      [15, 0],
      [0, 7],
      [15, 7],
      [0, 8],
      [15, 8],
      [0, 15],
      [1, 15],
      [7, 15],
      [8, 15],
      [14, 15],
      [15, 15],
    ]);
    expect(edgesReached(w.cells, 16, 16)).toEqual(ALL_EDGES);
  });

  it("reports a pair on every edge and in every corner at 32×32", () => {
    // The size that catches a hard-coded canvas bound. An implementation writing
    // `x === 31` where it means `size.w - 1` never fires at 16 and lands on an
    // interior column at 64, so only a 32-wide fixture with a pair on the border
    // can see it — and BORDER_RING_32 cannot, because test-struct has no
    // sub-threshold pair by construction.
    const w = only(lint(BORDER_CONTRAST_32), "low-contrast");
    expect(w.indices).toEqual([2, 3]);
    expect(w.cells).toEqual([
      [0, 0],
      [1, 0],
      [15, 0],
      [16, 0],
      [30, 0],
      [31, 0],
      [0, 15],
      [31, 15],
      [0, 16],
      [31, 16],
      [0, 31],
      [1, 31],
      [15, 31],
      [16, 31],
      [30, 31],
      [31, 31],
    ]);
    expect(edgesReached(w.cells, 32, 32)).toEqual(ALL_EDGES);
  });

  it("reports a pair on every edge of a 64×64 canvas", () => {
    // The five sub-threshold pico-8 pairs, one per region, so each edge of the
    // largest canvas owns a low-contrast warning that no other edge can supply.
    const found = byCode(lint(SPRITE_64), "low-contrast");
    expect(found.map((w) => [w.indices, w.cells])).toEqual([
      [[1, 2], [[0, 40], [0, 41]]], // column 0   Δ 0.0377
      [[3, 4], [[10, 0], [11, 0]]], // row 0      Δ 0.0296
      [[6, 11], [[63, 40], [63, 41]]], // column 63  Δ 0.0113
      [[8, 13], [[50, 55], [51, 55]]], // far quadrant Δ 0.0161
      [[12, 14], [[10, 63], [11, 63]]], // row 63     Δ 0.0030
    ]);
    expect(edgesReached(found.flatMap((w) => w.cells), 64, 64)).toEqual(
      ALL_EDGES,
    );
  });

  it("excludes i === j — a same-index adjacency has Δ 0 and is not a pair", () => {
    // SOLID_BLOCK has hundreds of same-index adjacencies. Without the i < j
    // guard every filled sprite reports low-contrast against itself.
    expect(byCode(lint(SOLID_BLOCK), "low-contrast")).toEqual([]);
    expect(byCode(lint(ROW_REPAIRED), "low-contrast")).toEqual([]);
  });

  it("excludes transparent cells rather than reading colors[-1]", () => {
    // charIndex('.') is -1, so a pair built without excluding transparency
    // reads colors[-1], gets undefined, and crashes in the hex parser — on the
    // first sprite with a transparent neighbour, which is nearly all of them.
    for (const doc of [ONE_ORPHAN, DIAGONAL_ONLY, CORNER_PIXEL, BLANK]) {
      expect(() => lint(doc)).not.toThrow();
      expect(byCode(lint(doc), "low-contrast")).toEqual([]);
    }
  });

  it("holds the 0.0794 gameboy canary against the 0.08 threshold", () => {
    // gameboy 2↔3 sits 0.8% under the threshold. Rounding the sRGB
    // linearization anywhere loses this warning; that is what it is here for.
    const report = lint(GAMEBOY_CANARY);
    const w = only(report, "low-contrast");
    expect(w.indices).toEqual([2, 3]);
    expect(w.cells).toEqual([...span(7, 0, 15), ...span(8, 0, 15)]);
    expect(w.message).toContain("0.0794");
  });

  it("stays silent on the pairs that clear the threshold", () => {
    // GAMEBOY_CANARY also puts 0 next to 2 (Δ 0.3206) and 3 next to 1
    // (Δ 0.3339). Exactly one pair is reported, and it is not those.
    const report = lint(GAMEBOY_CANARY);
    expect(byCode(report, "low-contrast")).toHaveLength(1);
    expect(report.warnings).toHaveLength(1);
  });

  it("orders indices ascending, i < j", () => {
    for (const [, doc] of FIXTURE_ENTRIES) {
      for (const w of byCode(lint(doc), "low-contrast")) {
        expect(w.indices).toHaveLength(2);
        const [i, j] = w.indices as number[];
        expect(i).toBeLessThan(j);
      }
    }
  });

  it("orders pairs by i, then by j when two pairs share an i", () => {
    // `orderedPairs` sorts `a.i === b.i ? a.j - b.j : a.i - b.i`, and the
    // equal-`i` branch was dead to this entire file: no other fixture produces
    // two pairs with the same `i` — SPRITE_32 gives (3,4) and (4,5), SPRITE_64
    // gives five pairs with five distinct `i` — so reversing the tie-break
    // changed no assertion in 626 tests. Spec amendment A6 records fifteen
    // sub-threshold pairs in pico-8 alone, so one index in contact with two
    // others it cannot be told apart from is ordinary output, not a contrivance.
    //
    // TRIPLE_CONTRAST's three greys are pairwise sub-threshold, giving (1,2),
    // (1,3) and (2,3) — two of them sharing i = 1. The row-major scan meets them
    // in the order (1,2), (2,3), (1,3), which differs from the sorted order, so
    // this also fails an implementation that emits pairs as it discovers them.
    const found = byCode(lint(TRIPLE_CONTRAST), "low-contrast");
    expect(found.map((w) => w.indices)).toEqual([
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
    expect(found.map((w) => w.cells)).toEqual([
      [
        [7, 7],
        [8, 7],
      ], // 1↔2: the top pair, Δ 0.0204
      [
        [7, 8],
        [8, 8],
      ], // 1↔3: the bottom pair, Δ 0.0421
      [
        [8, 7],
        [8, 8],
      ], // 2↔3: the right-hand column, Δ 0.0217
    ]);
    // Index 0 is the control: it clears all three greys by 0.18 or more, so it
    // is absent from the sprite and reported unused rather than paired.
    expect(
      byCode(lint(TRIPLE_CONTRAST), "unused-palette-entry").map((w) => w.indices),
    ).toEqual([[0]]);
  });

  it("reports one warning per pair on a multi-pair sprite", () => {
    // SPRITE_32: 3↔4 (Δ 0.0296) where the canopy outline meets the trunk, and
    // 4↔5 (Δ 0.0515) where the trunk meets the ground. 3↔b and 4↔b clear it.
    const pairs = byCode(lint(SPRITE_32), "low-contrast").map((w) => w.indices);
    expect(pairs).toHaveLength(2);
    expect(pairs).toContainEqual([3, 4]);
    expect(pairs).toContainEqual([4, 5]);
  });
});

// ---------------------------------------------------------------------------
// unused-palette-entry
// ---------------------------------------------------------------------------

describe("unused-palette-entry (spec §6.5)", () => {
  it("reports one warning per unused index, with empty cells", () => {
    const found = byCode(lint(BLANK), "unused-palette-entry");
    expect(found).toHaveLength(4);
    expect(found.map((w) => w.indices)).toEqual([[0], [1], [2], [3]]);
    for (const w of found) expect(w.cells).toEqual([]);
  });

  it("reports nothing when every index appears", () => {
    expect(byCode(lint(SOLID_BLOCK), "unused-palette-entry")).toEqual([]);
    expect(byCode(lint(GAMEBOY_CANARY), "unused-palette-entry")).toEqual([]);
  });

  it("names only the indices actually missing", () => {
    // LOW_CONTRAST_PAIR uses 2 and 3 of a 4-colour palette.
    const found = byCode(lint(LOW_CONTRAST_PAIR), "unused-palette-entry");
    expect(found.map((w) => w.indices)).toEqual([[0], [1]]);
  });

  it("counts against the palette on the document, not a 16-entry assumption", () => {
    // ONE_ORPHAN's palette has 4 entries and uses index 1, so exactly three are
    // unused — an implementation looping 0..15 would report fifteen.
    const found = byCode(lint(ONE_ORPHAN), "unused-palette-entry");
    expect(found.map((w) => w.indices)).toEqual([[0], [2], [3]]);
  });

  it("handles a 16-colour palette", () => {
    // SPRITE_32 uses 3, 4, 5 and b of pico-8.
    const found = byCode(lint(SPRITE_32), "unused-palette-entry");
    expect(found.map((w) => (w.indices as number[])[0])).toEqual([
      0, 1, 2, 6, 7, 8, 9, 10, 12, 13, 14, 15,
    ]);
  });

  it("sees an index that appears on one border only", () => {
    // `used.add(i)` is populated cell by cell inside the same nested x/y scan as
    // orphan-pixel — two lines below `filled++` — so this code is exactly as
    // geometry-dependent as the structural ones, and every border-blind variant
    // of that one line was invisible to the rest of this file.
    //
    // BORDER_PALETTE gives each index its own edge, so a scan blind to an edge
    // deletes a colour that is plainly there: row 0 loses index 1, row 15 loses
    // 2, column 0 loses 0, column 15 loses 3.
    const report = lint(BORDER_PALETTE);
    expect(byCode(report, "unused-palette-entry")).toEqual([]);
    expect(report.metrics.paletteUsed).toBe(4);
    // Nothing else fires either: the ring is one cell thick and continuous, so
    // there is no orphan, no gap, and test-struct has no sub-threshold pair.
    expect(report.warnings).toEqual([]);
  });

  it("sees an index that appears on one border only at 32×32", () => {
    // The 32-wide half of the hard-coded-bound case: BORDER_RING_32 uses all
    // four indices but spreads each over two edges, so a scan that skips column
    // 31 still finds every colour somewhere else. Here index 3 has nowhere else
    // to be, and index 2 lives only on row 31.
    const report = lint(BORDER_PALETTE_32);
    expect(byCode(report, "unused-palette-entry")).toEqual([]);
    expect(report.metrics.paletteUsed).toBe(4);
    expect(report.warnings).toEqual([]);
    expect(report.metrics.coverage).toBeCloseTo(120 / 1024, 12);
    expect(report.metrics.symmetryScore).toBeCloseTo(0.5, 12);
  });

  it("keeps BORDER_PALETTE's one-index-per-edge layout honest", () => {
    // The test above is an argument about *where* each index lives, and the
    // argument is only as good as the fixture. Assert the layout itself rather
    // than trusting the row literals to stay put.
    expect(occurrences(BORDER_PALETTE, "1").every(([, y]) => y === 0)).toBe(true);
    expect(occurrences(BORDER_PALETTE, "2").every(([, y]) => y === 15)).toBe(
      true,
    );
    expect(occurrences(BORDER_PALETTE, "0").every(([x]) => x === 0)).toBe(true);
    expect(occurrences(BORDER_PALETTE, "3").every(([x]) => x === 15)).toBe(true);
    for (const ch of "0123") {
      expect(occurrences(BORDER_PALETTE, ch).length).toBeGreaterThan(0);
    }
  });

  it("sees an index that appears only in the corners", () => {
    // A corner is the one cell where two out-of-canvas reads meet, so it is
    // where an implementation is most likely to have a special case — and both
    // of these fixtures put their only non-transparent cells there. Nothing else
    // in the file asserts a palette fact about a corner-only colour, so an
    // implementation that skips the four corners while recording indices calls
    // index 1 unused on a sprite whose corners plainly hold it.
    for (const doc of [CORNER_PIXEL, FOUR_CORNERS]) {
      const report = lint(doc);
      expect(
        byCode(report, "unused-palette-entry").map((w) => w.indices),
      ).toEqual([[0], [2], [3]]);
      expect(report.metrics.paletteUsed).toBe(1);
    }

    // FOUR_CORNERS holds the same index in all four corners, so an
    // implementation that misses exactly *one* of them still records the colour
    // from the other three. CORNER_PALETTE gives each corner its own index, so
    // each corner becomes independently observable: miss the top-right and the
    // report names index 1 unused on a sprite whose top-right corner holds it.
    const report = lint(CORNER_PALETTE);
    expect(byCode(report, "unused-palette-entry")).toEqual([]);
    expect(report.metrics.paletteUsed).toBe(4);
    expect(only(report, "orphan-pixel").cells).toEqual([
      [0, 0],
      [15, 0],
      [0, 15],
      [15, 15],
    ]);
  });

  it("sees an index that appears only on an orphan", () => {
    // BORDER_ORPHANS is the only fixture in which *every* filled cell is an
    // orphan, which is what separates "this colour is in the sprite" from "this
    // colour is in the sprite on a cell with a neighbour". An implementation
    // that records the index after deciding attachment reports index 1 unused.
    const report = lint(BORDER_ORPHANS);
    expect(
      byCode(report, "unused-palette-entry").map((w) => w.indices),
    ).toEqual([[0], [2], [3]]);
    expect(report.metrics.paletteUsed).toBe(1);
  });

  it("sees an index confined to one edge of a 64×64 canvas", () => {
    // Each of SPRITE_64's ten indices lives on exactly one edge or in the far
    // quadrant, so this list is a statement about all four borders at 64 at
    // once: 1 and 2 are column 0, 3 and 4 row 0, 6 and 11 column 63, 12 and 14
    // row 63, 8 and 13 past cell 39 on both axes.
    const report = lint(SPRITE_64);
    expect(
      byCode(report, "unused-palette-entry").map(
        (w) => (w.indices as number[])[0],
      ),
    ).toEqual([0, 5, 7, 9, 10, 15]);
    expect(report.metrics.paletteUsed).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// row-repaired
// ---------------------------------------------------------------------------

describe("row-repaired (spec §6.5)", () => {
  it("reports one warning per repaired row, listing that row's cells", () => {
    const found = byCode(lint(ROW_REPAIRED), "row-repaired");
    expect(found).toHaveLength(2);
    expect(found[0].cells).toEqual(rowCells(3, 16));
    expect(found[1].cells).toEqual(rowCells(9, 16));
    expect(found[0].message).toContain("row 3");
    expect(found[1].message).toContain("row 9");
  });

  it("reports a repaired row that is entirely transparent", () => {
    // Spec §6.5 makes this unconditional: one warning per entry in
    // `repairedRows`, whatever the row holds. Every other row-repaired fixture
    // is a solid `band("1", …)` fill, so nothing here paired `repairedRows` with
    // a blank row and an implementation that skipped one survived the suite.
    //
    // It is not a corner case. §6.3 pads a short row and substitutes a missing
    // one with the transparent character, so a *fully transparent* repaired row
    // is the ordinary output of a generator failure — precisely the failure this
    // code exists to surface. Suppressing it hides the bad case and reports the
    // mild one.
    //
    // Row 5 is empty and row 8 is filled, so the count separates the two: a
    // suppressing implementation returns one warning here, not two.
    const found = byCode(lint(BLANK_ROW_REPAIRED), "row-repaired");
    expect(found).toHaveLength(2);
    expect(found.map((w) => w.cells)).toEqual([
      rowCells(5, 16), // the transparent row — full width all the same
      rowCells(8, 16),
    ]);
    expect(found[0].cells).toHaveLength(16);

    // Keep the fixture honest: the claim above is only as good as row 5 being
    // genuinely empty and row 8 genuinely not.
    expect(BLANK_ROW_REPAIRED.rows[5]).toBe(".".repeat(16));
    expect(occurrences(BLANK_ROW_REPAIRED, "1").some(([, y]) => y === 8)).toBe(
      true,
    );
  });

  it("lists cells across the full canvas width, at 32 as well as 16", () => {
    // At 16×16 a hard-coded 16 is indistinguishable from size.w. Rows 0 and 31
    // also catch an implementation that trims or offsets the row range.
    const found = byCode(lint(ROW_REPAIRED_32), "row-repaired");
    expect(found).toHaveLength(2);
    expect(found[0].cells).toEqual(rowCells(0, 32));
    expect(found[1].cells).toEqual(rowCells(31, 32));
    expect(found[0].cells).toHaveLength(32);
  });

  it("lists cells across the full canvas width at 64 as well", () => {
    // `row-repaired` is the one code that reads the canvas width without
    // reading the canvas, so a scan clamped to 32 shortens its cells rather
    // than dropping a finding — invisible at 16 and at 32.
    const found = byCode(lint(ROW_REPAIRED_64), "row-repaired");
    expect(found).toHaveLength(2);
    expect(found[0].cells).toEqual(rowCells(0, 64));
    expect(found[1].cells).toEqual(rowCells(63, 64));
    expect(found[0].cells).toHaveLength(64);
  });

  it("carries no indices", () => {
    for (const w of byCode(lint(ROW_REPAIRED), "row-repaired")) {
      expect(w.indices).toBeUndefined();
      expect("indices" in w).toBe(false);
    }
  });

  it("reports nothing when meta.repairedRows is empty", () => {
    for (const [, doc] of FIXTURE_ENTRIES) {
      if (doc.meta.repairedRows.length > 0) continue;
      expect(byCode(lint(doc), "row-repaired")).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

describe("metrics (spec §6.5)", () => {
  it("scores a blank canvas 1, not NaN", () => {
    const m = lint(BLANK).metrics;
    expect(Number.isNaN(m.symmetryScore)).toBe(false);
    expect(m.symmetryScore).toBe(1);
    expect(m.coverage).toBe(0);
    expect(m.paletteUsed).toBe(0);
    expect(m.orphanCount).toBe(0);
  });

  it("scores a fully opaque canvas", () => {
    const m = lint(SOLID_BLOCK).metrics;
    expect(m.coverage).toBe(1);
    expect(m.paletteUsed).toBe(4);
    expect(m.orphanCount).toBe(0);
    expect(m.symmetryScore).toBe(1);
  });

  it("scores a mirrored sprite 1", () => {
    const m = lint(PERFECT_MIRROR).metrics;
    expect(m.symmetryScore).toBe(1);
    expect(m.coverage).toBeCloseTo(26 / 256, 12);
    expect(m.paletteUsed).toBe(2);
  });

  it("scores an asymmetric sprite under 0.2 and above 0", () => {
    const m = lint(FULLY_ASYMMETRIC).metrics;
    expect(m.symmetryScore).toBeLessThan(0.2);
    expect(m.symmetryScore).toBeGreaterThan(0);
    // Exactly the two spur cells at (7,4) and (8,4) mirror onto each other.
    expect(m.symmetryScore).toBeCloseTo(2 / 58, 12);
    expect(m.coverage).toBeCloseTo(58 / 256, 12);
  });

  it("counts coverage as the non-transparent fraction", () => {
    expect(lint(ONE_ORPHAN).metrics.coverage).toBeCloseTo(17 / 256, 12);
    expect(lint(DIAGONAL_ONLY).metrics.coverage).toBeCloseTo(2 / 256, 12);
    expect(lint(SPRITE_32).metrics.coverage).toBeCloseTo(448 / 1024, 12);
  });

  it("counts distinct indices present, not palette length", () => {
    expect(lint(ONE_ORPHAN).metrics.paletteUsed).toBe(1);
    expect(lint(LOW_CONTRAST_PAIR).metrics.paletteUsed).toBe(2);
    expect(lint(SPRITE_32).metrics.paletteUsed).toBe(4);
  });

  it("mirrors about the vertical axis at 32×32 too", () => {
    const m = lint(SPRITE_32).metrics;
    expect(m.symmetryScore).toBe(1);
    expect(m.orphanCount).toBe(0);
  });

  it("counts the border into every metric", () => {
    // BORDER_ORPHANS is nothing *but* border: eight cells, one in each corner
    // and one in the middle of each edge. The four numbers below are chosen so
    // that a scan blind to any single border computes a different value for
    // each of them, and no two borders collide:
    //
    //            coverage   symmetryScore
    //   correct    8/256      6/8 = 0.75
    //   no row 0   5/256      4/5 = 0.8
    //   no row 15  5/256      4/5 = 0.8
    //   no col 0   5/256      3/5 = 0.6
    //   no col 15  5/256      3/5 = 0.6
    //   no corners 4/256      2/4 = 0.5
    //
    // symmetryScore is 0.75 rather than 1 because the two mid-edge cells at
    // x = 7 mirror onto transparency at x = 8 while the other six mirror onto
    // each other — a fully symmetric ring would score 1 under every mutation
    // above and pin nothing.
    const m = lint(BORDER_ORPHANS).metrics;
    expect(m.coverage).toBeCloseTo(8 / 256, 12);
    expect(m.orphanCount).toBe(8);
    expect(m.symmetryScore).toBeCloseTo(6 / 8, 12);
    expect(m.paletteUsed).toBe(1);
  });

  it("counts the border into every metric at 32×32", () => {
    // Four corner orphans and four four-cell edge bars: 20 cells, of which only
    // the corners mirror. Dropping a row gives 2/14, dropping a column 2/14 as
    // well but at a different coverage, and dropping the corners gives 0/16.
    const m = lint(BORDER_RING_32).metrics;
    expect(m.coverage).toBeCloseTo(20 / 1024, 12);
    expect(m.orphanCount).toBe(4);
    expect(m.symmetryScore).toBeCloseTo(4 / 20, 12);
    expect(m.paletteUsed).toBe(4);
  });

  it("counts the border into every metric at 64×64", () => {
    // 43 filled cells; the row-0 and row-63 bars are placed symmetrically about
    // the vertical axis and the two columns are not, so symmetryScore is 16/43
    // — 8/33 with either row dropped, 16/35 with either column dropped.
    const m = lint(SPRITE_64).metrics;
    expect(m.coverage).toBeCloseTo(43 / 4096, 12);
    expect(m.orphanCount).toBe(5);
    expect(m.symmetryScore).toBeCloseTo(16 / 43, 12);
    expect(m.paletteUsed).toBe(10);
  });

  it("covers a fully opaque 64×64 canvas", () => {
    // coverage 1 is only reachable if the scan reads every cell of the largest
    // canvas: a scan clamped to 32 reports 0.25, one short of the last row or
    // column reports 63/64.
    const m = lint(ROW_REPAIRED_64).metrics;
    expect(m.coverage).toBe(1);
    expect(m.symmetryScore).toBe(1);
    expect(m.orphanCount).toBe(0);
    expect(m.paletteUsed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// the canvas border, as a whole
// ---------------------------------------------------------------------------

describe("the canvas border is pinned for every geometric code", () => {
  // The defect this block exists for is not "row 15" and not "column 15". It is
  // that the *border* — all four sides, every code that reads geometry, every
  // canvas size — can go unread while the suite stays green. Round 1 of this
  // file closed the two edges a rejection named and left the other two open.
  //
  // Each row below is one code × one canvas size, with a fixture whose findings
  // for that code reach all four edges. The exact-cells assertions live in the
  // per-code blocks above; what this block adds is the statement that the set of
  // (code, size) pairs is complete, checked rather than asserted in a comment.
  const GEOMETRIC = [
    ["orphan-pixel", "16×16", BORDER_ORPHANS, 16],
    ["orphan-pixel", "32×32", BORDER_RING_32, 32],
    ["orphan-pixel", "64×64", SPRITE_64, 64],
    ["outline-gap", "16×16", MISMATCHED_FLANK_GAPS, 16],
    ["outline-gap", "32×32", BORDER_RING_32, 32],
    ["outline-gap", "64×64", SPRITE_64, 64],
    ["low-contrast", "16×16", BORDER_CONTRAST, 16],
    ["low-contrast", "32×32", BORDER_CONTRAST_32, 32],
    ["low-contrast", "64×64", SPRITE_64, 64],
  ] as const;

  it.each(GEOMETRIC)("%s reaches all four edges at %s", (code, _size, doc, n) => {
    const cells = byCode(lint(doc), code).flatMap((w) => w.cells);
    expect(cells.length).toBeGreaterThan(0);
    expect(edgesReached(cells, n, n)).toEqual(ALL_EDGES);
  });

  it("pins a filled corner cell for and against every code", () => {
    // A corner is the one cell where two out-of-canvas reads meet, and the four
    // corners are where the two halves of the leniency rule can disagree. Each
    // fixture below puts something in all four corners and the assertions run in
    // both directions: BORDER_ORPHANS' corners are orphans, BORDER_CONTRAST's
    // are halves of a low-contrast pair and are *not* orphans, BORDER_PALETTE's
    // are transparent and are *not* gaps.
    const corners = [
      [0, 0],
      [15, 0],
      [0, 15],
      [15, 15],
    ];
    const orphans = only(lint(BORDER_ORPHANS), "orphan-pixel").cells;
    for (const c of corners) expect(orphans).toContainEqual(c);

    const contrast = lint(BORDER_CONTRAST);
    for (const c of corners) {
      expect(only(contrast, "low-contrast").cells).toContainEqual(c);
    }
    expect(byCode(contrast, "orphan-pixel")).toEqual([]);

    expect(lint(BORDER_PALETTE).warnings).toEqual([]);
  });

  it("never reports a gap in a corner, on any fixture", () => {
    // The one corner × code combination that is not a fixture fact but a
    // theorem, recorded here so the next reader knows it was checked rather
    // than missed. A gap needs non-transparent cells on **opposite** sides; at a
    // corner one side of each axis is outside the canvas, which spec §6.5 counts
    // as transparent, so both disjuncts of the test are false and `outline-gap`
    // at (0,0), (w-1,0), (0,h-1) or (w-1,h-1) is unreachable.
    //
    // The assertion still bites: every one of the four out-of-canvas-reads-as-
    // filled mistakes makes a corner a gap, which is exactly how BORDER_PALETTE
    // catches them above.
    for (const [, doc] of FIXTURE_ENTRIES) {
      const { w, h } = doc.size;
      for (const warning of byCode(lint(doc), "outline-gap")) {
        for (const [x, y] of warning.cells) {
          const corner = (x === 0 || x === w - 1) && (y === 0 || y === h - 1);
          expect({ x, y, corner }).toEqual({ x, y, corner: false });
        }
      }
    }
  });

  it("cannot tell w from h — and says so, because the canvas is always square", () => {
    // The one border-adjacent class this file cannot pin, recorded so the next
    // reader knows it was reasoned about rather than overlooked.
    //
    // SizeSchema (spec §6.2) admits 16×16, 32×32 and 64×64 and nothing else, so
    // `w === h` on every representable document. Every confusion of the two is
    // therefore a *no-op* rather than a defect: deriving the mirror axis from
    // `h - 1 - x`, swapping the loop bounds, keying the low-contrast dedup set
    // `x * w + y` instead of `y * w + x` — all three leave every report in this
    // suite byte-identical, and no fixture could ever separate them. The class
    // is closed by the schema, not by this file.
    //
    // If an amendment ever admits a non-square canvas, the second assertion
    // fails, and that failure is the signal to come back and pin them here.
    for (const [, doc] of FIXTURE_ENTRIES) {
      expect(doc.size.w).toBe(doc.size.h);
    }
    expect(() =>
      SpriteDocSchema.parse({
        ...structuredClone(BLANK),
        size: { w: 16, h: 32 },
        rows: Array.from({ length: 32 }, () => ".".repeat(16)),
      }),
    ).toThrow();
  });

  it("reads every cell of a 64×64 canvas", () => {
    // The single assertion that a 32-clamp cannot pass: a fully opaque 64×64
    // covers 1.0, and every cell of it was visited to say so.
    expect(lint(ROW_REPAIRED_64).metrics.coverage).toBe(1);
    // And the finding-level version — an orphan past cell 31 on both axes.
    expect(only(lint(SPRITE_64), "orphan-pixel").cells).toContainEqual([40, 40]);
  });
});

// ---------------------------------------------------------------------------
// the warning-free case
// ---------------------------------------------------------------------------

describe("SOLID_BLOCK yields zero warnings of every code", () => {
  it("has an empty warnings array", () => {
    expect(lint(SOLID_BLOCK).warnings).toEqual([]);
  });

  it.each(LINT_CODES)("emits no %s", (code) => {
    expect(byCode(lint(SOLID_BLOCK), code)).toEqual([]);
  });
});
