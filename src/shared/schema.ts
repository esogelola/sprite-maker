/**
 * Single source of truth for every contract in the system — spec §6.
 *
 * Nothing here touches disk, the network, or Electron. Both processes import
 * these schemas so a value that crosses IPC is validated against the same
 * definition on each side.
 *
 * Spec §5.2 also puts `PipelineState`, `StopReason` and `PipelineEvent` here
 * rather than in `main/pipeline.ts`: preload and the renderer consume them, and
 * a *value* import of `@main/pipeline` from the renderer bundle would pull
 * `node:http` in behind it.
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

/** The transparent cell. Spelled here rather than imported: see `rowCharIndex`. */
const TRANSPARENT = ".";

/** Palette index `i` is spelled `HEX_CHARS[i]` — spec §6.1. */
const HEX_CHARS = "0123456789abcdef";

/**
 * A palette index the single-hex-character encoding can actually spell.
 *
 * The ceiling is the encoding's, not any one palette's: a warning naming index
 * 16 describes a colour no row could ever reference.
 */
const PaletteIndex = z.int().min(0).max(HEX_CHARS.length - 1);

/**
 * Row character → palette index, or `-1` for transparent and for anything that
 * is not a lowercase hex digit.
 *
 * Deliberately a local mirror of `charIndex` in `shared/grid.ts` rather than an
 * import: `grid.ts` imports its types from this module, and making the contract
 * layer depend on a behaviour module to state its own encoding inverts that.
 * `tests/shared/schema.test.ts` pins the two to agree character for character.
 */
function rowCharIndex(c: string): number {
  return HEX_CHARS.indexOf(c);
}

/** A whole row of encoded pixels. Length is checked against `size.w` on the doc. */
const Row = z.string().regex(/^[.0-9a-f]*$/, "rows may only contain '.' and 0-f");

/** A unit interval, used by both confidence fields and the lint metrics. */
const Unit = z.number().min(0).max(1);

/** Elapsed wall clock. `number` rather than `int` — `performance.now()` is fractional. */
const Millis = z.number().nonnegative();

// ---------------------------------------------------------------------------
// 6.2 SpriteDoc
// ---------------------------------------------------------------------------

/**
 * Canvas dimensions — spec §6.2. **Square only.**
 *
 * A union of the three square literals rather than two independent unions over
 * `w` and `h`. The v1 shape admitted all nine combinations, so `{ w: 16, h: 64 }`
 * parsed clean while every consumer — the renderer's cell grid, the critic's
 * `scale = criticTargetPx / size.w`, the linter's mirror axis — assumed three
 * sizes and would have read the wrong one.
 *
 * Discriminated on `w` so a non-square names the offending field rather than
 * reporting a bare "no union member matched".
 */
export const SizeSchema = z.discriminatedUnion("w", [
  z.object({ w: z.literal(16), h: z.literal(16) }),
  z.object({ w: z.literal(32), h: z.literal(32) }),
  z.object({ w: z.literal(64), h: z.literal(64) }),
]);

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
  /**
   * 1-based — spec §7.5 pins the draft as round 1, so there is no round 0.
   *
   * `positive()`, not `nonnegative()`: the lenient bound let a 0-based pipeline
   * write a whole session of documents the schema could not object to, and the
   * off-by-one would first surface in the filmstrip labels and the bench CSV,
   * a long way from its cause. `repairs` below stays `nonnegative()` — that one
   * counts from zero, and zero is the good case.
   */
  round: z.int().positive(),
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
  // Cross-field: the grid has to actually be the shape it declares, and every
  // index in it has to be one the declared palette actually carries. A plain
  // array schema can see neither `size` nor `palette`, so this is a refinement.
  .superRefine((doc, ctx) => {
    if (doc.rows.length !== doc.size.h) {
      ctx.addIssue({
        code: "custom",
        path: ["rows"],
        message: `expected ${doc.size.h} rows to match size.h, got ${doc.rows.length}`,
      });
    }
    // Spec §6.3 amendment A4. `Row`'s pattern admits all of `0`-`f` because it
    // cannot see the palette; a 4-colour `gameboy` doc carrying an `f` used to
    // parse clean and only fail at the renderer, where `colors[15]` is
    // `undefined`. Off-palette is refused here, repaired in `normalize`, and
    // thrown on by `setPixel` — three jobs, three answers.
    const paletteSize = doc.palette.colors.length;
    doc.rows.forEach((row, y) => {
      if (row.length !== doc.size.w) {
        ctx.addIssue({
          code: "custom",
          path: ["rows", y],
          message: `row ${y} has ${row.length} chars, expected ${doc.size.w} to match size.w`,
        });
      }
      for (let x = 0; x < row.length; x++) {
        const c = row[x];
        if (c === TRANSPARENT) continue;
        const i = rowCharIndex(c);
        if (i >= paletteSize) {
          ctx.addIssue({
            code: "custom",
            path: ["rows", y],
            message:
              `row ${y} char ${x} is '${c}', palette index ${i}, but palette ` +
              `'${doc.palette.id}' has ${paletteSize} colors — valid characters ` +
              `are '.' and 0-${HEX_CHARS[paletteSize - 1]}`,
          });
          break; // one issue per row: 256 copies of the same fault helps nobody
        }
      }
    });
  });

// ---------------------------------------------------------------------------
// 6.2a DrawOp — the shape DSL, amendment A10
// ---------------------------------------------------------------------------

/**
 * How far outside the canvas a coordinate is still taken as an arithmetic slip.
 *
 * §6.2a's ops are **clamped, not rejected**: `cx: 20` on a 16-wide canvas meant
 * "near the right edge" and draws its visible part. But clamping is a statement
 * about *near* misses. A bound is still needed for two reasons: `line` walks its
 * endpoints one pixel at a time, so an unbounded `x1` is an unbounded loop; and
 * a coordinate eight canvases away is not a slip, it is a model that lost the
 * canvas, and dropping that one op is cheaper than drawing a smear.
 *
 * 512 is 8× the largest canvas §6.2 admits.
 */
export const OP_COORD_LIMIT = 512;

/** A `DrawOp` coordinate. Signed and unbounded by the canvas — `applyOp` clamps. */
const OpCoord = z.int().min(-OP_COORD_LIMIT).max(OP_COORD_LIMIT);

/**
 * An ellipse radius. Non-negative, and **0 is a legal radius**: it names the
 * single pixel at the centre, which is how a model draws an eye.
 */
const OpRadius = z.int().nonnegative().max(OP_COORD_LIMIT);

/**
 * One shape operation — spec §6.2a, amendment A10.
 *
 * **`index` is a row character, not a number.** The model is shown the palette
 * as `0 = #0f380f`, so `"0"` is the vocabulary it already has; asking for the
 * integer `0` in the ops and the character `"0"` in the prompt would be two
 * spellings of one idea, and `"0"` — black, the most common outline colour — is
 * exactly the value a falsy-number check would drop.
 *
 * `mirror_x` and `clear` carry no `index`: one copies pixels and the other
 * erases to transparent, and giving either a colour would invite a model to
 * "clear to white".
 *
 * Every variant is strict. An op with a stray key is a model that invented a
 * parameter, and silently dropping the key would draw something the op list
 * does not describe — and the op list is the artifact §6.2a says a human reads.
 */
export const DrawOpSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("ellipse"),
    cx: OpCoord,
    cy: OpCoord,
    rx: OpRadius,
    ry: OpRadius,
    index: RowChar,
  }),
  z.strictObject({
    op: z.literal("fill_rect"),
    x0: OpCoord,
    y0: OpCoord,
    x1: OpCoord,
    y1: OpCoord,
    index: RowChar,
  }),
  z.strictObject({
    op: z.literal("line"),
    x0: OpCoord,
    y0: OpCoord,
    x1: OpCoord,
    y1: OpCoord,
    index: RowChar,
  }),
  /** `axis` is the first column of the right half: 8 mirrors x 0-7 onto x 8-15. */
  z.strictObject({ op: z.literal("mirror_x"), axis: OpCoord }),
  z.strictObject({
    op: z.literal("clear"),
    x0: OpCoord,
    y0: OpCoord,
    x1: OpCoord,
    y1: OpCoord,
  }),
]);

/** The five op names, in the order §6.2a lists them. */
export const DRAW_OP_NAMES = ["ellipse", "fill_rect", "line", "mirror_x", "clear"] as const;

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
  /** `null` when degraded — a critique that never ran describes nothing. */
  readsAs: z.string().nullable(),
  matchesIntent: z.boolean(),
  /**
   * `null` when degraded, and **never invented**. A fabricated 1-5 score lands
   * in `SessionHistory` and pollutes every bench-derived quality metric, and
   * §11's "human rating" bar is read beside it.
   */
  overall: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .nullable(),
  /**
   * True when the critic could not be parsed twice — spec §6.4.
   *
   * Not cosmetic: without it the pipeline reports `no-high-severity` and tells
   * the user the sprite passed a critique that never ran.
   *
   * Defaulted to `false` rather than required because the *model* never emits
   * this field — it is a harness-side verdict, and §6.4's repair table (which
   * lists everything `parseCritique` synthesizes before validation) does not
   * name it. Required, every real critic response would fail validation and
   * degrade, which is exactly the permanent silent no-op §6.4 was written to
   * prevent. The degraded report is built by the harness and states `true`
   * explicitly.
   */
  degraded: z.boolean().default(false),
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
  /**
   * Which palette index — or index pair — the warning concerns. `[i, j]` on
   * `low-contrast`, `[i]` on `unused-palette-entry`, absent on the rest.
   *
   * Exists so consumers do not have to regex free text to learn which palette
   * entry a warning is about: the dock highlights a swatch, and the bench
   * counts pairs.
   */
  indices: z.array(PaletteIndex).optional(),
  message: z.string(),
});

/**
 * Spec §6.5, ruling R3: **there is no `errors` field**, and no `LINTING → FAILED`
 * edge. `lint()` receives an already-validated `SpriteDoc`, and amendment A4
 * made every structural violation `errors` could have described unrepresentable
 * before `lint()` is called. A dead branch Wave 9 must implement and cannot test
 * is worse than no branch.
 *
 * Strict, so a producer still carrying the deleted field fails loudly. A plain
 * object would silently strip it — and a *silently stripped* schema violation is
 * precisely the failure the field was invented to report.
 */
export const LintReportSchema = z.strictObject({
  warnings: z.array(LintWarningSchema),
  metrics: z.strictObject({
    coverage: Unit,
    paletteUsed: z.int().nonnegative(),
    orphanCount: z.int().nonnegative(),
    /**
     * Fraction of non-transparent cells whose mirror about the vertical centre
     * axis holds the same index. **A sprite with no non-transparent cells
     * scores 1** — a blank canvas is trivially symmetric. Without that, `0/0`
     * is `NaN`, which fails these bounds and serializes to `null`, surfacing as
     * an opaque round-trip failure two stages from its cause.
     */
    symmetryScore: Unit,
  }),
});

// ---------------------------------------------------------------------------
// 6.8 HarnessConfig
// ---------------------------------------------------------------------------

/**
 * The role bindings — spec §3, amendment A10.
 *
 * **Both roles are bound to `qwen3-vl:8b-instruct-q4_K_M`.** §3 named
 * `qwen3:8b` as the generator and noted that "`qwen3-vl` also handles text-only
 * prompts, so both roles can be bound to it to eliminate model-swap stalls —
 * that is a config change, not a code change." This is that config change, and
 * the reason it is now the default rather than an option is measured:
 * `captures/2026-07-30-generator-capability-benchmark.txt` records `qwen3:8b`
 * returning a **solid rectangle** for "8 lines of 8 characters", the most
 * forgiving format available, with prompt, temperature, example size and palette
 * each eliminated as the cause. `qwen3-vl:8b-instruct-q4_K_M` composed a
 * recognisable 5-colour fox from the same subject and palette, and cleared
 * A11's gauge bar in one batch live
 * (`captures/2026-07-30-wave-6b-live-draft.txt`).
 *
 * A text model that cannot draw is not a generator, however cheap its tokens
 * are. The secondary win is the one §3 predicted: one 6 GB model serves both
 * roles, so a round costs no model swap.
 *
 * `qwen3:8b` remains installable and bindable through §9's pickers — this is a
 * default, not a restriction.
 */
const ModelsSchema = z
  .strictObject({
    generator: z.string().min(1).default("qwen3-vl:8b-instruct-q4_K_M"),
    critic: z.string().min(1).default("qwen3-vl:8b-instruct-q4_K_M"),
  })
  .default({
    generator: "qwen3-vl:8b-instruct-q4_K_M",
    critic: "qwen3-vl:8b-instruct-q4_K_M",
  });

/**
 * **Strict.** §6.8 exists so two benchmark runs can be compared, and the config
 * is serialized into every `SessionHistory` to make that possible. A lenient
 * object silently drops a key it does not recognize and substitutes today's
 * default in its place — so a history written when the field was `criticUpscale`
 * re-parses claiming `criticTargetPx: 512`, a limit that run never used. That is
 * exactly "a difference might come from the change under test or from a limit
 * that was altered and forgotten," the sentence §6.8 uses to justify itself.
 *
 * Strictness rejects *unknown* keys, not absent ones: every field here has a
 * default, so `parse({})` still yields `DEFAULT_HARNESS_CONFIG` and a partial
 * override remains the normal way to call this. `models` is strict for the same
 * reason one level down.
 */
export const HarnessConfigSchema = z.strictObject({
  /** Bounds the number of CRITIQUES — the draft is round 1 (spec §7.5). */
  maxRounds: z.int().positive().default(3),
  maxReviseTurns: z.int().positive().default(40),
  maxDraftRetries: z.int().nonnegative().default(1),
  repairRejectThreshold: Unit.default(0.2),
  confidenceFloor: Unit.default(0.3),
  suggestConfidenceFloor: Unit.default(0.5),
  stopOnNoHighSeverity: z.boolean().default(true),
  /**
   * A **target**, not a multiplier — spec §6.8, replacing `criticUpscale: 16`.
   *
   * §4.4 asks for a nearest-neighbour upscale to approximately 512px. A fixed
   * ×16 gives 16×16 → 256px and 64×64 → 1024px, the latter downsampled straight
   * back by the vision encoder at several times the image-token cost. The scale
   * is derived: `max(1, floor(criticTargetPx / size.w))`.
   */
  criticTargetPx: z.int().positive().default(512),
  /** Scaled by canvas area at the call site: `× (w × h) / (32 × 32)` (§6.8). */
  callTimeoutMs: z.int().positive().default(120000),
  /**
   * The floor under the area-scaled timeout — spec §6.8, amendment A12.
   *
   * Pure area scaling made the *smallest* canvas the tightest deadline: a 16×16
   * got `120000 × 256/1024 = 30s`, which a revise turn exceeds, so **every
   * 16×16 run ended `FAILED` after round 1** — the app's first real generation.
   * Cold-loading a 6-19 GB model costs 8-25 s no matter what is being drawn, and
   * on the smallest canvas that was most of the budget.
   */
  callTimeoutFloorMs: z.int().positive().default(45000),
  /**
   * How many op batches one draft attempt may spend — spec §6.2b, amendment A11.
   *
   * The cap, not the target. **The harness owns the stop decision**: the loop
   * exits the moment `draftGaugeBar` clears, so a first batch that clears costs
   * one inference and only a weak draft pays for more. In the benchmark the
   * model never once set `done: true` — it consumed every batch it was offered,
   * and on the subject one shot already drew well, five batches produced a
   * *simpler*, worse sprite.
   */
  maxDraftBatches: z.int().positive().default(5),
  /**
   * When the draft is finished — spec §6.2b, amendment A11.
   *
   * Measured against the failure the loop exists to catch: a model that commits
   * to one fill and never notices it has made a monochrome mass. `minColours`
   * and `minDistinctRows` are what a mass fails; `maxCoverage` is what a canvas
   * flooded by a runaway `fill_rect` fails.
   */
  draftGaugeBar: z
    .strictObject({
      minColours: z.int().positive().default(3),
      minCoverage: Unit.default(0.12),
      maxCoverage: Unit.default(0.8),
      minDistinctRows: z.int().positive().default(8),
    })
    .default({ minColours: 3, minCoverage: 0.12, maxCoverage: 0.8, minDistinctRows: 8 }),
  models: ModelsSchema,
});

// ---------------------------------------------------------------------------
// 7.1 / 7.2 pipeline vocabulary
//
// Here rather than in `main/pipeline.ts` (spec §5.2): `SessionHistory` embeds
// both, and preload and the renderer read both.
// ---------------------------------------------------------------------------

/** Every state in spec §7.1's machine, in the order the diagram walks them. */
export const PIPELINE_STATES = [
  "IDLE",
  "DRAFTING",
  "LINTING",
  "CRITIQUING",
  "REVISING",
  "AWAITING_USER",
  "DONE",
  "FAILED",
] as const;

export const PipelineStateSchema = z.enum(PIPELINE_STATES);

/**
 * Spec §7.2. Evaluated on the **filtered** issue list, in this order — the
 * predicates are mutually exclusive.
 *
 * `critic-failed` is deliberately distinct from `no-high-severity`: without it
 * a broken critic reports success and the user is told the sprite passed a
 * critique that never ran.
 */
export const STOP_REASONS = [
  "no-high-severity",
  "round-cap",
  "empty-diff",
  "critic-failed",
] as const;

export const StopReasonSchema = z.enum(STOP_REASONS);

// ---------------------------------------------------------------------------
// 6.7 SessionHistory and Round
// ---------------------------------------------------------------------------

export const PixelDiffSchema = z.object({
  x: Coord,
  y: Coord,
  from: RowChar,
  to: RowChar,
});

/**
 * What `revise()` reports about its own run — spec §6.6.
 *
 * `hitCap` is what the bench exists to surface ("did the agent exhaust its
 * turns"), and `summary` is the agent's own account of what it did, the most
 * legible per-round artifact in the system.
 */
export const ReviseSummarySchema = z.object({
  turns: z.int().nonnegative(),
  hitCap: z.boolean(),
  summary: z.string(),
});

/**
 * Per-stage wall clock. Every member is nullable because not every stage runs
 * every round: only round 1 has a draft, and a converged round has no revise.
 *
 * The prototype renders elapsed time and §13's bench CSV requires four timing
 * columns; nothing recorded any.
 */
export const RoundTimingsSchema = z.object({
  draftMs: Millis.nullable(),
  critiqueMs: Millis.nullable(),
  reviseMs: Millis.nullable(),
});

export const RoundSchema = z.object({
  /**
   * 1-based; the draft is round 1 (spec §7.5). `positive()` for the same reason
   * `meta.round` is — round 0 is not a round, and `acceptedRound` names this
   * number rather than an array index.
   */
  round: z.int().positive(),
  doc: SpriteDocSchema,
  /** Of THIS doc — the round is snapshotted at the top of the iteration (R2). */
  lint: LintReportSchema,
  /** Raw and unfiltered, of THIS doc. `null` until the critic has run. */
  critique: CritiqueReportSchema.nullable(),
  /**
   * What the revise stage actually received, after §6.4's two-tier filter.
   *
   * Separate from `critique` because storing only the filtered report destroys
   * the data needed to tune `confidenceFloor` — and §12 says those floors are
   * first guesses for the bench to tune — while storing only the raw report
   * shows the UI `suggest` text the agent never received, and the renderer
   * cannot filter for itself because `filterIssues` lives in main.
   */
  filteredIssues: z.array(IssueSchema),
  /**
   * `null` on the first round, which has no predecessor to diff against.
   *
   * Non-nullable made "this is the first round" and "the revise stage changed
   * nothing" the *same value*, and §6.7's v1 prose pointed the `empty-diff`
   * stop condition straight at this stored field — so a literal implementation
   * stopped every run right after the draft with a bogus stop reason. §7.2 now
   * evaluates `empty-diff` on the revise transition, as `diff(before, after)`,
   * and never by reading this field.
   *
   * Computed against the round's **parent**, not the array-previous:
   * `applyFeedback(roundIndex)` may branch from any round.
   */
  diffFromPrev: z.array(PixelDiffSchema).nullable(),
  /**
   * The user's own words at the gate, `null` on a round the user did not drive.
   * §1 claims every revision round is preserved and comparable, but the
   * feedback text lived only in a transient synthetic `Issue`.
   */
  userFeedback: z.string().nullable(),
  /** `null` on a round that skipped `REVISING`. */
  revise: ReviseSummarySchema.nullable(),
  timings: RoundTimingsSchema,
});

/**
 * A draft rejected twice over `repairRejectThreshold` — spec §6.3, §6.7.
 *
 * Not a `Round`: a rejected draft has no valid `SpriteDoc`, and it happens
 * *before* round 1 exists, so calling it a round would be a lie the schema then
 * has to accommodate everywhere.
 */
export const DraftFailureSchema = z.object({
  /** 1-based. Attempt 1 is the first draft, attempt 2 the single §6.3 retry. */
  attempt: z.int().positive(),
  /** The model's raw output, preserved so a failure is diagnosable after the fact. */
  raw: z.string(),
  repairs: z.int().nonnegative(),
  reason: z.string(),
});

export const SessionHistorySchema = z.object({
  /**
   * Staleness detection — spec §6.7, and the other half of the strict
   * `HarnessConfigSchema` above.
   *
   * A pinned literal rather than a number: version 2 is a shape this parser has
   * never seen, so accepting the field while ignoring its value would leave the
   * artifact claiming a guarantee nothing checked. Together the two say *which
   * shape a history was written against* and *fail loudly when it is not this
   * one* — which is what `SessionHistory` otherwise had no signal for at all.
   */
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  /** Serialized on every run so two benchmark runs can be compared. */
  config: HarnessConfigSchema,
  rounds: z.array(RoundSchema),
  draftFailures: z.array(DraftFailureSchema),
  /** `null` while the run is still going, or when it failed before stopping. */
  stopReason: StopReasonSchema.nullable(),
  /**
   * The terminal state. With `outcome`, this is what lets §11's acceptance bars
   * and the status bar read a finished run off the artifact instead of off a
   * transient event that a reload destroys.
   */
  finalState: PipelineStateSchema,
  outcome: z.enum(["completed", "failed"]),
  /**
   * Why a run failed, when the failure was not a draft rejection — spec §6.7.
   *
   * `draftFailures` covers draft rejection only. An `OllamaTimeoutError` during
   * `CRITIQUING` is not a draft failure and nothing else could hold it, so a
   * persisted history could not say why it failed — while §8 has the status bar
   * read failure state off exactly that artifact.
   *
   * Required with a nullable value, not optional: an absent key and an explicit
   * `null` would otherwise be the same artifact, and a writer that forgot the
   * field would be indistinguishable from a run that succeeded. Deliberately
   * *not* cross-refined against `outcome` — a draft-rejection failure leaves
   * this `null` and reports itself through `draftFailures`, so tying the two
   * together would collapse the two failure modes this field exists to separate.
   */
  error: z.string().nullable(),
  /**
   * Which round the user accepted, `null` until the gate is answered. The
   * global constraint "any round may be accepted, not only the last" was
   * implemented by no wave and recorded in no field.
   *
   * **Stores `Round.round`, which is 1-based — not an array index** (spec
   * §6.7). `Api.accept(roundIndex)` speaks the renderer's 0-based array
   * position, so exactly one conversion stands between the two, and
   * `accept(0)` — accepting the draft, the most common call there is — is
   * where dropping it shows up. `positive()` rather than `nonnegative()` so
   * the un-converted index cannot be persisted: a stored `0` names a round
   * that §7.5 says does not exist, and nothing downstream could tell it apart
   * from a deliberate value.
   */
  acceptedRound: z.int().positive().nullable(),
});

// ---------------------------------------------------------------------------
// 7.1 PipelineEvent
// ---------------------------------------------------------------------------

/**
 * Every transition emits one of these (§7.1), and the renderer subscribes via
 * `Api.onEvent`. Three variants, each traceable to a requirement:
 *
 * - `state` — "every transition emits a typed event."
 * - `revise-turn` — "`REVISING` emits per-turn progress." It is the longest
 *   stage; without it §7.1's promise of live progress holds for state changes
 *   only while a 40-turn loop shows one static label.
 * - `round` — carries the whole snapshot, because `run()` resolves only at the
 *   gate (minutes later, per §12) and the `Api` has no method to read an
 *   in-progress history, so a mid-run filmstrip frame has no other source.
 *
 * Terminal information is deliberately *not* an event: `stopReason`,
 * `finalState` and `outcome` are read from the persisted `SessionHistory` so
 * they survive a reload (§8), and a failure's payload crosses IPC in `run()`'s
 * result envelope, which — unlike a rejection — keeps its own fields (§9).
 */
export const PipelineEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("state"),
    state: PipelineStateSchema,
    /** 0 before round 1 exists. */
    round: z.int().nonnegative(),
  }),
  z.object({
    type: z.literal("round"),
    snapshot: RoundSchema,
  }),
  z.object({
    type: z.literal("revise-turn"),
    round: z.int().nonnegative(),
    /** 1-based, so the first turn is `1 of maxTurns`. */
    turn: z.int().positive(),
    maxTurns: z.int().positive(),
  }),
]);

// ---------------------------------------------------------------------------
// 6.9 Ollama client contract — types only
//
// Wave 5 produces the client, but the Wave 8 revise loop, the test stub and
// preload all speak these shapes, and none of them may import from `main/`.
// They are TypeScript types rather than schemas because they describe a wire
// format we send, not untrusted input we validate: `chatWithTools` parses the
// model's reply into a `ChatTurn` itself.
// ---------------------------------------------------------------------------

/** One tool invocation. `arguments` is raw — Wave 8 coerces numeric strings. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * One message in a chat transcript.
 *
 * **`tool_calls` is required for the revise loop to function at all.** To
 * continue a tool conversation the loop must append the assistant's turn
 * *including the call it made*, then the tool results. Ollama's chat template
 * renders `tool_calls` off the assistant message; without it the tool results
 * arrive unmoored and the model re-issues calls it has already made, burning
 * the turn cap.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant side. */
  tool_calls?: ToolCall[];
  /** Tool side — names the call this message answers. */
  tool_call_id?: string;
}

/** One assistant turn, already split into prose and calls. */
export interface ChatTurn {
  content: string;
  toolCalls: ToolCall[];
}

/**
 * A tool offered to the model, in the envelope Ollama marshals onto the wire.
 * `parameters` is a JSON Schema object, kept opaque here: it is data we hand to
 * the model, not a shape this module validates.
 */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// inferred types
// ---------------------------------------------------------------------------

export type Size = z.infer<typeof SizeSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type DrawOp = z.infer<typeof DrawOpSchema>;
export type DrawOpName = (typeof DRAW_OP_NAMES)[number];
export type DraftGaugeBar = HarnessConfig["draftGaugeBar"];
export type PaletteRef = z.infer<typeof PaletteRefSchema>;
export type SpriteDoc = z.infer<typeof SpriteDocSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type CritiqueReport = z.infer<typeof CritiqueReportSchema>;
export type LintCode = (typeof LINT_CODES)[number];
export type LintWarning = z.infer<typeof LintWarningSchema>;
export type LintReport = z.infer<typeof LintReportSchema>;
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type PipelineState = z.infer<typeof PipelineStateSchema>;
export type StopReason = z.infer<typeof StopReasonSchema>;
export type PixelDiff = z.infer<typeof PixelDiffSchema>;
export type ReviseSummary = z.infer<typeof ReviseSummarySchema>;
export type RoundTimings = z.infer<typeof RoundTimingsSchema>;
export type Round = z.infer<typeof RoundSchema>;
export type DraftFailure = z.infer<typeof DraftFailureSchema>;
export type SessionHistory = z.infer<typeof SessionHistorySchema>;
export type PipelineEvent = z.infer<typeof PipelineEventSchema>;

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
  criticTargetPx: 512,
  callTimeoutMs: 120000,
  callTimeoutFloorMs: 45000,
  maxDraftBatches: 5,
  draftGaugeBar: { minColours: 3, minCoverage: 0.12, maxCoverage: 0.8, minDistinctRows: 8 },
  // Both roles, one model — see `ModelsSchema`. `qwen3:8b` cannot draw.
  models: {
    generator: "qwen3-vl:8b-instruct-q4_K_M",
    critic: "qwen3-vl:8b-instruct-q4_K_M",
  },
};
