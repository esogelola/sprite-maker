import { describe, expect, it } from "vitest";

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
    const rows = Array.from({ length: 16 }, () => "0123456789abcdef");
    expect(SpriteDocSchema.safeParse(validDoc({ rows })).success).toBe(true);
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
