import { describe, expect, it } from "vitest";

import { charIndex } from "@shared/grid";
import {
  CritiqueReportSchema,
  DEFAULT_HARNESS_CONFIG,
  DRAW_OP_NAMES,
  DraftFailureSchema,
  DrawOpSchema,
  HarnessConfigSchema,
  OP_COORD_LIMIT,
  IssueSchema,
  LintReportSchema,
  LintWarningSchema,
  PIPELINE_STATES,
  PipelineEventSchema,
  PipelineStateSchema,
  PixelDiffSchema,
  ReviseSummarySchema,
  RoundSchema,
  RoundTimingsSchema,
  STOP_REASONS,
  SessionHistorySchema,
  SizeSchema,
  SpriteDocSchema,
  StopReasonSchema,
  type ChatMessage,
  type ChatTurn,
  type Issue,
  type PipelineState,
  type SpriteDoc,
  type StopReason,
  type ToolCall,
  type ToolDef,
} from "@shared/schema";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const row16 = (ch = ".") => ch.repeat(16);

/** `n` rows of `n` characters — a square canvas of the only three legal sizes. */
const squareRows = (n: number, ch = ".") =>
  Array.from({ length: n }, () => ch.repeat(n));

function validDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "doc-1",
    createdAt: "2026-07-28T12:00:00.000Z",
    prompt: "a red fox, sitting",
    intent: { subject: "red fox, sitting", facing: "side" },
    size: { w: 16, h: 16 },
    palette: { id: "gameboy", colors: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"] },
    rows: Array.from({ length: 16 }, () => row16()),
    meta: {
      generatorModel: "qwen3:8b",
      criticModel: "qwen3-vl:8b-instruct-q4_K_M",
      // 1, not 0: spec §7.5 pins the draft as round 1, so a doc carrying round
      // 0 describes a round that cannot exist. The default fixture has to be a
      // document production could actually emit, or every test that builds on it
      // is asserting against an unreachable state.
      round: 1,
      repairs: 0,
      parentId: null,
    },
    ...over,
  };
}

/** `validDoc` with only `meta` overridden — the rest of the doc left well-formed. */
const docWithMeta = (metaOver: Record<string, unknown>) =>
  validDoc({ meta: { ...(validDoc().meta as object), ...metaOver } });

/** A blank doc at any of the three square sizes. */
function squareDoc(n: 16 | 32 | 64, over: Record<string, unknown> = {}) {
  return validDoc({ size: { w: n, h: n }, rows: squareRows(n), ...over });
}

/**
 * A 16-entry palette, for the cases that exercise the whole `0`-`f` encoding.
 * `validDoc`'s default palette is `gameboy` — four colours — so under spec §6.3
 * amendment A4 a doc using index 4 or above has to declare a palette that
 * actually has those entries.
 */
const PALETTE_16 = {
  id: "pico-8",
  colors: [
    "#000000", "#1d2b53", "#7e2553", "#008751",
    "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
    "#ff004d", "#ffa300", "#ffec27", "#00e436",
    "#29adff", "#83769c", "#ff77a8", "#ffccaa",
  ],
};

const validIssue = (over: Partial<Issue> = {}) => ({
  id: "i1",
  region: [0, 0, 15, 15],
  severity: "high",
  issue: "the ears read as ambiguous",
  suggest: "darken the inner ear",
  confidence: 0.9,
  suggestConfidence: 0.6,
  ...over,
});

const validCritique = (issues: unknown[] = [validIssue()]) => ({
  readsAs: "a red fox, though the ears are ambiguous",
  matchesIntent: true,
  overall: 4,
  issues,
});

const validLint = () => ({
  warnings: [],
  metrics: { coverage: 0.5, paletteUsed: 3, orphanCount: 0, symmetryScore: 1 },
});

const validTimings = () => ({ draftMs: 31_400, critiqueMs: 12_100, reviseMs: null });

/**
 * A round in the shape spec §6.7 defines. `diffFromPrev` is `null` on round 1 —
 * that is the whole point of the nullability, so the default fixture spells it.
 */
function validRound(n = 1, over: Record<string, unknown> = {}) {
  return {
    round: n,
    doc: validDoc({ meta: { ...(validDoc().meta as object), round: n } }),
    lint: validLint(),
    critique: validCritique(),
    filteredIssues: [validIssue()],
    diffFromPrev: n === 1 ? null : [{ x: 1, y: 1, from: ".", to: "2" }],
    userFeedback: null,
    revise: null,
    timings: validTimings(),
    ...over,
  };
}

function validHistory(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sessionId: "s-1",
    config: DEFAULT_HARNESS_CONFIG,
    rounds: [validRound(1)],
    draftFailures: [],
    stopReason: "no-high-severity",
    finalState: "AWAITING_USER",
    outcome: "completed",
    error: null,
    acceptedRound: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// SizeSchema — spec §6.2. Square only.
// ---------------------------------------------------------------------------

describe("SizeSchema", () => {
  it.each([16, 32, 64])("accepts the %i square", (n) => {
    expect(SizeSchema.parse({ w: n, h: n })).toEqual({ w: n, h: n });
  });

  it("rejects w = 24", () => {
    expect(SizeSchema.safeParse({ w: 24, h: 16 }).success).toBe(false);
  });

  it("rejects h = 24", () => {
    expect(SizeSchema.safeParse({ w: 16, h: 24 }).success).toBe(false);
  });

  // -- the v1 shape typed w and h as two independent unions, so all nine
  // combinations parsed while every consumer assumed three. --------------------

  it.each([
    [16, 32],
    [16, 64],
    [32, 16],
    [32, 64],
    [64, 16],
    [64, 32],
  ])("rejects the non-square %ix%i", (w, h) => {
    expect(SizeSchema.safeParse({ w, h }).success).toBe(false);
  });

  it("rejects a size missing h", () => {
    expect(SizeSchema.safeParse({ w: 32 }).success).toBe(false);
  });

  it("rejects a non-square doc even though both dimensions are legal alone", () => {
    const bad = validDoc({
      size: { w: 16, h: 64 },
      rows: Array.from({ length: 64 }, () => row16()),
    });
    expect(SpriteDocSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SpriteDocSchema — spec §6.1 / §6.2
// ---------------------------------------------------------------------------

describe("SpriteDocSchema", () => {
  it("accepts a well-formed 16x16 doc", () => {
    const parsed = SpriteDocSchema.parse(validDoc());
    expect(parsed.rows).toHaveLength(16);
    expect(parsed.size).toEqual({ w: 16, h: 16 });
  });

  it("rejects a doc with 32 rows that declares size.h = 16", () => {
    const bad = validDoc({ rows: Array.from({ length: 32 }, () => row16()) });
    const res = SpriteDocSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(JSON.stringify(res.error.issues)).toMatch(/rows/);
    }
  });

  it("rejects a doc with too few rows", () => {
    const bad = validDoc({ rows: Array.from({ length: 15 }, () => row16()) });
    expect(SpriteDocSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a row shorter than size.w", () => {
    const rows = Array.from({ length: 16 }, () => row16());
    rows[4] = ".".repeat(15);
    expect(SpriteDocSchema.safeParse(validDoc({ rows })).success).toBe(false);
  });

  it("rejects a row longer than size.w", () => {
    const rows = Array.from({ length: 16 }, () => row16());
    rows[9] = ".".repeat(17);
    expect(SpriteDocSchema.safeParse(validDoc({ rows })).success).toBe(false);
  });

  it("rejects a row containing 'g' — only '.' and 0-f encode a pixel", () => {
    const rows = Array.from({ length: 16 }, () => row16());
    rows[0] = "g" + ".".repeat(15);
    expect(SpriteDocSchema.safeParse(validDoc({ rows })).success).toBe(false);
  });

  it("accepts every legal row character", () => {
    // The palette has to carry all 16 entries for all 16 indices to be legal —
    // spec §6.3 amendment A4. This fixture used the 4-colour `gameboy` default
    // and passed, which was the defect itself.
    const rows = Array.from({ length: 16 }, () => "0123456789abcdef");
    expect(
      SpriteDocSchema.safeParse(validDoc({ rows, palette: PALETTE_16 })).success,
    ).toBe(true);
  });

  it("rejects size.w = 24 inside a doc", () => {
    const bad = validDoc({
      size: { w: 24, h: 16 },
      rows: Array.from({ length: 16 }, () => ".".repeat(24)),
    });
    expect(SpriteDocSchema.safeParse(bad).success).toBe(false);
  });

  it("validates a 32x32 doc against its own declared size", () => {
    expect(SpriteDocSchema.safeParse(squareDoc(32)).success).toBe(true);
  });

  it("defaults meta.repairedRows to an empty list", () => {
    const parsed: SpriteDoc = SpriteDocSchema.parse(validDoc());
    expect(parsed.meta.repairedRows).toEqual([]);
  });

  // -- meta.round is 1-based — spec §7.5 pins the draft as round 1 -----------
  //
  // `nonnegative()` admitted `round: 0`, so a 0-based pipeline would have
  // written a whole session of docs the schema could not object to, and the
  // off-by-one would only surface in the filmstrip labels and the bench CSV.

  it("rejects meta.round = 0 — the draft is round 1, not round 0", () => {
    const res = SpriteDocSchema.safeParse(docWithMeta({ round: 0 }));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "meta.round")).toBe(true);
    }
  });

  it("accepts meta.round = 1 — the paired accept", () => {
    // Proves the rejection above is about the value, not about the field being
    // present at all.
    const parsed = SpriteDocSchema.parse(docWithMeta({ round: 1 }));
    expect(parsed.meta.round).toBe(1);
  });

  it("accepts a later meta.round", () => {
    expect(SpriteDocSchema.parse(docWithMeta({ round: 7 })).meta.round).toBe(7);
  });

  it.each([-1, 1.5])("rejects meta.round = %s", (r) => {
    expect(SpriteDocSchema.safeParse(docWithMeta({ round: r })).success).toBe(false);
  });

  it("still admits meta.repairs = 0 — repairs count from zero, rounds do not", () => {
    // The two fields sit side by side and only one of them is 1-based. A blanket
    // `positive()` across the meta block would make an unrepaired draft — the
    // good case — unrepresentable.
    expect(SpriteDocSchema.parse(docWithMeta({ repairs: 0 })).meta.repairs).toBe(0);
  });

  // -- spec §6.3 amendment A4: off-palette indices are unrepresentable -------

  it("rejects a 4-colour gameboy doc whose row 0 is all 'f'", () => {
    // The exact document the Wave 2 reviewer confirmed parsed successfully:
    // palette.colors.length === 4, yet every character indexes entry 15, where
    // `palette.colors[15]` is `undefined` by the time the renderer reads it.
    const rows = Array.from({ length: 16 }, () => row16());
    rows[0] = "ffffffffffffffff";
    const res = SpriteDocSchema.safeParse(validDoc({ rows }));
    expect(res.success).toBe(false);
  });

  it("names the offending row and character in the error", () => {
    const rows = Array.from({ length: 16 }, () => row16());
    rows[9] = "..3." + "..f." + "...." + "....";
    const res = SpriteDocSchema.safeParse(validDoc({ rows }));
    expect(res.success).toBe(false);
    if (!res.success) {
      const serialized = JSON.stringify(res.error.issues);
      expect(serialized).toMatch(/row 9/);
      expect(serialized).toMatch(/'f'/); // the offending character, quoted
      expect(serialized).toMatch(/char 6/); // and where in the row it sits
      // The path points at the row, so a UI can highlight it without parsing
      // the message.
      expect(res.error.issues.some((i) => i.path.join(".") === "rows.9")).toBe(true);
    }
  });

  it("accepts the highest index its palette has and rejects the next one", () => {
    const rowsOk = Array.from({ length: 16 }, () => row16());
    rowsOk[0] = "3" + ".".repeat(15); // gameboy has entries 0-3
    expect(SpriteDocSchema.safeParse(validDoc({ rows: rowsOk })).success).toBe(true);

    const rowsBad = Array.from({ length: 16 }, () => row16());
    rowsBad[0] = "4" + ".".repeat(15);
    expect(SpriteDocSchema.safeParse(validDoc({ rows: rowsBad })).success).toBe(false);
  });

  it("accepts the same rows once the palette actually carries 16 colours", () => {
    const rows = Array.from({ length: 16 }, () => row16());
    rows[0] = "ffffffffffffffff";
    expect(
      SpriteDocSchema.safeParse(validDoc({ rows, palette: PALETTE_16 })).success,
    ).toBe(true);
  });

  it("keeps '.' legal no matter how small the palette is", () => {
    const doc = validDoc({
      palette: { id: "tiny", colors: ["#000000", "#111111", "#222222", "#333333"] },
    });
    expect(SpriteDocSchema.safeParse(doc).success).toBe(true);
  });

  it("rejects an off-palette character in the last column of its row", () => {
    // x === size.w - 1. Every other off-palette fixture here sits at x = 0 or
    // x = 6, or fills its row — and a filled row's per-row `break` fires at
    // x = 0 — so a loop bound of `x < row.length - 1` would pass all of them
    // while letting this doc reach the renderer with `colors[15] === undefined`.
    const rows = Array.from({ length: 16 }, () => row16());
    rows[3] = ".".repeat(15) + "f";
    const res = SpriteDocSchema.safeParse(validDoc({ rows }));
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("rows.3");
      expect(JSON.stringify(res.error.issues)).toMatch(/row 3 char 15 is 'f'/);
    }
  });

  it("rejects an off-palette character on the last row of the document", () => {
    // y === size.h - 1. The other off-palette fixtures live on rows 0, 2, 5 and
    // 9, so a refinement that stops one row short of the end passes them all.
    const rows = Array.from({ length: 16 }, () => row16());
    rows[15] = "f" + ".".repeat(15);
    const res = SpriteDocSchema.safeParse(validDoc({ rows }));
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("rows.15");
      expect(JSON.stringify(res.error.issues)).toMatch(/row 15 char 0 is 'f'/);
    }
  });

  it("rejects an off-palette character in the last column of the last row", () => {
    // Both bounds at once: the single cell an off-by-one on either axis hides.
    const rows = Array.from({ length: 16 }, () => row16());
    rows[15] = ".".repeat(15) + "e";
    const res = SpriteDocSchema.safeParse(validDoc({ rows }));
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("rows.15");
      expect(JSON.stringify(res.error.issues)).toMatch(/row 15 char 15 is 'e'/);
    }
  });

  it("reports one issue per offending row, not one per document", () => {
    // Five offending characters over two rows. Both halves of the name are
    // counted, not merely searched for: two issues in total (per row, not one
    // document-level summary) and exactly one apiece (per row, not per
    // character) — `toContain` alone cannot tell those apart.
    const rows = Array.from({ length: 16 }, () => row16());
    rows[2] = "9" + ".".repeat(6) + "b" + ".".repeat(7) + "d";
    rows[5] = "a" + ".".repeat(14) + "e";
    const res = SpriteDocSchema.safeParse(validDoc({ rows }));
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("rows.2");
      expect(paths).toContain("rows.5");
      expect(paths.filter((p) => p === "rows.2")).toHaveLength(1);
      expect(paths.filter((p) => p === "rows.5")).toHaveLength(1);
      expect(paths).toHaveLength(2);
    }
  });

  it("emits exactly one issue for a row holding four off-palette characters", () => {
    // The per-row `break`, pinned by count. Four faults on row 7, including one
    // in the last column; the refinement reports the first and stops.
    const rows = Array.from({ length: 16 }, () => row16());
    rows[7] = "f" + ".".repeat(3) + "9" + ".".repeat(4) + "e" + ".".repeat(5) + "c";
    expect(rows[7]).toHaveLength(16);
    const res = SpriteDocSchema.safeParse(validDoc({ rows }));
    expect(res.success).toBe(false);
    if (!res.success) {
      const row7 = res.error.issues.filter((i) => i.path.join(".") === "rows.7");
      expect(row7).toHaveLength(1);
      expect(res.error.issues).toHaveLength(1);
      // ...and it is the first fault in the row that gets named.
      expect(row7[0].message).toMatch(/row 7 char 0 is 'f'/);
    }
  });

  it.each([4, 16])(
    "at a %i-colour palette accepts exactly the characters charIndex allows",
    (size) => {
      // Pins the schema's local index mirror against `shared/grid.ts`'s
      // `charIndex`, so the two encodings cannot drift apart.
      const palette = { id: "probe", colors: PALETTE_16.colors.slice(0, size) };
      for (const c of [...".0123456789abcdef", "g", "A", "F", "z", "/"]) {
        const rows = Array.from({ length: 16 }, () => row16());
        rows[0] = c + ".".repeat(15);
        const expected = c === "." || (charIndex(c) >= 0 && charIndex(c) < size);
        expect(SpriteDocSchema.safeParse(validDoc({ rows, palette })).success).toBe(
          expected,
        );
      }
    },
  );

  // -- A4 at the larger canvases (plan step 2c.5) ----------------------------
  //
  // Every A4 fixture above is 16x16 at palette size 4 or 16, so a refinement
  // gated on `size.w === 16` — or one that reads a hard-coded 16 as the row
  // width or row count — passes the entire suite. These pin the same rule at
  // the other two legal canvases.

  it("rejects an off-palette character at 32x32", () => {
    const rows = squareRows(32);
    rows[20] = ".".repeat(9) + "9" + ".".repeat(22);
    const res = SpriteDocSchema.safeParse(squareDoc(32, { rows }));
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("rows.20");
      expect(JSON.stringify(res.error.issues)).toMatch(/row 20 char 9 is '9'/);
    }
  });

  it("rejects an off-palette character in the last cell of a 32x32 canvas", () => {
    // (31, 31): the cell that both an x and a y off-by-one hide, at a size no
    // other fixture visits.
    const rows = squareRows(32);
    rows[31] = ".".repeat(31) + "f";
    const res = SpriteDocSchema.safeParse(squareDoc(32, { rows }));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(JSON.stringify(res.error.issues)).toMatch(/row 31 char 31 is 'f'/);
    }
  });

  it("accepts the same 32x32 rows once the palette carries 16 colours", () => {
    // The paired accept: proves the rejection above is about the palette, not
    // about the canvas size or the character.
    const rows = squareRows(32);
    rows[20] = ".".repeat(9) + "9" + ".".repeat(22);
    rows[31] = ".".repeat(31) + "f";
    expect(
      SpriteDocSchema.safeParse(squareDoc(32, { rows, palette: PALETTE_16 })).success,
    ).toBe(true);
  });

  it("rejects an off-palette character at 64x64", () => {
    const rows = squareRows(64);
    rows[63] = ".".repeat(63) + "e";
    const res = SpriteDocSchema.safeParse(squareDoc(64, { rows }));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(JSON.stringify(res.error.issues)).toMatch(/row 63 char 63 is 'e'/);
    }
  });

  it("still checks row width at 32x32", () => {
    const rows = squareRows(32);
    rows[7] = ".".repeat(31);
    expect(SpriteDocSchema.safeParse(squareDoc(32, { rows })).success).toBe(false);
  });

  it("rejects an off-palette doc nested in a SessionHistory round", () => {
    const rows = Array.from({ length: 16 }, () => row16());
    rows[0] = "ffffffffffffffff";
    const bad = validHistory({
      rounds: [validRound(1, { doc: validDoc({ rows }) })],
    });
    // The rest of the history is well-formed, so the only thing this can fail
    // on is the nested doc.
    expect(SessionHistorySchema.safeParse(validHistory()).success).toBe(true);
    expect(SessionHistorySchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IssueSchema / CritiqueReportSchema — spec §6.4
// ---------------------------------------------------------------------------

describe("IssueSchema", () => {
  it("accepts a well-formed issue", () => {
    expect(IssueSchema.safeParse(validIssue()).success).toBe(true);
  });

  it.each([1.4, -0.1])("rejects confidence %s (outside 0..1)", (c) => {
    expect(IssueSchema.safeParse(validIssue({ confidence: c })).success).toBe(false);
  });

  it.each([1.4, -0.1])("rejects suggestConfidence %s (outside 0..1)", (c) => {
    expect(IssueSchema.safeParse(validIssue({ suggestConfidence: c })).success).toBe(false);
  });

  it.each([0, 1])("accepts confidence at the %s boundary", (c) => {
    expect(IssueSchema.safeParse(validIssue({ confidence: c })).success).toBe(true);
  });

  it("rejects severity 'critical' — exactly high | medium | low", () => {
    expect(
      IssueSchema.safeParse(validIssue({ severity: "critical" as never })).success,
    ).toBe(false);
  });

  it.each(["high", "medium", "low"] as const)("accepts severity %s", (s) => {
    expect(IssueSchema.safeParse(validIssue({ severity: s })).success).toBe(true);
  });

  it("accepts an empty suggest — filterIssues withholds low-confidence guesses", () => {
    expect(IssueSchema.safeParse(validIssue({ suggest: "" })).success).toBe(true);
  });

  it("rejects a region that is not a 4-tuple", () => {
    expect(IssueSchema.safeParse(validIssue({ region: [0, 0, 15] as never })).success).toBe(
      false,
    );
  });

  it("rejects a negative region coordinate", () => {
    expect(
      IssueSchema.safeParse(validIssue({ region: [-1, 0, 15, 15] as never })).success,
    ).toBe(false);
  });

  it("rejects a non-integer region coordinate", () => {
    expect(
      IssueSchema.safeParse(validIssue({ region: [0.5, 0, 15, 15] as never })).success,
    ).toBe(false);
  });
});

describe("CritiqueReportSchema", () => {
  it("accepts a well-formed report", () => {
    expect(CritiqueReportSchema.safeParse(validCritique()).success).toBe(true);
  });

  it("accepts a report with zero issues", () => {
    expect(CritiqueReportSchema.safeParse(validCritique([])).success).toBe(true);
  });

  it("rejects an issue with confidence 1.4", () => {
    const bad = validCritique([validIssue({ confidence: 1.4 })]);
    expect(CritiqueReportSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an issue with severity 'critical'", () => {
    const bad = validCritique([validIssue({ severity: "critical" as never })]);
    expect(CritiqueReportSchema.safeParse(bad).success).toBe(false);
  });

  it.each([1, 2, 3, 4, 5])("accepts overall = %i", (n) => {
    expect(CritiqueReportSchema.safeParse({ ...validCritique(), overall: n }).success).toBe(
      true,
    );
  });

  it.each([0, 6])("rejects overall = %i", (n) => {
    expect(CritiqueReportSchema.safeParse({ ...validCritique(), overall: n }).success).toBe(
      false,
    );
  });

  // -- degraded reports (spec §6.4) -----------------------------------------
  //
  // A degraded report previously had to invent a 1-5 score and a `readsAs`
  // sentence, which then landed in `SessionHistory` and polluted every
  // bench-derived quality metric.

  it("accepts the degraded report spec §6.4 names, verbatim", () => {
    const degraded = {
      readsAs: null,
      matchesIntent: false,
      overall: null,
      degraded: true,
      issues: [],
    };
    const parsed = CritiqueReportSchema.parse(degraded);
    expect(parsed.degraded).toBe(true);
    expect(parsed.overall).toBeNull();
    expect(parsed.readsAs).toBeNull();
  });

  it("accepts overall = null on its own", () => {
    const parsed = CritiqueReportSchema.parse({ ...validCritique(), overall: null });
    expect(parsed.overall).toBeNull();
  });

  it("accepts readsAs = null on its own", () => {
    const parsed = CritiqueReportSchema.parse({ ...validCritique(), readsAs: null });
    expect(parsed.readsAs).toBeNull();
  });

  it("carries degraded: false on a report that parsed cleanly", () => {
    // The critic never emits this field — it is a harness-side verdict, and
    // §6.4's repair table does not list it. A clean report therefore has to
    // arrive at `false` without the model's help, or every real critique would
    // fail validation and degrade.
    const parsed = CritiqueReportSchema.parse(validCritique());
    expect(parsed.degraded).toBe(false);
  });

  it("keeps an explicit degraded: true rather than overwriting it", () => {
    const parsed = CritiqueReportSchema.parse({ ...validCritique(), degraded: true });
    expect(parsed.degraded).toBe(true);
  });

  it("rejects a non-boolean degraded", () => {
    expect(
      CritiqueReportSchema.safeParse({ ...validCritique(), degraded: "yes" }).success,
    ).toBe(false);
  });

  it("still rejects matchesIntent = null — only overall and readsAs are nullable", () => {
    expect(
      CritiqueReportSchema.safeParse({ ...validCritique(), matchesIntent: null }).success,
    ).toBe(false);
  });

  it("still rejects issues = null", () => {
    expect(
      CritiqueReportSchema.safeParse({ ...validCritique(), issues: null }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LintWarningSchema / LintReportSchema — spec §6.5
// ---------------------------------------------------------------------------

describe("LintWarningSchema", () => {
  it.each([
    "orphan-pixel",
    "unused-palette-entry",
    "low-contrast",
    "outline-gap",
    "row-repaired",
  ])("accepts warning code %s", (code) => {
    expect(
      LintWarningSchema.safeParse({ code, cells: [[1, 2]], message: "m" }).success,
    ).toBe(true);
  });

  it("rejects a warning code outside the spec table", () => {
    expect(
      LintWarningSchema.safeParse({ code: "anti-aliased", cells: [], message: "m" })
        .success,
    ).toBe(false);
  });

  it("rejects a cell that is not an [x, y] pair", () => {
    expect(
      LintWarningSchema.safeParse({ code: "orphan-pixel", cells: [[1]], message: "m" })
        .success,
    ).toBe(false);
  });

  // -- `indices` (spec §6.5) ------------------------------------------------
  //
  // "so consumers do not have to regex free text to learn which palette entry a
  // warning concerns." A `low-contrast` warning carries the pair, an
  // `unused-palette-entry` carries the single index.

  it("keeps the index pair a low-contrast warning concerns", () => {
    const parsed = LintWarningSchema.parse({
      code: "low-contrast",
      cells: [
        [3, 4],
        [4, 4],
      ],
      indices: [2, 3],
      message: "indices 2 and 3 differ by 0.079 in relative luminance",
    });
    expect(parsed.indices).toEqual([2, 3]);
  });

  it("keeps the single index an unused-palette-entry warning concerns", () => {
    const parsed = LintWarningSchema.parse({
      code: "unused-palette-entry",
      cells: [],
      indices: [7],
      message: "palette index 7 is never used",
    });
    expect(parsed.indices).toEqual([7]);
    expect(parsed.cells).toEqual([]);
  });

  it("leaves indices absent on the codes that do not carry one", () => {
    const parsed = LintWarningSchema.parse({
      code: "orphan-pixel",
      cells: [[1, 2]],
      message: "m",
    });
    expect(parsed.indices).toBeUndefined();
    expect("indices" in parsed).toBe(false);
  });

  it.each([16, 99, -1, 1.5])("rejects the unencodable index %s", (i) => {
    expect(
      LintWarningSchema.safeParse({
        code: "unused-palette-entry",
        cells: [],
        indices: [i],
        message: "m",
      }).success,
    ).toBe(false);
  });

  it("rejects indices that is not an array", () => {
    expect(
      LintWarningSchema.safeParse({
        code: "low-contrast",
        cells: [],
        indices: 3,
        message: "m",
      }).success,
    ).toBe(false);
  });
});

describe("LintReportSchema", () => {
  it("accepts a report with no errors field — there is no errors field", () => {
    expect(LintReportSchema.safeParse(validLint()).success).toBe(true);
  });

  it("rejects a symmetryScore above 1", () => {
    const bad = { ...validLint(), metrics: { ...validLint().metrics, symmetryScore: 1.2 } };
    expect(LintReportSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts symmetryScore 1 on a blank sprite — 0/0 is trivially symmetric", () => {
    const blank = {
      warnings: [],
      metrics: { coverage: 0, paletteUsed: 0, orphanCount: 0, symmetryScore: 1 },
    };
    expect(LintReportSchema.safeParse(blank).success).toBe(true);
  });

  it("rejects NaN as a symmetryScore", () => {
    // `0/0` on an all-transparent sprite. NaN serializes to `null`, so without
    // this it surfaces as an opaque round-trip failure two stages from cause.
    const bad = {
      warnings: [],
      metrics: { coverage: 0, paletteUsed: 0, orphanCount: 0, symmetryScore: NaN },
    };
    expect(LintReportSchema.safeParse(bad).success).toBe(false);
  });

  // -- ruling R3: `errors` is deleted, not deprecated ------------------------

  it("rejects a report carrying an empty errors array", () => {
    // The shape amendment A2 shipped and ruling R3 deleted. A stale producer
    // must fail loudly rather than have the field silently stripped — a
    // stripped `errors` is a schema violation the pipeline was told about and
    // then forgot.
    expect(LintReportSchema.safeParse({ ...validLint(), errors: [] }).success).toBe(false);
  });

  it("rejects a report carrying a populated errors array", () => {
    expect(
      LintReportSchema.safeParse({
        ...validLint(),
        errors: ["rows.length !== size.h"],
      }).success,
    ).toBe(false);
  });

  it("a parsed report has no errors key at all", () => {
    const parsed = LintReportSchema.parse(validLint());
    expect("errors" in parsed).toBe(false);
  });

  it("rejects any unknown key, not just errors", () => {
    // Pins the mechanism: the report is a closed vocabulary, so the rejection
    // above cannot be satisfied by special-casing one field name.
    expect(
      LintReportSchema.safeParse({ ...validLint(), severity: "high" }).success,
    ).toBe(false);
  });

  it("rejects a round whose lint report carries errors", () => {
    const bad = validRound(1, { lint: { ...validLint(), errors: [] } });
    expect(RoundSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DrawOpSchema — spec §6.2a, amendment A10
// ---------------------------------------------------------------------------

describe("DrawOpSchema", () => {
  it("accepts one instance of each of the five ops §6.2a lists", () => {
    const ops: unknown[] = [
      { op: "ellipse", cx: 8, cy: 6, rx: 4, ry: 3, index: "4" },
      { op: "fill_rect", x0: 5, y0: 9, x1: 10, y1: 13, index: "4" },
      { op: "line", x0: 3, y0: 2, x1: 6, y1: 5, index: "0" },
      { op: "mirror_x", axis: 8 },
      { op: "clear", x0: 0, y0: 0, x1: 3, y1: 3 },
    ];
    for (const op of ops) expect(DrawOpSchema.safeParse(op).success).toBe(true);
    expect(ops).toHaveLength(DRAW_OP_NAMES.length);
  });

  it("names exactly the five ops, in the order §6.2a lists them", () => {
    expect(DRAW_OP_NAMES).toEqual(["ellipse", "fill_rect", "line", "mirror_x", "clear"]);
  });

  it("takes `index` as a row CHARACTER, not a number", () => {
    // The model is shown the palette as `0 = #0f380f`, so `"0"` is the
    // vocabulary it already has. Two spellings of one idea is how `"0"` — black,
    // the commonest outline colour — ends up dropped by a falsy check.
    expect(DrawOpSchema.safeParse({ op: "mirror_x", axis: 8 }).success).toBe(true);
    expect(
      DrawOpSchema.safeParse({ op: "line", x0: 0, y0: 0, x1: 1, y1: 1, index: 0 }).success,
    ).toBe(false);
    expect(
      DrawOpSchema.safeParse({ op: "line", x0: 0, y0: 0, x1: 1, y1: 1, index: "0" }).success,
    ).toBe(true);
  });

  it("accepts '.' as an index and rejects uppercase and off-encoding characters", () => {
    const withIndex = (index: unknown) => ({ op: "fill_rect", x0: 0, y0: 0, x1: 1, y1: 1, index });
    expect(DrawOpSchema.safeParse(withIndex(".")).success).toBe(true);
    expect(DrawOpSchema.safeParse(withIndex("f")).success).toBe(true);
    expect(DrawOpSchema.safeParse(withIndex("F")).success).toBe(false);
    expect(DrawOpSchema.safeParse(withIndex("g")).success).toBe(false);
    expect(DrawOpSchema.safeParse(withIndex("11")).success).toBe(false);
  });

  it("admits a coordinate outside the canvas — applyOp clamps, §6.2a", () => {
    // `cx: 20` on a 16-wide canvas meant "near the right edge". Rejecting it in
    // the contract layer would make the clamp unreachable.
    expect(
      DrawOpSchema.safeParse({ op: "ellipse", cx: 20, cy: 8, rx: 8, ry: 4, index: "1" }).success,
    ).toBe(true);
    expect(
      DrawOpSchema.safeParse({ op: "fill_rect", x0: -9, y0: -9, x1: 4, y1: 4, index: "1" }).success,
    ).toBe(true);
  });

  it("bounds coordinates at OP_COORD_LIMIT so `line` cannot loop unboundedly", () => {
    const line = (x1: number) => ({ op: "line", x0: 0, y0: 0, x1, y1: 0, index: "1" });
    expect(DrawOpSchema.safeParse(line(OP_COORD_LIMIT)).success).toBe(true);
    expect(DrawOpSchema.safeParse(line(OP_COORD_LIMIT + 1)).success).toBe(false);
    expect(DrawOpSchema.safeParse(line(-OP_COORD_LIMIT - 1)).success).toBe(false);
    expect(OP_COORD_LIMIT).toBeGreaterThanOrEqual(64 * 8); // 8x the largest canvas
  });

  it("accepts a radius of 0 — a single pixel, which is how an eye is drawn", () => {
    // The zero case. `positive()` here erases every small detail in the sprite.
    expect(
      DrawOpSchema.safeParse({ op: "ellipse", cx: 4, cy: 4, rx: 0, ry: 0, index: "1" }).success,
    ).toBe(true);
    expect(
      DrawOpSchema.safeParse({ op: "ellipse", cx: 4, cy: 4, rx: -1, ry: 1, index: "1" }).success,
    ).toBe(false);
  });

  it("rejects a non-integer coordinate", () => {
    expect(
      DrawOpSchema.safeParse({ op: "line", x0: 0.5, y0: 0, x1: 1, y1: 1, index: "1" }).success,
    ).toBe(false);
  });

  it("gives mirror_x and clear no index — neither may be asked to paint", () => {
    expect(DrawOpSchema.safeParse({ op: "mirror_x", axis: 8, index: "1" }).success).toBe(false);
    expect(
      DrawOpSchema.safeParse({ op: "clear", x0: 0, y0: 0, x1: 1, y1: 1, index: "0" }).success,
    ).toBe(false);
  });

  it("is strict — a stray key is a model that invented a parameter", () => {
    expect(
      DrawOpSchema.safeParse({ op: "ellipse", cx: 4, cy: 4, rx: 2, ry: 2, index: "1", fill: true })
        .success,
    ).toBe(false);
  });

  it("rejects an op with a missing field rather than defaulting it", () => {
    expect(DrawOpSchema.safeParse({ op: "ellipse", cx: 4, cy: 4, rx: 2, index: "1" }).success).toBe(
      false,
    );
    expect(DrawOpSchema.safeParse({ op: "mirror_x" }).success).toBe(false);
  });

  it("rejects an unknown op name", () => {
    expect(DrawOpSchema.safeParse({ op: "flood_fill", x0: 0, y0: 0, index: "1" }).success).toBe(
      false,
    );
    expect(DrawOpSchema.safeParse({ op: "place_pixel", x: 0, y: 0, index: "1" }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// HarnessConfigSchema — spec §6.8
// ---------------------------------------------------------------------------

describe("HarnessConfigSchema", () => {
  it("parse({}) yields DEFAULT_HARNESS_CONFIG field for field", () => {
    expect(HarnessConfigSchema.parse({})).toEqual(DEFAULT_HARNESS_CONFIG);
  });

  it("DEFAULT_HARNESS_CONFIG holds the exact spec §6.8 values", () => {
    expect(DEFAULT_HARNESS_CONFIG).toEqual({
      maxRounds: 3,
      maxReviseTurns: 40,
      maxDraftRetries: 1,
      repairRejectThreshold: 0.2,
      confidenceFloor: 0.3,
      suggestConfidenceFloor: 0.5,
      stopOnNoHighSeverity: true,
      criticTargetPx: 512,
      callTimeoutMs: 120000,
      callTimeoutFloorMs: 45000,
      maxDraftBatches: 5,
      draftGaugeBar: { minColours: 3, minCoverage: 0.12, maxCoverage: 0.8, minDistinctRows: 8 },
      models: {
        generator: "qwen3-vl:8b-instruct-q4_K_M",
        critic: "qwen3-vl:8b-instruct-q4_K_M",
      },
    });
  });

  it("binds the GENERATOR to qwen3-vl, because qwen3:8b cannot draw", () => {
    // Pinned as its own named assertion rather than left to the field-for-field
    // comparison above, because this default is a measured finding and not a
    // preference: `captures/2026-07-30-generator-capability-benchmark.txt`
    // records `qwen3:8b` returning a solid rectangle for "8 lines of 8
    // characters" — the most forgiving format there is — while
    // `qwen3-vl:8b-instruct-q4_K_M` composed a recognisable fox from the same
    // subject and cleared A11's gauge bar in one batch live. Reverting this
    // binding reverts the app to a generator that cannot draw, and that must
    // fail with a sentence saying so rather than as one line of a 13-field diff.
    expect(DEFAULT_HARNESS_CONFIG.models.generator).toBe("qwen3-vl:8b-instruct-q4_K_M");
    expect(DEFAULT_HARNESS_CONFIG.models.generator).not.toBe("qwen3:8b");
    // And through the schema, which carries its own copy of the default: the
    // two are separate literals, so one can be changed without the other.
    expect(HarnessConfigSchema.parse({}).models.generator).toBe("qwen3-vl:8b-instruct-q4_K_M");
    expect(HarnessConfigSchema.parse({ models: {} }).models.generator).toBe(
      "qwen3-vl:8b-instruct-q4_K_M",
    );
  });

  it("binds both roles to one model, so a round costs no model swap", () => {
    // §3 predicted this as the payoff — "`qwen3-vl` also handles text-only
    // prompts, so both roles can be bound to it to eliminate model-swap stalls".
    expect(DEFAULT_HARNESS_CONFIG.models.generator).toBe(DEFAULT_HARNESS_CONFIG.models.critic);
  });

  it("DEFAULT_HARNESS_CONFIG itself round-trips through the schema", () => {
    expect(HarnessConfigSchema.parse(DEFAULT_HARNESS_CONFIG)).toEqual(
      DEFAULT_HARNESS_CONFIG,
    );
  });

  it("an override leaves every other field at its default", () => {
    const cfg = HarnessConfigSchema.parse({ maxRounds: 7 });
    expect(cfg.maxRounds).toBe(7);
    expect(cfg.maxReviseTurns).toBe(DEFAULT_HARNESS_CONFIG.maxReviseTurns);
    expect(cfg.models).toEqual(DEFAULT_HARNESS_CONFIG.models);
  });

  it("a partial models override still fills the other role", () => {
    const cfg = HarnessConfigSchema.parse({ models: { critic: "llava:13b" } });
    expect(cfg.models).toEqual({
      generator: "qwen3-vl:8b-instruct-q4_K_M",
      critic: "llava:13b",
    });
  });

  it("rejects a confidenceFloor outside 0..1", () => {
    expect(HarnessConfigSchema.safeParse({ confidenceFloor: 1.5 }).success).toBe(false);
  });

  it("rejects a non-integer maxRounds", () => {
    expect(HarnessConfigSchema.safeParse({ maxRounds: 2.5 }).success).toBe(false);
  });

  // -- criticUpscale -> criticTargetPx (spec §6.8) --------------------------

  it("defaults criticTargetPx to 512", () => {
    expect(HarnessConfigSchema.parse({}).criticTargetPx).toBe(512);
  });

  it("carries no criticUpscale on a defaulted config", () => {
    // A fixed x16 multiplier renders 64x64 to 1024px for the vision encoder to
    // downsample away. `criticTargetPx` is a target: the scale is derived as
    // `max(1, floor(criticTargetPx / size.w))`.
    expect("criticUpscale" in HarnessConfigSchema.parse({})).toBe(false);
    expect("criticUpscale" in DEFAULT_HARNESS_CONFIG).toBe(false);
  });

  it("honours a criticTargetPx override", () => {
    expect(HarnessConfigSchema.parse({ criticTargetPx: 256 }).criticTargetPx).toBe(256);
  });

  it.each([0, -1, 1.5])("rejects criticTargetPx = %s", (v) => {
    expect(HarnessConfigSchema.safeParse({ criticTargetPx: v }).success).toBe(false);
  });

  it("derives the spec's scale for each canvas from the default target", () => {
    // Pins the number against its purpose rather than against itself: 512 is
    // the value that keeps every legal canvas at or under ~512px.
    const { criticTargetPx } = HarnessConfigSchema.parse({});
    const scaleFor = (w: number) => Math.max(1, Math.floor(criticTargetPx / w));
    expect([16, 32, 64].map((w) => scaleFor(w) * w)).toEqual([512, 512, 512]);
  });

  // -- strict: an unknown key is a stale artifact, not a typo to ignore ------
  //
  // Spec §6.8 serializes the config into every `SessionHistory` so two
  // benchmark runs can be compared. A lenient schema silently drops a key it
  // does not recognize and substitutes today's default in its place — so a
  // history written against `criticUpscale: 16` re-parses claiming
  // `criticTargetPx: 512`, a limit that run never used. That is precisely "a
  // difference might come from the change under test or from a limit that was
  // altered and forgotten," the sentence §6.8 uses to justify its own
  // existence. Strict parsing turns a stale artifact into a loud failure.

  it("throws on criticUpscale: 16 rather than substituting criticTargetPx: 512", () => {
    // The literal pre-amendment field name. This is the exact artifact the
    // strictness exists to catch.
    expect(() => HarnessConfigSchema.parse({ criticUpscale: 16 })).toThrow();
  });

  it("does not silently yield the default target for a criticUpscale config", () => {
    const res = HarnessConfigSchema.safeParse({ criticUpscale: 16 });
    expect(res.success).toBe(false);
    // Belt and braces: the old failure mode was a *successful* parse whose
    // `criticTargetPx` read 512, so assert the substitution never happens.
    if (res.success) {
      expect((res.data as { criticTargetPx: number }).criticTargetPx).toBeUndefined();
    }
  });

  it("names the unrecognized key in the error", () => {
    const res = HarnessConfigSchema.safeParse({ criticUpscale: 16 });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(JSON.stringify(res.error.issues)).toMatch(/criticUpscale/);
    }
  });

  it.each(["maxTurns", "temperature", "criticUpscale", "schemaVersion"])(
    "rejects the unknown key %s",
    (k) => {
      expect(HarnessConfigSchema.safeParse({ [k]: 1 }).success).toBe(false);
    },
  );

  it("rejects an unknown key even alongside a full, valid config", () => {
    expect(
      HarnessConfigSchema.safeParse({ ...DEFAULT_HARNESS_CONFIG, criticUpscale: 16 })
        .success,
    ).toBe(false);
  });

  // -- A11 / A12: the gauge loop's own limits ------------------------------

  it("defaults maxDraftBatches to 5 and callTimeoutFloorMs to 45000", () => {
    const cfg = HarnessConfigSchema.parse({});
    expect(cfg.maxDraftBatches).toBe(5);
    expect(cfg.callTimeoutFloorMs).toBe(45000);
  });

  it("defaults draftGaugeBar to the four §6.2b figures", () => {
    expect(HarnessConfigSchema.parse({}).draftGaugeBar).toEqual({
      minColours: 3,
      minCoverage: 0.12,
      maxCoverage: 0.8,
      minDistinctRows: 8,
    });
  });

  it("floors the 16x16 deadline above pure area scaling — A12", () => {
    // The measured failure: `120000 × 256/1024 = 30s`, which a revise turn
    // exceeds, so every 16x16 run ended FAILED after round 1. The floor is what
    // makes the smallest canvas no longer the tightest deadline.
    const cfg = HarnessConfigSchema.parse({});
    const scaled = (cfg.callTimeoutMs * 16 * 16) / (32 * 32);
    expect(scaled).toBe(30000);
    expect(cfg.callTimeoutFloorMs).toBeGreaterThan(scaled);
  });

  it("fills a partial draftGaugeBar rather than dropping the other three", () => {
    const cfg = HarnessConfigSchema.parse({ draftGaugeBar: { minColours: 2 } });
    expect(cfg.draftGaugeBar).toEqual({
      minColours: 2,
      minCoverage: 0.12,
      maxCoverage: 0.8,
      minDistinctRows: 8,
    });
  });

  it("rejects an unknown key inside draftGaugeBar — the staleness argument again", () => {
    expect(
      HarnessConfigSchema.safeParse({ draftGaugeBar: { minColors: 3 } }).success,
    ).toBe(false);
  });

  it.each([0, -1, 2.5])("rejects maxDraftBatches = %s", (v) => {
    expect(HarnessConfigSchema.safeParse({ maxDraftBatches: v }).success).toBe(false);
  });

  it.each([0, -1, 1.5])("rejects callTimeoutFloorMs = %s", (v) => {
    expect(HarnessConfigSchema.safeParse({ callTimeoutFloorMs: v }).success).toBe(false);
  });

  it("rejects a coverage bound outside 0..1 and a non-integer colour count", () => {
    expect(
      HarnessConfigSchema.safeParse({ draftGaugeBar: { minCoverage: 1.5 } }).success,
    ).toBe(false);
    expect(
      HarnessConfigSchema.safeParse({ draftGaugeBar: { minColours: 2.5 } }).success,
    ).toBe(false);
    expect(
      HarnessConfigSchema.safeParse({ draftGaugeBar: { minDistinctRows: 0 } }).success,
    ).toBe(false);
  });

  it("rejects an unknown key inside models", () => {
    // The same staleness argument, one level down: `models` is part of the
    // config that gets serialized and compared.
    expect(
      HarnessConfigSchema.safeParse({
        models: { generator: "qwen3:8b", critic: "qwen3-vl:8b", judge: "llama3" },
      }).success,
    ).toBe(false);
  });

  it("strictness rejects unknown keys, not absent ones", () => {
    // The paired accept, and the thing strictness must not break: every field
    // in §6.8 has a default, and a caller handing over `{}` — or any subset —
    // is the normal case, not a stale artifact.
    expect(HarnessConfigSchema.parse({})).toEqual(DEFAULT_HARNESS_CONFIG);
    expect(HarnessConfigSchema.safeParse({ maxRounds: 7 }).success).toBe(true);
    expect(HarnessConfigSchema.safeParse({ models: {} }).success).toBe(true);
    expect(HarnessConfigSchema.safeParse({ models: { critic: "llava:13b" } }).success).toBe(
      true,
    );
  });

  it("accepts every §6.8 key by name, so strictness cannot orphan a real field", () => {
    // A strict schema that also lost a legitimate key would reject valid
    // configs, so each one is handed over on its own.
    for (const [k, v] of Object.entries(DEFAULT_HARNESS_CONFIG)) {
      expect(HarnessConfigSchema.safeParse({ [k]: v }).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// PixelDiffSchema / RoundSchema / SessionHistorySchema — spec §6.7
// ---------------------------------------------------------------------------

describe("PixelDiffSchema", () => {
  it("accepts a transparent-to-index change", () => {
    expect(PixelDiffSchema.safeParse({ x: 3, y: 4, from: ".", to: "a" }).success).toBe(true);
  });

  it("rejects an off-encoding character", () => {
    expect(PixelDiffSchema.safeParse({ x: 3, y: 4, from: ".", to: "g" }).success).toBe(
      false,
    );
  });

  it("rejects a multi-character cell value", () => {
    expect(PixelDiffSchema.safeParse({ x: 3, y: 4, from: ".", to: "ab" }).success).toBe(
      false,
    );
  });

  it("rejects a negative coordinate", () => {
    expect(PixelDiffSchema.safeParse({ x: -1, y: 4, from: ".", to: "a" }).success).toBe(
      false,
    );
  });
});

describe("RoundSchema", () => {
  it("accepts a round with a null critique", () => {
    expect(RoundSchema.safeParse(validRound(1, { critique: null })).success).toBe(true);
  });

  // -- round is 1-based — spec §7.5 -----------------------------------------

  it("rejects round: 0 — the draft is round 1", () => {
    // The doc's own `meta.round` is left at 1, so the only thing this can fail
    // on is the round's own number.
    const res = RoundSchema.safeParse(validRound(1, { round: 0 }));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "round")).toBe(true);
    }
  });

  it("accepts round: 1 — the paired accept", () => {
    expect(RoundSchema.parse(validRound(1)).round).toBe(1);
  });

  it("rejects a negative round", () => {
    expect(RoundSchema.safeParse(validRound(1, { round: -1 })).success).toBe(false);
  });

  it("rejects a fractional round", () => {
    expect(RoundSchema.safeParse(validRound(1, { round: 1.5 })).success).toBe(false);
  });

  it("rejects a round whose nested doc claims round 0", () => {
    // The round number and the doc's `meta.round` are two separate fields and a
    // pipeline can get either one wrong on its own, so both are pinned.
    const res = RoundSchema.safeParse(
      validRound(1, { doc: docWithMeta({ round: 0 }) }),
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "doc.meta.round")).toBe(
        true,
      );
    }
  });

  // -- diffFromPrev nullability — the sharpest edge in §6.7 ------------------

  it("accepts diffFromPrev: null — the first round has no predecessor", () => {
    const parsed = RoundSchema.parse(validRound(1, { diffFromPrev: null }));
    expect(parsed.diffFromPrev).toBeNull();
  });

  it("accepts diffFromPrev: [] — the revise stage ran and changed nothing", () => {
    const parsed = RoundSchema.parse(validRound(2, { diffFromPrev: [] }));
    expect(parsed.diffFromPrev).toEqual([]);
  });

  it("keeps null and [] distinguishable after parsing", () => {
    // Non-nullable made "this is the first round" and "the revise stage changed
    // nothing" the same value, and spec §6.7 v1 pointed the `empty-diff` stop
    // condition straight at the stored field — so a literal implementation
    // stopped every run right after the draft with a bogus stop reason.
    const first = RoundSchema.parse(validRound(1, { diffFromPrev: null }));
    const noop = RoundSchema.parse(validRound(2, { diffFromPrev: [] }));
    expect(first.diffFromPrev).toBeNull();
    expect(noop.diffFromPrev).toEqual([]);
    expect(first.diffFromPrev).not.toEqual(noop.diffFromPrev);
    expect(first.diffFromPrev === null).toBe(true);
    expect(noop.diffFromPrev === null).toBe(false);
    // ...and they survive a JSON round trip still distinguishable.
    const rt = (r: unknown) => JSON.parse(JSON.stringify(r)).diffFromPrev;
    expect(rt(first)).toBeNull();
    expect(rt(noop)).toEqual([]);
  });

  it("accepts a populated diffFromPrev", () => {
    const diffs = [{ x: 1, y: 1, from: ".", to: "2" }];
    const parsed = RoundSchema.parse(validRound(2, { diffFromPrev: diffs }));
    expect(parsed.diffFromPrev).toEqual(diffs);
  });

  it("rejects diffFromPrev entries that are not pixel diffs", () => {
    expect(
      RoundSchema.safeParse(validRound(2, { diffFromPrev: [{ x: 1, y: 1 }] })).success,
    ).toBe(false);
  });

  it("rejects a round missing diffFromPrev entirely", () => {
    const { diffFromPrev: _drop, ...rest } = validRound(1);
    expect(RoundSchema.safeParse(rest).success).toBe(false);
  });

  // -- filteredIssues: what the revise stage actually received ---------------

  it("stores filteredIssues separately from the raw critique", () => {
    // Storing only the filtered report destroys the data needed to tune
    // `confidenceFloor`; storing only the raw one shows the UI `suggest` text
    // the agent never received. Both, or one of those two breaks.
    const raw = validCritique([
      validIssue(),
      validIssue({ id: "i2", confidence: 0.1, suggest: "guess" }),
    ]);
    const parsed = RoundSchema.parse(
      validRound(1, { critique: raw, filteredIssues: [validIssue()] }),
    );
    expect(parsed.critique?.issues).toHaveLength(2);
    expect(parsed.filteredIssues).toHaveLength(1);
    expect(parsed.filteredIssues[0].id).toBe("i1");
  });

  it("accepts an empty filteredIssues list", () => {
    expect(RoundSchema.safeParse(validRound(1, { filteredIssues: [] })).success).toBe(true);
  });

  it("rejects a round missing filteredIssues", () => {
    const { filteredIssues: _drop, ...rest } = validRound(1);
    expect(RoundSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a filteredIssues entry that is not an Issue", () => {
    expect(
      RoundSchema.safeParse(validRound(1, { filteredIssues: [{ id: "x" }] })).success,
    ).toBe(false);
  });

  // -- userFeedback ---------------------------------------------------------

  it("records the user's own words", () => {
    const parsed = RoundSchema.parse(
      validRound(2, { userFeedback: "make the tail bushier" }),
    );
    expect(parsed.userFeedback).toBe("make the tail bushier");
  });

  it("accepts userFeedback: null on a round the user did not drive", () => {
    expect(RoundSchema.parse(validRound(1)).userFeedback).toBeNull();
  });

  it("rejects a round missing userFeedback", () => {
    const { userFeedback: _drop, ...rest } = validRound(1);
    expect(RoundSchema.safeParse(rest).success).toBe(false);
  });

  // -- revise ---------------------------------------------------------------

  it("records the revise stage's own account of what it did", () => {
    const parsed = RoundSchema.parse(
      validRound(2, {
        revise: { turns: 12, hitCap: false, summary: "darkened the inner ear" },
      }),
    );
    expect(parsed.revise).toEqual({
      turns: 12,
      hitCap: false,
      summary: "darkened the inner ear",
    });
  });

  it("accepts revise: null on a round that skipped REVISING", () => {
    expect(RoundSchema.parse(validRound(1, { revise: null })).revise).toBeNull();
  });

  it("records hitCap so the bench can surface an exhausted turn budget", () => {
    const parsed = RoundSchema.parse(
      validRound(2, { revise: { turns: 40, hitCap: true, summary: "" } }),
    );
    expect(parsed.revise?.hitCap).toBe(true);
    expect(parsed.revise?.turns).toBe(40);
  });

  it("rejects a revise block missing hitCap", () => {
    expect(
      RoundSchema.safeParse(validRound(2, { revise: { turns: 3, summary: "x" } })).success,
    ).toBe(false);
  });

  it("rejects a negative revise turn count", () => {
    expect(
      RoundSchema.safeParse(
        validRound(2, { revise: { turns: -1, hitCap: false, summary: "" } }),
      ).success,
    ).toBe(false);
  });

  it("rejects a round missing revise", () => {
    const { revise: _drop, ...rest } = validRound(1);
    expect(RoundSchema.safeParse(rest).success).toBe(false);
  });

  // -- timings --------------------------------------------------------------

  it("records per-stage wall clock", () => {
    const parsed = RoundSchema.parse(
      validRound(1, { timings: { draftMs: 31_400, critiqueMs: 12_100, reviseMs: 25_000 } }),
    );
    expect(parsed.timings).toEqual({
      draftMs: 31_400,
      critiqueMs: 12_100,
      reviseMs: 25_000,
    });
  });

  it("accepts a null for every stage that did not run this round", () => {
    // Round 2 has no draft; a converged round has no revise.
    const parsed = RoundSchema.parse(
      validRound(2, { timings: { draftMs: null, critiqueMs: 9_000, reviseMs: null } }),
    );
    expect(parsed.timings.draftMs).toBeNull();
    expect(parsed.timings.reviseMs).toBeNull();
    expect(parsed.timings.critiqueMs).toBe(9_000);
  });

  it("rejects a round missing timings", () => {
    const { timings: _drop, ...rest } = validRound(1);
    expect(RoundSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a timings block missing a stage", () => {
    expect(
      RoundSchema.safeParse(validRound(1, { timings: { draftMs: 1, critiqueMs: 2 } }))
        .success,
    ).toBe(false);
  });

  it("rejects a negative duration", () => {
    expect(
      RoundSchema.safeParse(
        validRound(1, { timings: { draftMs: -1, critiqueMs: null, reviseMs: null } }),
      ).success,
    ).toBe(false);
  });
});

describe("SessionHistorySchema", () => {
  it("accepts a fully-formed history", () => {
    expect(SessionHistorySchema.safeParse(validHistory()).success).toBe(true);
  });

  it("rejects an empty object", () => {
    expect(SessionHistorySchema.safeParse({}).success).toBe(false);
  });

  it("embeds the harness config verbatim", () => {
    const parsed = SessionHistorySchema.parse(
      validHistory({ rounds: [validRound(1), validRound(2)] }),
    );
    expect(parsed.config).toEqual(DEFAULT_HARNESS_CONFIG);
    expect(parsed.rounds).toHaveLength(2);
  });

  it("rejects a history whose round carries a malformed doc", () => {
    const bad = validHistory({
      rounds: [validRound(1, { doc: validDoc({ rows: [] }) })],
    });
    expect(SessionHistorySchema.safeParse(bad).success).toBe(false);
  });

  // -- draftFailures --------------------------------------------------------

  it("records a rejected draft, which has no valid SpriteDoc and so cannot be a Round", () => {
    const parsed = SessionHistorySchema.parse(
      validHistory({
        rounds: [],
        outcome: "failed",
        finalState: "FAILED",
        stopReason: null,
        draftFailures: [
          {
            attempt: 1,
            raw: "Sure! Here is a fox:\n\n(a picture of a fox)",
            repairs: 256,
            reason: "unparseable output; charged 256 repairs against 256 cells",
          },
          { attempt: 2, raw: "```\n....\n```", repairs: 240, reason: "repairs over threshold" },
        ],
      }),
    );
    expect(parsed.draftFailures).toHaveLength(2);
    expect(parsed.draftFailures[1].attempt).toBe(2);
    expect(parsed.draftFailures[0].raw).toMatch(/a picture of a fox/);
  });

  it("rejects a history missing draftFailures", () => {
    const { draftFailures: _drop, ...rest } = validHistory();
    expect(SessionHistorySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a draft failure missing its raw output", () => {
    const bad = validHistory({
      draftFailures: [{ attempt: 1, repairs: 10, reason: "over threshold" }],
    });
    expect(SessionHistorySchema.safeParse(bad).success).toBe(false);
  });

  // -- stopReason / finalState / outcome / acceptedRound --------------------

  it.each(["no-high-severity", "round-cap", "empty-diff", "critic-failed"])(
    "accepts stopReason %s",
    (r) => {
      expect(SessionHistorySchema.safeParse(validHistory({ stopReason: r })).success).toBe(
        true,
      );
    },
  );

  it("accepts stopReason: null for a run that has not stopped", () => {
    expect(SessionHistorySchema.parse(validHistory({ stopReason: null })).stopReason).toBe(
      null,
    );
  });

  it("rejects a stop reason outside the spec §7.2 table", () => {
    expect(
      SessionHistorySchema.safeParse(validHistory({ stopReason: "converged" })).success,
    ).toBe(false);
  });

  it("rejects a history missing stopReason", () => {
    const { stopReason: _drop, ...rest } = validHistory();
    expect(SessionHistorySchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    "IDLE",
    "DRAFTING",
    "LINTING",
    "CRITIQUING",
    "REVISING",
    "AWAITING_USER",
    "DONE",
    "FAILED",
  ])("accepts finalState %s", (s) => {
    expect(SessionHistorySchema.safeParse(validHistory({ finalState: s })).success).toBe(
      true,
    );
  });

  it("rejects a state outside the spec §7.1 machine", () => {
    expect(
      SessionHistorySchema.safeParse(validHistory({ finalState: "RUNNING" })).success,
    ).toBe(false);
  });

  it.each(["completed", "failed"])("accepts outcome %s", (o) => {
    expect(SessionHistorySchema.safeParse(validHistory({ outcome: o })).success).toBe(true);
  });

  it("rejects an outcome outside completed | failed", () => {
    expect(
      SessionHistorySchema.safeParse(validHistory({ outcome: "partial" })).success,
    ).toBe(false);
  });

  it("rejects a history missing outcome", () => {
    const { outcome: _drop, ...rest } = validHistory();
    expect(SessionHistorySchema.safeParse(rest).success).toBe(false);
  });

  it("records which round the user accepted — any round, not only the last", () => {
    const parsed = SessionHistorySchema.parse(
      validHistory({
        rounds: [validRound(1), validRound(2), validRound(3)],
        acceptedRound: 2,
        finalState: "DONE",
      }),
    );
    expect(parsed.acceptedRound).toBe(2);
    expect(parsed.finalState).toBe("DONE");
  });

  it("accepts acceptedRound: null before the gate is answered", () => {
    expect(SessionHistorySchema.parse(validHistory()).acceptedRound).toBeNull();
  });

  it.each([-1, 0])("rejects acceptedRound %s", (v) => {
    // `0` is the case that matters, and it is not merely "a negative number
    // one lower". §6.7 stores `Round.round`, which is 1-based — *not* the
    // 0-based position `Api.accept(roundIndex)` speaks. `accept(0)` is
    // accepting the draft, the most common call there is, and it is exactly
    // where a dropped conversion produces a value a `nonnegative()` bound
    // would have persisted without complaint.
    expect(SessionHistorySchema.safeParse(validHistory({ acceptedRound: v })).success).toBe(
      false,
    );
  });

  it("accepts acceptedRound: 1 — the draft named by its round, not by its index", () => {
    // The paired accept for the `0` rejection above: the draft is acceptable,
    // it is just spelled `1`.
    const parsed = SessionHistorySchema.parse(
      validHistory({ acceptedRound: 1, finalState: "DONE" }),
    );
    expect(parsed.acceptedRound).toBe(1);
  });

  it("accepts acceptedRound: null — still the un-answered gate, not a rejection", () => {
    // Pins that tightening the bound did not take the nullability with it.
    expect(SessionHistorySchema.parse(validHistory({ acceptedRound: null })).acceptedRound).toBe(
      null,
    );
  });

  it("rejects a fractional acceptedRound", () => {
    expect(
      SessionHistorySchema.safeParse(validHistory({ acceptedRound: 1.5 })).success,
    ).toBe(false);
  });

  it("rejects a history missing acceptedRound", () => {
    const { acceptedRound: _drop, ...rest } = validHistory();
    expect(SessionHistorySchema.safeParse(rest).success).toBe(false);
  });

  // -- error: why a run failed, when it wasn't a draft (spec §6.7) ----------
  //
  // `draftFailures` covers draft rejection only. An `OllamaTimeoutError` during
  // CRITIQUING is not a draft failure and nothing else could hold it, so a
  // persisted history could not say why it failed — while §8 has the status bar
  // read failure state off exactly that artifact.

  it("records why a run failed when the failure was not a draft rejection", () => {
    const parsed = SessionHistorySchema.parse(
      validHistory({
        outcome: "failed",
        finalState: "FAILED",
        stopReason: null,
        error: "OllamaTimeoutError: /api/chat exceeded 480000ms during CRITIQUING",
      }),
    );
    expect(parsed.error).toBe(
      "OllamaTimeoutError: /api/chat exceeded 480000ms during CRITIQUING",
    );
    // And it is reachable without a single draft failure, which is the whole
    // point: this failure mode has no `draftFailures` entry to hide behind.
    expect(parsed.draftFailures).toEqual([]);
  });

  it("accepts error: null on a run that has not failed", () => {
    expect(SessionHistorySchema.parse(validHistory()).error).toBeNull();
  });

  it("rejects a history missing error", () => {
    // Required, not optional: an absent key and an explicit `null` would
    // otherwise be the same artifact, and a writer that forgot the field would
    // look exactly like a run that succeeded.
    const { error: _drop, ...rest } = validHistory();
    expect(SessionHistorySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects error: undefined", () => {
    expect(SessionHistorySchema.safeParse(validHistory({ error: undefined })).success).toBe(
      false,
    );
  });

  it.each([500, { code: "ETIMEDOUT" }, ["a", "b"]])("rejects a non-string error %s", (e) => {
    expect(SessionHistorySchema.safeParse(validHistory({ error: e })).success).toBe(false);
  });

  it("accepts an empty-string error", () => {
    // `.min(1)` would make a caller that has an exception with no message
    // choose between lying and failing validation.
    expect(SessionHistorySchema.parse(validHistory({ error: "" })).error).toBe("");
  });

  it("leaves error and draftFailures independent", () => {
    // A draft rejection fills `draftFailures` and leaves `error` null; the
    // schema must not cross-refine them, or the two failure modes collapse.
    const draftOnly = SessionHistorySchema.parse(
      validHistory({
        rounds: [],
        outcome: "failed",
        finalState: "FAILED",
        stopReason: null,
        error: null,
        draftFailures: [{ attempt: 1, raw: "prose", repairs: 256, reason: "unparseable" }],
      }),
    );
    expect(draftOnly.error).toBeNull();
    expect(draftOnly.draftFailures).toHaveLength(1);
  });

  // -- schemaVersion: the staleness signal (spec §6.7, §6.8) ----------------

  it("pins schemaVersion to the literal 1", () => {
    expect(SessionHistorySchema.parse(validHistory()).schemaVersion).toBe(1);
  });

  it("rejects a history missing schemaVersion", () => {
    const { schemaVersion: _drop, ...rest } = validHistory();
    expect(SessionHistorySchema.safeParse(rest).success).toBe(false);
  });

  it.each([0, 2, "1", null, true])("rejects schemaVersion %s", (v) => {
    // A literal, not a number: version 2 is a shape this parser has never seen,
    // so accepting the field while ignoring its value would defeat it entirely.
    expect(SessionHistorySchema.safeParse(validHistory({ schemaVersion: v })).success).toBe(
      false,
    );
  });

  // -- the round trip -------------------------------------------------------

  it("round-trips a fully-populated history through JSON unchanged", () => {
    // Every optional and nullable field carries a value, so nothing can pass by
    // being absent on both sides: the doc's optional intent fields, a lint
    // warning with `indices`, a non-null `revise`, three non-null timings,
    // `userFeedback`, a populated `draftFailures`, and `acceptedRound`.
    const fully = {
      schemaVersion: 1,
      sessionId: "s-full",
      config: { ...DEFAULT_HARNESS_CONFIG, maxRounds: 2, criticTargetPx: 256 },
      rounds: [
        {
          round: 1,
          doc: validDoc({
            id: "doc-round-1",
            intent: {
              subject: "red fox, sitting",
              style: "chunky outline",
              facing: "three-quarter",
              notes: "keep the tail readable",
            },
            palette: PALETTE_16,
            rows: (() => {
              const rows = Array.from({ length: 16 }, () => row16());
              rows[8] = "0123456789abcdef";
              return rows;
            })(),
            meta: {
              generatorModel: "qwen3:8b",
              criticModel: "qwen3-vl:8b-instruct-q4_K_M",
              round: 1,
              repairs: 3,
              repairedRows: [8, 9],
              parentId: null,
            },
          }),
          lint: {
            warnings: [
              {
                code: "low-contrast",
                cells: [
                  [3, 8],
                  [4, 8],
                ],
                indices: [2, 3],
                message: "indices 2 and 3 differ by 0.079",
              },
              { code: "row-repaired", cells: [[0, 8]], message: "row 8 was repaired" },
            ],
            metrics: {
              coverage: 0.0625,
              paletteUsed: 16,
              orphanCount: 2,
              symmetryScore: 0.5,
            },
          },
          critique: {
            readsAs: "a fox, though the ears are ambiguous",
            matchesIntent: true,
            overall: 4,
            degraded: false,
            issues: [
              validIssue(),
              validIssue({ id: "i2", severity: "low", confidence: 0.2, suggest: "guess" }),
            ],
          },
          filteredIssues: [validIssue()],
          diffFromPrev: null,
          userFeedback: "make the tail bushier",
          revise: { turns: 12, hitCap: false, summary: "darkened the inner ear" },
          timings: { draftMs: 31_400, critiqueMs: 12_100, reviseMs: 25_000 },
        },
        {
          round: 2,
          doc: validDoc({ id: "doc-round-2", meta: { ...(validDoc().meta as object), round: 2, parentId: "doc-round-1" } }),
          lint: validLint(),
          critique: {
            readsAs: null,
            matchesIntent: false,
            overall: null,
            degraded: true,
            issues: [],
          },
          filteredIssues: [],
          diffFromPrev: [{ x: 1, y: 1, from: ".", to: "2" }],
          userFeedback: null,
          revise: { turns: 40, hitCap: true, summary: "" },
          timings: { draftMs: null, critiqueMs: 9_000, reviseMs: null },
        },
      ],
      draftFailures: [
        { attempt: 1, raw: "prose, not rows", repairs: 256, reason: "unparseable" },
      ],
      stopReason: "critic-failed",
      finalState: "AWAITING_USER",
      outcome: "completed",
      // Non-null so the field cannot pass by being absent on both sides of the
      // trip. The schema deliberately does not tie `error` to `outcome`: §6.7
      // defines no cross-field rule, and a run whose critic timed out on round
      // 2 can still be accepted at round 1.
      error: "OllamaTimeoutError: /api/chat exceeded 480000ms during CRITIQUING",
      acceptedRound: 1,
    };

    const parsed = SessionHistorySchema.parse(fully);
    const reparsed = SessionHistorySchema.parse(JSON.parse(JSON.stringify(parsed)));

    expect(reparsed).toEqual(parsed);
    // Byte-for-byte, not merely deep-equal: a field that JSON drops (an
    // `undefined`) or reorders would survive `toEqual` and fail here.
    expect(JSON.stringify(reparsed)).toBe(JSON.stringify(parsed));

    // And the fields that exist precisely to be readable off the artifact.
    expect(parsed.rounds[0].revise?.summary).toBe("darkened the inner ear");
    expect(parsed.rounds[0].userFeedback).toBe("make the tail bushier");
    expect(parsed.rounds[0].diffFromPrev).toBeNull();
    expect(parsed.rounds[0].lint.warnings[0].indices).toEqual([2, 3]);
    expect(parsed.rounds[1].critique?.degraded).toBe(true);
    expect(parsed.rounds[1].critique?.overall).toBeNull();
    expect(parsed.rounds[1].revise?.hitCap).toBe(true);
    expect(parsed.stopReason).toBe("critic-failed");
    expect(parsed.acceptedRound).toBe(1);
    expect(parsed.config.criticTargetPx).toBe(256);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.error).toBe(
      "OllamaTimeoutError: /api/chat exceeded 480000ms during CRITIQUING",
    );
    // The two fields that only exist once they survive serialization: a
    // staleness marker and a failure reason that a reload has to be able to
    // read back off disk.
    expect(JSON.parse(JSON.stringify(parsed)).schemaVersion).toBe(1);
    expect(JSON.parse(JSON.stringify(parsed)).error).toMatch(/OllamaTimeoutError/);
  });
});

// ---------------------------------------------------------------------------
// PipelineState / StopReason / PipelineEvent — spec §5.2, §7.1, §7.2
//
// These live in `shared/` rather than `main/pipeline.ts` because preload and
// the renderer consume them, and a *value* import of `@main/pipeline` from the
// renderer bundle would pull `node:http` in behind it.
// ---------------------------------------------------------------------------

describe("PipelineStateSchema", () => {
  it("holds exactly the eight states in spec §7.1's diagram", () => {
    expect([...PIPELINE_STATES]).toEqual([
      "IDLE",
      "DRAFTING",
      "LINTING",
      "CRITIQUING",
      "REVISING",
      "AWAITING_USER",
      "DONE",
      "FAILED",
    ]);
  });

  it.each(PIPELINE_STATES)("accepts %s", (s) => {
    expect(PipelineStateSchema.parse(s)).toBe(s);
  });

  it.each(["RUNNING", "drafting", "PAUSED", ""])("rejects %s", (s) => {
    expect(PipelineStateSchema.safeParse(s).success).toBe(false);
  });

  it("types a state variable without a value import from main", () => {
    const s: PipelineState = "AWAITING_USER";
    expect(PipelineStateSchema.parse(s)).toBe("AWAITING_USER");
  });
});

describe("StopReasonSchema", () => {
  it("holds exactly the four reasons in spec §7.2's table", () => {
    expect([...STOP_REASONS]).toEqual([
      "no-high-severity",
      "round-cap",
      "empty-diff",
      "critic-failed",
    ]);
  });

  it.each(STOP_REASONS)("accepts %s", (r) => {
    expect(StopReasonSchema.parse(r)).toBe(r);
  });

  it.each(["converged", "user-accepted", "no-high-sev"])("rejects %s", (r) => {
    expect(StopReasonSchema.safeParse(r).success).toBe(false);
  });

  it("keeps critic-failed distinct from no-high-severity", () => {
    // Without the distinction a broken critic reports success and the user is
    // told the sprite passed a critique that never ran.
    const a: StopReason = "critic-failed";
    const b: StopReason = "no-high-severity";
    expect(a).not.toBe(b);
  });
});

describe("PipelineEventSchema", () => {
  it("carries a state transition — §7.1: every transition emits a typed event", () => {
    const parsed = PipelineEventSchema.parse({
      type: "state",
      state: "CRITIQUING",
      round: 2,
    });
    expect(parsed).toEqual({ type: "state", state: "CRITIQUING", round: 2 });
  });

  it("rejects a state event naming a state outside the machine", () => {
    expect(
      PipelineEventSchema.safeParse({ type: "state", state: "PAUSED", round: 1 }).success,
    ).toBe(false);
  });

  it("carries per-turn revise progress — §7.1: REVISING emits per-turn progress", () => {
    // The longest stage in the design. Without this the status bar shows one
    // static REVISING label for up to 40 model turns.
    const parsed = PipelineEventSchema.parse({
      type: "revise-turn",
      round: 2,
      turn: 7,
      maxTurns: 40,
    });
    expect(parsed).toEqual({ type: "revise-turn", round: 2, turn: 7, maxTurns: 40 });
  });

  it("rejects a turn number of zero — turns are 1-based", () => {
    expect(
      PipelineEventSchema.safeParse({
        type: "revise-turn",
        round: 1,
        turn: 0,
        maxTurns: 40,
      }).success,
    ).toBe(false);
  });

  it("carries a whole round snapshot", () => {
    // `run()` resolves only at the gate, minutes later, and the Api has no
    // method to read an in-progress history — so a mid-run filmstrip frame can
    // only come from the event.
    const parsed = PipelineEventSchema.parse({
      type: "round",
      snapshot: validRound(1),
    });
    expect(parsed.type).toBe("round");
    if (parsed.type === "round") {
      expect(parsed.snapshot.round).toBe(1);
      expect(parsed.snapshot.diffFromPrev).toBeNull();
    }
  });

  it("rejects a round event whose snapshot is not a valid Round", () => {
    const { timings: _drop, ...rest } = validRound(1);
    expect(PipelineEventSchema.safeParse({ type: "round", snapshot: rest }).success).toBe(
      false,
    );
  });

  it("rejects an event type outside the union", () => {
    expect(PipelineEventSchema.safeParse({ type: "progress", pct: 50 }).success).toBe(false);
  });

  it("rejects an event with no type at all", () => {
    expect(PipelineEventSchema.safeParse({ state: "IDLE", round: 0 }).success).toBe(false);
  });

  it("survives the JSON round trip an IPC push channel puts it through", () => {
    const e = PipelineEventSchema.parse({ type: "round", snapshot: validRound(2) });
    expect(PipelineEventSchema.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });
});

// ---------------------------------------------------------------------------
// The §6.7 sub-schemas, exported so Waves 9 and 13 can build and read them
// without reconstructing the shapes by hand.
// ---------------------------------------------------------------------------

describe("§6.7 sub-schemas", () => {
  it("ReviseSummarySchema is revise()'s own return shape", () => {
    expect(
      ReviseSummarySchema.parse({ turns: 12, hitCap: false, summary: "done" }),
    ).toEqual({ turns: 12, hitCap: false, summary: "done" });
  });

  it("RoundTimingsSchema allows a null per stage", () => {
    expect(
      RoundTimingsSchema.parse({ draftMs: null, critiqueMs: 1, reviseMs: null }),
    ).toEqual({ draftMs: null, critiqueMs: 1, reviseMs: null });
  });

  it("DraftFailureSchema numbers its attempts from 1", () => {
    expect(
      DraftFailureSchema.safeParse({ attempt: 0, raw: "x", repairs: 1, reason: "y" })
        .success,
    ).toBe(false);
    expect(
      DraftFailureSchema.safeParse({ attempt: 1, raw: "x", repairs: 1, reason: "y" })
        .success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ollama client contract types — spec §6.9
//
// These are compile-time contracts, so `npx tsc --noEmit` is what actually
// fails when a field is missing: the type annotations below stop typechecking.
// The runtime assertions pin the field *names*, which is what the Ollama wire
// format cares about.
// ---------------------------------------------------------------------------

describe("Ollama client contract types (spec §6.9)", () => {
  it("an assistant ChatMessage carries the tool calls it made", () => {
    // Without `tool_calls` the revise loop cannot continue a tool conversation
    // at all: Ollama's chat template renders the calls off the assistant
    // message, and without them the tool results arrive unmoored and the model
    // re-issues calls it has already made, burning the turn cap.
    const call: ToolCall = {
      id: "call-1",
      name: "place_pixel",
      arguments: { x: 3, y: 4, index: 2 },
    };
    const assistant: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [call],
    };
    expect(assistant.tool_calls?.[0]).toEqual(call);
    expect(Object.keys(assistant)).toContain("tool_calls");
  });

  it("a tool ChatMessage points back at the call it answers", () => {
    const result: ChatMessage = {
      role: "tool",
      content: "out-of-bounds: (99,4) outside 16x16",
      tool_call_id: "call-1",
    };
    expect(result.tool_call_id).toBe("call-1");
  });

  it("system and user messages need neither field", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "/no_think you are a pixel artist" },
      { role: "user", content: "fix the left ear" },
    ];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    expect(msgs[0].tool_calls).toBeUndefined();
  });

  it("a ChatTurn separates the model's prose from its calls", () => {
    const turn: ChatTurn = {
      content: "placing the pixel",
      toolCalls: [{ id: "call-1", name: "done", arguments: { summary: "ok" } }],
    };
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.content).toBe("placing the pixel");
  });

  it("a ChatTurn with no calls is representable — the zero-tool-call turn", () => {
    // The most common qwen3 tool-loop behaviour, and the one §6.6 says must
    // count against the cap.
    const turn: ChatTurn = { content: "I think the ear looks fine.", toolCalls: [] };
    expect(turn.toolCalls).toEqual([]);
  });

  it("a ToolDef is the function envelope Ollama marshals", () => {
    const placePixel: ToolDef = {
      type: "function",
      function: {
        name: "place_pixel",
        description: "Write one pixel. index may be a palette index or '.' to clear.",
        parameters: {
          type: "object",
          properties: {
            x: { type: "integer" },
            y: { type: "integer" },
            index: { type: ["integer", "string"] },
          },
          required: ["x", "y", "index"],
        },
      },
    };
    expect(placePixel.type).toBe("function");
    expect(placePixel.function.name).toBe("place_pixel");
    expect(Object.keys(placePixel.function)).toEqual([
      "name",
      "description",
      "parameters",
    ]);
  });
});
