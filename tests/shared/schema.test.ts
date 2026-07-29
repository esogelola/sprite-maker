import { describe, expect, it } from "vitest";

import { charIndex } from "@shared/grid";
import {
  CritiqueReportSchema,
  DEFAULT_HARNESS_CONFIG,
  HarnessConfigSchema,
  IssueSchema,
  LintReportSchema,
  LintWarningSchema,
  PixelDiffSchema,
  RoundSchema,
  SessionHistorySchema,
  SizeSchema,
  SpriteDocSchema,
  type Issue,
  type SpriteDoc,
} from "@shared/schema";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const row16 = (ch = ".") => ch.repeat(16);

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
      round: 0,
      repairs: 0,
      parentId: null,
    },
    ...over,
  };
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
  errors: [],
  warnings: [],
  metrics: { coverage: 0.5, paletteUsed: 3, orphanCount: 0, symmetryScore: 1 },
});

// ---------------------------------------------------------------------------
// SizeSchema — spec §6.2
// ---------------------------------------------------------------------------

describe("SizeSchema", () => {
  it.each([16, 32, 64])("accepts %i", (n) => {
    expect(SizeSchema.parse({ w: n, h: n })).toEqual({ w: n, h: n });
  });

  it("rejects w = 24", () => {
    expect(SizeSchema.safeParse({ w: 24, h: 16 }).success).toBe(false);
  });

  it("rejects h = 24", () => {
    expect(SizeSchema.safeParse({ w: 16, h: 24 }).success).toBe(false);
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
    const doc = validDoc({
      size: { w: 32, h: 32 },
      rows: Array.from({ length: 32 }, () => ".".repeat(32)),
    });
    expect(SpriteDocSchema.safeParse(doc).success).toBe(true);
  });

  it("defaults meta.repairedRows to an empty list", () => {
    const parsed: SpriteDoc = SpriteDocSchema.parse(validDoc());
    expect(parsed.meta.repairedRows).toEqual([]);
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

  it("rejects an off-palette doc nested in a SessionHistory round", () => {
    const rows = Array.from({ length: 16 }, () => row16());
    rows[0] = "ffffffffffffffff";
    const bad = {
      sessionId: "s-1",
      config: DEFAULT_HARNESS_CONFIG,
      rounds: [
        {
          round: 0,
          doc: validDoc({ rows }),
          critique: null,
          lint: validLint(),
          diffFromPrev: [],
        },
      ],
    };
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
});

// ---------------------------------------------------------------------------
// LintReportSchema — spec §6.5
// ---------------------------------------------------------------------------

describe("LintReportSchema", () => {
  it("accepts an empty report", () => {
    expect(LintReportSchema.safeParse(validLint()).success).toBe(true);
  });

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

  it("rejects a symmetryScore above 1", () => {
    const bad = { ...validLint(), metrics: { ...validLint().metrics, symmetryScore: 1.2 } };
    expect(LintReportSchema.safeParse(bad).success).toBe(false);
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
      criticUpscale: 16,
      callTimeoutMs: 120000,
      models: { generator: "qwen3:8b", critic: "qwen3-vl:8b-instruct-q4_K_M" },
    });
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
    expect(cfg.models).toEqual({ generator: "qwen3:8b", critic: "llava:13b" });
  });

  it("rejects a confidenceFloor outside 0..1", () => {
    expect(HarnessConfigSchema.safeParse({ confidenceFloor: 1.5 }).success).toBe(false);
  });

  it("rejects a non-integer maxRounds", () => {
    expect(HarnessConfigSchema.safeParse({ maxRounds: 2.5 }).success).toBe(false);
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

describe("SessionHistorySchema", () => {
  const round = (n: number) => ({
    round: n,
    doc: validDoc({ meta: { ...(validDoc().meta as object), round: n } }),
    critique: n === 0 ? null : validCritique(),
    lint: validLint(),
    diffFromPrev: n === 0 ? [] : [{ x: 1, y: 1, from: ".", to: "2" }],
  });

  it("accepts a round with a null critique", () => {
    expect(RoundSchema.safeParse(round(0)).success).toBe(true);
  });

  it("embeds the harness config verbatim and round-trips through JSON", () => {
    const history = {
      sessionId: "s-1",
      config: DEFAULT_HARNESS_CONFIG,
      rounds: [round(0), round(1)],
    };
    const parsed = SessionHistorySchema.parse(history);
    expect(parsed.config).toEqual(DEFAULT_HARNESS_CONFIG);
    expect(parsed.rounds).toHaveLength(2);

    const reparsed = SessionHistorySchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  it("rejects a history whose round carries a malformed doc", () => {
    const bad = {
      sessionId: "s-1",
      config: DEFAULT_HARNESS_CONFIG,
      rounds: [{ ...round(0), doc: validDoc({ rows: [] }) }],
    };
    expect(SessionHistorySchema.safeParse(bad).success).toBe(false);
  });
});
