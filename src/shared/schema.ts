/**
 * Single source of truth for every contract in the system — spec §6.
 *
 * Nothing here touches disk, the network, or Electron. Both processes import
 * these schemas so a value that crosses IPC is validated against the same
 * definition on each side.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/** A whole, non-negative pixel coordinate. */
const Coord = z.int().nonnegative();

/** `#rrggbb`. Palette colors are always fully opaque; `.` carries transparency. */
const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "expected a #rrggbb hex color");

/**
 * One encoded pixel — spec §6.1. `.` is transparent, `0`-`f` is a palette
 * index. Lowercase only: `indexChar` emits lowercase, so admitting `A`-`F`
 * would give the same pixel two spellings and break row equality, diffs and
 * golden-file comparisons.
 */
export const ROW_CHAR_RE = /^[.0-9a-f]$/;
const RowChar = z.string().regex(ROW_CHAR_RE, "expected '.' or a hex digit 0-f");

/** A whole row of encoded pixels. Length is checked against `size.w` on the doc. */
const Row = z.string().regex(/^[.0-9a-f]*$/, "rows may only contain '.' and 0-f");

/** A unit interval, used by both confidence fields and the lint metrics. */
const Unit = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// 6.2 SpriteDoc
// ---------------------------------------------------------------------------

/** Canvas dimensions. 16, 32 and 64 are the only supported sizes. */
export const SizeSchema = z.object({
  w: z.union([z.literal(16), z.literal(32), z.literal(64)]),
  h: z.union([z.literal(16), z.literal(32), z.literal(64)]),
});

export const IntentSchema = z.object({
  subject: z.string(),
  style: z.string().optional(),
  facing: z.enum(["front", "side", "three-quarter"]).optional(),
  notes: z.string().optional(),
});

/** The palette snapshotted into the doc, so a saved sprite renders standalone. */
export const PaletteRefSchema = z.object({
  id: z.string().min(1),
  colors: z.array(HexColor).min(4).max(16),
});

const SpriteMetaSchema = z.object({
  generatorModel: z.string(),
  criticModel: z.string(),
  round: z.int().nonnegative(),
  repairs: z.int().nonnegative(),
  parentId: z.string().nullable(),
  /**
   * Row indices that §6.3 repair had to touch. `lint()` turns each into a
   * `row-repaired` warning, which is information that only exists at parse
   * time and cannot be recovered from the finished grid.
   */
  repairedRows: z.array(Coord).default([]),
});

export const SpriteDocSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    createdAt: z.iso.datetime(),
    prompt: z.string(),
    intent: IntentSchema,
    size: SizeSchema,
    palette: PaletteRefSchema,
    rows: z.array(Row),
    meta: SpriteMetaSchema,
  })
  // Cross-field: the grid has to actually be the shape it declares. A plain
  // array schema cannot see `size`, so this has to be a refinement.
  .superRefine((doc, ctx) => {
    if (doc.rows.length !== doc.size.h) {
      ctx.addIssue({
        code: "custom",
        path: ["rows"],
        message: `expected ${doc.size.h} rows to match size.h, got ${doc.rows.length}`,
      });
    }
    doc.rows.forEach((row, y) => {
      if (row.length !== doc.size.w) {
        ctx.addIssue({
          code: "custom",
          path: ["rows", y],
          message: `row ${y} has ${row.length} chars, expected ${doc.size.w} to match size.w`,
        });
      }
    });
  });

// ---------------------------------------------------------------------------
// 6.4 CritiqueReport
// ---------------------------------------------------------------------------

export const IssueSchema = z.object({
  id: z.string().min(1),
  /** `[x0, y0, x1, y1]`, inclusive, already clamped to the canvas. */
  region: z.tuple([Coord, Coord, Coord, Coord]),
  severity: z.enum(["high", "medium", "low"]),
  issue: z.string(),
  /**
   * Advisory only, never applied verbatim. Emptied — not dropped — when
   * `suggestConfidence` falls below the floor, so the agent keeps the problem
   * and loses only the guess.
   */
  suggest: z.string(),
  /** Is the PROBLEM real? */
  confidence: Unit,
  /** Is THIS FIX correct? Deliberately separate from `confidence`. */
  suggestConfidence: Unit,
});

export const CritiqueReportSchema = z.object({
  readsAs: z.string(),
  matchesIntent: z.boolean(),
  overall: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
  ]),
  issues: z.array(IssueSchema),
});

// ---------------------------------------------------------------------------
// 6.5 LintReport
// ---------------------------------------------------------------------------

/** The complete warning vocabulary. `lint()` may not invent codes outside it. */
export const LINT_CODES = [
  "orphan-pixel",
  "unused-palette-entry",
  "low-contrast",
  "outline-gap",
  "row-repaired",
] as const;

export const LintWarningSchema = z.object({
  code: z.enum(LINT_CODES),
  cells: z.array(z.tuple([Coord, Coord])),
  message: z.string(),
});

export const LintReportSchema = z.object({
  /** Schema violations — these block the round. */
  errors: z.array(z.string()),
  warnings: z.array(LintWarningSchema),
  metrics: z.object({
    coverage: Unit,
    paletteUsed: z.int().nonnegative(),
    orphanCount: z.int().nonnegative(),
    symmetryScore: Unit,
  }),
});

// ---------------------------------------------------------------------------
// 6.8 HarnessConfig
// ---------------------------------------------------------------------------

const ModelsSchema = z
  .object({
    generator: z.string().min(1).default("qwen3:8b"),
    critic: z.string().min(1).default("qwen3-vl:8b-instruct-q4_K_M"),
  })
  .default({ generator: "qwen3:8b", critic: "qwen3-vl:8b-instruct-q4_K_M" });

export const HarnessConfigSchema = z.object({
  maxRounds: z.int().positive().default(3),
  maxReviseTurns: z.int().positive().default(40),
  maxDraftRetries: z.int().nonnegative().default(1),
  repairRejectThreshold: Unit.default(0.2),
  confidenceFloor: Unit.default(0.3),
  suggestConfidenceFloor: Unit.default(0.5),
  stopOnNoHighSeverity: z.boolean().default(true),
  criticUpscale: z.int().positive().default(16),
  callTimeoutMs: z.int().positive().default(120000),
  models: ModelsSchema,
});

// ---------------------------------------------------------------------------
// 6.7 SessionHistory
// ---------------------------------------------------------------------------

export const PixelDiffSchema = z.object({
  x: Coord,
  y: Coord,
  from: RowChar,
  to: RowChar,
});

export const RoundSchema = z.object({
  round: z.int().nonnegative(),
  doc: SpriteDocSchema,
  /** `null` until the critic has run for this round. */
  critique: CritiqueReportSchema.nullable(),
  lint: LintReportSchema,
  /** Empty means the revise stage ran and changed nothing — the `empty-diff` stop. */
  diffFromPrev: z.array(PixelDiffSchema),
});

export const SessionHistorySchema = z.object({
  sessionId: z.string().min(1),
  /** Serialized on every run so two benchmark runs can be compared. */
  config: HarnessConfigSchema,
  rounds: z.array(RoundSchema),
});

// ---------------------------------------------------------------------------
// inferred types
// ---------------------------------------------------------------------------

export type Size = z.infer<typeof SizeSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type PaletteRef = z.infer<typeof PaletteRefSchema>;
export type SpriteDoc = z.infer<typeof SpriteDocSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type CritiqueReport = z.infer<typeof CritiqueReportSchema>;
export type LintCode = (typeof LINT_CODES)[number];
export type LintWarning = z.infer<typeof LintWarningSchema>;
export type LintReport = z.infer<typeof LintReportSchema>;
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type PixelDiff = z.infer<typeof PixelDiffSchema>;
export type Round = z.infer<typeof RoundSchema>;
export type SessionHistory = z.infer<typeof SessionHistorySchema>;

// ---------------------------------------------------------------------------
// defaults — spec §6.8
// ---------------------------------------------------------------------------

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
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
};
