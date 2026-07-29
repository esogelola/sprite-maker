import { describe, expect, it } from "vitest";

import {
  GridError,
  TRANSPARENT,
  charIndex,
  diff,
  fillRow,
  getPixel,
  indexChar,
  makeEmpty,
  normalize,
  setPixel,
  type Grid,
} from "@shared/grid";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that `fn` throws a `GridError` carrying `code`, and hands the error
 * back so a test can additionally assert on its message. Written by hand
 * rather than with `toThrow` because the machine-readable `code` — not the
 * message — is the contract Wave 8 branches on.
 */
function expectGridError(fn: () => unknown, code: GridError["code"]): GridError {
  let caught: unknown = undefined;
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  expect(threw).toBe(true);
  expect(caught).toBeInstanceOf(GridError);
  expect(caught).toBeInstanceOf(Error);
  const err = caught as GridError;
  expect(err.code).toBe(code);
  return err;
}

/** A grid whose array is frozen, so any in-place write throws under ESM strict mode. */
function frozen(rows: string[]): Grid {
  return Object.freeze(rows.slice()) as unknown as Grid;
}

const ALL_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
const ALL_CHARS = "0123456789abcdef";

// ---------------------------------------------------------------------------
// TRANSPARENT
// ---------------------------------------------------------------------------

describe("TRANSPARENT (spec §6.1)", () => {
  it("is a single '.' character", () => {
    expect(TRANSPARENT).toBe(".");
    expect(TRANSPARENT).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// indexChar / charIndex
// ---------------------------------------------------------------------------

describe("indexChar / charIndex (spec §6.1)", () => {
  it.each(ALL_INDICES)("round-trips index %i through its character", (i) => {
    const ch = indexChar(i);
    expect(ch).toBe(ALL_CHARS[i]);
    expect(ch).toHaveLength(1);
    expect(charIndex(ch)).toBe(i);
  });

  it("emits lowercase for 10-15, never uppercase", () => {
    expect([10, 11, 12, 13, 14, 15].map(indexChar).join("")).toBe("abcdef");
  });

  it("returns -1 for transparent, which Wave 3's linter relies on", () => {
    expect(charIndex(TRANSPARENT)).toBe(-1);
  });

  it.each(["A", "B", "C", "D", "E", "F"])(
    "rejects uppercase %s — lowercase only, spec §6.1 amendment",
    (c) => {
      expect(charIndex(c)).toBe(-1);
    },
  );

  it.each(["g", "z", "", " ", "/", ":", "@", "ab", "0 ", "\n", "."])(
    "returns -1 for the invalid input %j",
    (c) => {
      expect(charIndex(c)).toBe(-1);
    },
  );

  it("never throws — invalid input is a -1, not an exception", () => {
    expect(() => charIndex("g")).not.toThrow();
    expect(() => charIndex("")).not.toThrow();
  });

  it.each([-1, 16, 99, 1.5, NaN, Infinity])(
    "indexChar rejects the out-of-range input %p",
    (i) => {
      expect(() => indexChar(i)).toThrow(GridError);
    },
  );

  it("indexChar reports an integer outside 0-15 as off-palette", () => {
    const err = expectGridError(() => indexChar(16), "off-palette");
    expect(err.message).toContain("16");
  });

  it("indexChar reports a non-integer as bad-char", () => {
    expectGridError(() => indexChar(1.5), "bad-char");
    expectGridError(() => indexChar(NaN), "bad-char");
  });
});

// ---------------------------------------------------------------------------
// makeEmpty
// ---------------------------------------------------------------------------

describe("makeEmpty", () => {
  it("builds an all-transparent grid of the requested shape", () => {
    const g = makeEmpty(4, 3);
    expect(g).toEqual(["....", "....", "...."]);
    expect(g).toHaveLength(3);
    for (const row of g) expect(row).toHaveLength(4);
  });

  it("builds a 16x16 canvas of 256 transparent cells", () => {
    const g = makeEmpty(16, 16);
    expect(g).toHaveLength(16);
    expect(g.join("").split("").every((c) => c === TRANSPARENT)).toBe(true);
    expect(g.join("")).toHaveLength(256);
  });

  it("supports non-square shapes", () => {
    expect(makeEmpty(2, 5)).toEqual(["..", "..", "..", "..", ".."]);
  });

  it.each([
    [-1, 4],
    [4, -1],
    [1.5, 4],
    [4, NaN],
  ])("rejects the invalid dimensions (%p, %p)", (w, h) => {
    expectGridError(() => makeEmpty(w, h), "out-of-bounds");
  });
});

// ---------------------------------------------------------------------------
// normalize — spec §6.3
// ---------------------------------------------------------------------------

interface NormalizeCase {
  name: string;
  rows: string[];
  w: number;
  h: number;
  grid: Grid;
  repairs: number;
  repairedRows: number[];
}

const NORMALIZE_CASES: NormalizeCase[] = [
  {
    name: "a clean grid needs no repairs",
    rows: ["0123", "4567"],
    w: 4,
    h: 2,
    grid: ["0123", "4567"],
    repairs: 0,
    repairedRows: [],
  },
  {
    name: "transparent cells are valid and are not repairs",
    rows: ["..0.", "...."],
    w: 4,
    h: 2,
    grid: ["..0.", "...."],
    repairs: 0,
    repairedRows: [],
  },
  {
    name: "a short row is padded right with '.'",
    rows: ["01", "0123"],
    w: 4,
    h: 2,
    grid: ["01..", "0123"],
    repairs: 2,
    repairedRows: [0],
  },
  {
    name: "a long row is truncated and the dropped cells count as repairs",
    rows: ["012345"],
    w: 4,
    h: 1,
    grid: ["0123"],
    repairs: 2,
    repairedRows: [0],
  },
  {
    name: "an invalid character maps to '.'",
    rows: ["0g23"],
    w: 4,
    h: 1,
    grid: ["0.23"],
    repairs: 1,
    repairedRows: [0],
  },
  {
    name: "an uppercase hex character is invalid, not folded (spec §6.1)",
    rows: ["0A23"],
    w: 4,
    h: 1,
    grid: ["0.23"],
    repairs: 1,
    repairedRows: [0],
  },
  {
    name: "too few rows are padded with fully transparent rows",
    rows: ["01"],
    w: 2,
    h: 2,
    grid: ["01", ".."],
    repairs: 2,
    repairedRows: [1],
  },
  {
    name: "no rows at all yields an empty canvas, every cell a repair",
    rows: [],
    w: 2,
    h: 2,
    grid: ["..", ".."],
    repairs: 4,
    repairedRows: [0, 1],
  },
  {
    // Dropped rows have no surviving row index, so they raise `repairs`
    // without appearing in `repairedRows` — Wave 3's `row-repaired` warning
    // can only point at rows that still exist.
    name: "extra rows are dropped and charged w repairs each",
    rows: ["01", "23", "45"],
    w: 2,
    h: 2,
    grid: ["01", "23"],
    repairs: 2,
    repairedRows: [],
  },
  {
    name: "repairedRows lists exactly the affected row indices",
    rows: ["0000", "0g0", "0000"],
    w: 4,
    h: 3,
    grid: ["0000", "0.0.", "0000"],
    repairs: 2,
    repairedRows: [1],
  },
  {
    name: "a single row can be short, over-long and invalid at once",
    rows: ["0g", "0123456"],
    w: 4,
    h: 3,
    grid: ["0...", "0123", "...."],
    repairs: 3 + 3 + 4,
    repairedRows: [0, 1, 2],
  },
  {
    // 'a' and 'b' are palette indices 10 and 11 — valid characters. See the
    // dedicated test below for why this case has its own entry.
    name: "hex letters a-f are valid palette indices, not invalid characters",
    rows: ["ab"],
    w: 4,
    h: 1,
    grid: ["ab.."],
    repairs: 2,
    repairedRows: [0],
  },
];

describe("normalize (spec §6.3)", () => {
  it.each(NORMALIZE_CASES)("$name", (c) => {
    const result = normalize(c.rows, c.w, c.h);
    expect(result.grid).toEqual(c.grid);
    expect(result.repairs).toBe(c.repairs);
    expect(result.repairedRows).toEqual(c.repairedRows);
  });

  it.each(NORMALIZE_CASES)("$name — produces exactly h rows of w chars", (c) => {
    const { grid } = normalize(c.rows, c.w, c.h);
    expect(grid).toHaveLength(c.h);
    for (const row of grid) expect(row).toHaveLength(c.w);
  });

  /**
   * The plan's Wave 2 acceptance criterion 3 asserts
   * `normalize(["ab"], 4, 1) === { grid: ["...."], repairs: 4 }`, reasoning
   * "2 invalid chars → transparent, 2 pad". That reasoning contradicts both
   * spec §6.1 (`0`-`f` are palette indices, so 'a' = 10 and 'b' = 11 are
   * valid) and the plan's own literal `normalize` implementation, whose
   * `charIndex(c) >= 0` branch keeps them. This test pins the literal
   * implementation's behaviour; the discrepancy is reported, not patched.
   */
  it("keeps 'a' and 'b' as indices 10 and 11 and pads to width", () => {
    const result = normalize(["ab"], 4, 1);
    expect(result.grid).toEqual(["ab.."]);
    expect(result.repairs).toBe(2);
    expect(result.repairedRows).toEqual([0]);
  });

  it("does count genuinely invalid characters, including uppercase", () => {
    const result = normalize(["AB"], 4, 1);
    expect(result.grid).toEqual(["...."]);
    expect(result.repairs).toBe(4);
    expect(result.repairedRows).toEqual([0]);
  });

  it("never mutates the rows it was handed", () => {
    const rows = ["0g", "0123456", "0123"];
    const before = rows.slice();
    normalize(rows, 4, 2);
    expect(rows).toEqual(before);
    expect(rows).toHaveLength(3);
  });

  it("produces a grid every row of which is a fresh string, not a shared ref", () => {
    const rows = ["0123"];
    const { grid } = normalize(rows, 4, 1);
    expect(grid).not.toBe(rows);
  });

  it("accepts a full 16x16 canvas of valid characters with zero repairs", () => {
    const rows = Array.from({ length: 16 }, () => "0123456789abcdef");
    const result = normalize(rows, 16, 16);
    expect(result.repairs).toBe(0);
    expect(result.repairedRows).toEqual([]);
    expect(result.grid).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------
// getPixel
// ---------------------------------------------------------------------------

describe("getPixel", () => {
  const g: Grid = ["01.", "2.4"];

  it.each([
    [0, 0, "0"],
    [1, 0, "1"],
    [2, 0, "."],
    [0, 1, "2"],
    [1, 1, "."],
    [2, 1, "4"],
  ])("reads (%i,%i) as %s", (x, y, expected) => {
    expect(getPixel(g, x, y)).toBe(expected);
  });

  it.each([
    ["left", -1, 0],
    ["top", 0, -1],
    ["right", 3, 0],
    ["bottom", 0, 2],
  ])("rejects a read past the %s edge", (_edge, x, y) => {
    expectGridError(() => getPixel(g, x, y), "out-of-bounds");
  });

  it("rejects non-integer coordinates", () => {
    expectGridError(() => getPixel(g, 1.5, 0), "out-of-bounds");
  });
});

// ---------------------------------------------------------------------------
// setPixel
// ---------------------------------------------------------------------------

describe("setPixel (the mutation chokepoint)", () => {
  const base: Grid = ["....", "....", "....", "...."];

  it("writes the character at the requested cell", () => {
    const next = setPixel(base, 2, 1, "3", 16);
    expect(next).toEqual(["....", "..3.", "....", "...."]);
    expect(getPixel(next, 2, 1)).toBe("3");
  });

  it("can clear a cell back to transparent regardless of palette size", () => {
    const painted = setPixel(base, 0, 0, "1", 4);
    expect(setPixel(painted, 0, 0, TRANSPARENT, 4)).toEqual(base);
  });

  it("writes at every corner of the canvas", () => {
    let g: Grid = base;
    g = setPixel(g, 0, 0, "1", 16);
    g = setPixel(g, 3, 0, "2", 16);
    g = setPixel(g, 0, 3, "3", 16);
    g = setPixel(g, 3, 3, "4", 16);
    expect(g).toEqual(["1..2", "....", "....", "3..4"]);
  });

  it("returns a new grid and leaves the original untouched", () => {
    const original: Grid = ["00", "00"];
    const snapshot = original.slice();
    const next = setPixel(original, 1, 1, "1", 16);
    expect(next).not.toBe(original);
    expect(original).toEqual(snapshot);
    expect(original[1]).toBe("00");
    expect(next[1]).toBe("01");
  });

  it("does not write through a frozen input grid", () => {
    const g = frozen(["00", "00"]);
    expect(() => setPixel(g, 0, 0, "1", 16)).not.toThrow();
    expect(setPixel(g, 0, 0, "1", 16)).toEqual(["10", "00"]);
    expect(g).toEqual(["00", "00"]);
  });

  it.each([
    ["left", -1, 0],
    ["top", 0, -1],
    ["right", 4, 0],
    ["bottom", 0, 4],
  ])("rejects a write past the %s edge with out-of-bounds", (_edge, x, y) => {
    const err = expectGridError(() => setPixel(base, x, y, "1", 16), "out-of-bounds");
    expect(err.message).toContain(`(${x},${y})`);
    expect(err.message).toContain("4x4");
  });

  it.each([
    [1.5, 0],
    [0, 2.5],
    [NaN, 0],
    [0, Infinity],
  ])("rejects the non-integer coordinate pair (%p, %p)", (x, y) => {
    expectGridError(() => setPixel(base, x, y, "1", 16), "out-of-bounds");
  });

  it("rejects an index at or past the palette size as off-palette", () => {
    // A gameboy doc: 4 colours, so only indices 0-3 exist.
    const err = expectGridError(() => setPixel(base, 0, 0, "9", 4), "off-palette");
    expect(err.message).toContain("9");
    expect(err.message).toContain("4");
    expectGridError(() => setPixel(base, 0, 0, "4", 4), "off-palette");
    expectGridError(() => setPixel(base, 0, 0, "f", 15), "off-palette");
  });

  it("accepts the highest index the palette actually has", () => {
    expect(setPixel(base, 0, 0, "3", 4)[0]).toBe("3...");
    expect(setPixel(base, 0, 0, "f", 16)[0]).toBe("f...");
  });

  it.each(["g", "z", "-", " ", "", "00", "#"])(
    "rejects the non-encoding character %j as bad-char",
    (ch) => {
      expectGridError(() => setPixel(base, 0, 0, ch, 16), "bad-char");
    },
  );

  it("rejects uppercase 'A' as bad-char rather than treating it as index 10", () => {
    const err = expectGridError(() => setPixel(base, 0, 0, "A", 16), "bad-char");
    expect(err.message).toContain("A");
  });

  it("checks bounds before the character, so a bad call reports its first defect", () => {
    expectGridError(() => setPixel(base, 99, 99, "g", 16), "out-of-bounds");
  });

  it("throws a GridError that is also an Error and names itself", () => {
    const err = expectGridError(() => setPixel(base, 99, 0, "1", 16), "out-of-bounds");
    expect(err.name).toBe("GridError");
    expect(err instanceof Error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fillRow
// ---------------------------------------------------------------------------

describe("fillRow", () => {
  const base: Grid = [".....", ".....", "....."];

  it("fills inclusively of x1", () => {
    const next = fillRow(base, 1, 1, 3, "2", 16);
    expect(next[1]).toBe(".222.");
    expect(next[1]?.split("").filter((c) => c === "2")).toHaveLength(3);
  });

  it("fills a single cell when x0 === x1", () => {
    expect(fillRow(base, 0, 2, 2, "1", 16)[0]).toBe("..1..");
  });

  it("fills the whole row from 0 to w-1", () => {
    expect(fillRow(base, 2, 0, 4, "7", 16)[2]).toBe("77777");
  });

  it("can clear a run back to transparent", () => {
    const painted = fillRow(base, 0, 0, 4, "1", 16);
    expect(fillRow(painted, 0, 1, 3, TRANSPARENT, 16)[0]).toBe("1...1");
  });

  it("returns a new grid and leaves the original untouched", () => {
    const original: Grid = [".....", ".....", "....."];
    const snapshot = original.slice();
    const next = fillRow(original, 0, 0, 4, "1", 16);
    expect(next).not.toBe(original);
    expect(original).toEqual(snapshot);
  });

  it("does not write through a frozen input grid", () => {
    const g = frozen([".....", ".....", "....."]);
    expect(fillRow(g, 0, 0, 1, "1", 16)[0]).toBe("11...");
    expect(g[0]).toBe(".....");
  });

  it("rejects a reversed range", () => {
    const err = expectGridError(() => fillRow(base, 0, 3, 1, "1", 16), "out-of-bounds");
    expect(err.message).toMatch(/3/);
    expect(err.message).toMatch(/1/);
  });

  it.each([-1, 3, 99, 1.5, NaN])("rejects the out-of-range row y=%p", (y) => {
    expectGridError(() => fillRow(base, y, 0, 1, "1", 16), "out-of-bounds");
  });

  it.each([
    [-1, 2],
    [0, 5],
    [0, 99],
    [1.5, 3],
    [0, 2.5],
  ])("rejects the out-of-range span (%p, %p)", (x0, x1) => {
    expectGridError(() => fillRow(base, 0, x0, x1, "1", 16), "out-of-bounds");
  });

  it("validates the character exactly as setPixel does", () => {
    expectGridError(() => fillRow(base, 0, 0, 2, "g", 16), "bad-char");
    expectGridError(() => fillRow(base, 0, 0, 2, "A", 16), "bad-char");
    expectGridError(() => fillRow(base, 0, 0, 2, "9", 4), "off-palette");
  });

  it("agrees cell-for-cell with repeated setPixel calls", () => {
    const filled = fillRow(base, 1, 1, 3, "5", 16);
    let stepwise: Grid = base;
    for (let x = 1; x <= 3; x++) stepwise = setPixel(stepwise, x, 1, "5", 16);
    expect(filled).toEqual(stepwise);
  });
});

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

describe("diff", () => {
  it("returns [] for identical grids — the empty-diff stop condition", () => {
    const a: Grid = ["01", "23"];
    expect(diff(a, ["01", "23"])).toEqual([]);
    expect(diff(a, a)).toEqual([]);
  });

  it("returns one entry per changed cell with the right from/to", () => {
    const a: Grid = ["01", "23"];
    const b: Grid = ["0a", "23"];
    expect(diff(a, b)).toEqual([{ x: 1, y: 0, from: "1", to: "a" }]);
  });

  it("reports every changed cell, in row-major order", () => {
    const a: Grid = ["00", "00"];
    const b: Grid = ["10", "12"];
    expect(diff(a, b)).toEqual([
      { x: 0, y: 0, from: "0", to: "1" },
      { x: 0, y: 1, from: "0", to: "1" },
      { x: 1, y: 1, from: "0", to: "2" },
    ]);
  });

  it("records painting over transparent and clearing back to transparent", () => {
    expect(diff(["..", ".."], ["1.", ".."])).toEqual([
      { x: 0, y: 0, from: ".", to: "1" },
    ]);
    expect(diff(["1.", ".."], ["..", ".."])).toEqual([
      { x: 0, y: 0, from: "1", to: "." },
    ]);
  });

  it("is antisymmetric: swapping the arguments swaps from and to", () => {
    const a: Grid = ["01"];
    const b: Grid = ["0f"];
    expect(diff(b, a)).toEqual([{ x: 1, y: 0, from: "f", to: "1" }]);
  });

  it("counts every cell of a fully repainted grid", () => {
    expect(diff(makeEmpty(4, 4), Array(4).fill("1111"))).toHaveLength(16);
  });

  it("mutating one grid via setPixel yields exactly that one diff entry", () => {
    const a = makeEmpty(8, 8);
    const b = setPixel(a, 5, 6, "c", 16);
    expect(diff(a, b)).toEqual([{ x: 5, y: 6, from: ".", to: "c" }]);
  });

  it("rejects grids of differing dimensions rather than comparing an overlap", () => {
    expectGridError(() => diff(["00", "00"], ["000", "000"]), "out-of-bounds");
    expectGridError(() => diff(["00"], ["00", "00"]), "out-of-bounds");
  });

  it("does not mutate either input", () => {
    const a = frozen(["01"]);
    const b = frozen(["0f"]);
    diff(a, b);
    expect(a).toEqual(["01"]);
    expect(b).toEqual(["0f"]);
  });
});
