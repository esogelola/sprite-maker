/**
 * The draft stage — prompt → generator → `SpriteDoc`. Spec §6.2a (A10), §6.2b
 * (A11), §6.3, §6.8 (A12), §7.4, §7.5; plan Wave 6b.
 *
 * **Wave 10 booted the app and its first real generation proved the old draft
 * did not work.** It timed out at 30,005 ms and rendered a six-wide vertical bar
 * instead of a fox. Two benchmarks explain both halves of that, and this module
 * is what they produced:
 *
 * **A10 — the model composes; the interpreter draws.** No locally-runnable model
 * can write the grid: `qwen3:8b` returns a solid rectangle when asked for "8
 * lines of 8 characters", the most forgiving format available, and prompt,
 * temperature, example size and palette were each eliminated as causes
 * (`captures/2026-07-30-generator-capability-benchmark.txt`). The same
 * `qwen3-vl:8b` composed a recognisable five-colour fox from thirteen shape
 * operations (`captures/2026-07-30-shape-dsl-benchmark.txt`). So the draft asks
 * for 8-20 operations and `main/dsl.ts` counts the cells.
 *
 * **A11 — the harness owns the stop decision.** After each batch the canvas and
 * its measurements go back to the model. The loop exits the *moment* the gauge
 * clears the bar, because in the benchmark the model never once set
 * `done: true` — it consumed every batch it was offered, and on the subject one
 * shot already drew well, five further batches produced a simpler, worse sprite.
 * A first batch that clears costs one inference. An empty `ops` array is "no
 * further progress" and stops the loop.
 *
 * **A12 — the timeout has a floor.** Pure area scaling made the *smallest*
 * canvas the tightest deadline: a 16×16 got 30 s, which a revise turn exceeds,
 * so every 16×16 run ended `FAILED` after round 1.
 *
 * Four properties survive from Wave 6 unchanged, because they were never the
 * problem:
 *
 * **1. `parseDraft` never throws.** Whatever arrives — prose, a fenced block, a
 * half-written object, an empty string — it produces a `w`×`h` grid and a repair
 * count. Unparseable output degrades to `rows: []`, which routes into the
 * ordinary retry path rather than escaping the state machine.
 *
 * **2. The threshold is an unbounded ratio** (§6.3, A5). `repairs` is not a
 * percentage and is not bounded by 1.
 *
 * **3. Every call sends `think: false`** (A8) and carries an `AbortSignal`.
 *
 * **4. `draft()` produces the first document and only the first** (§7.5).
 *
 * **What A10 makes unreachable, and what that means for `normalize`.** The draft
 * call now sends a JSON *Schema* as `format`, so the model cannot emit a row at
 * all, let alone one of the wrong width — §6.3's length repairs are unreachable
 * from this stage. `normalize` is **not** deleted: it is still the parser for a
 * `SpriteDoc` loaded from disk, still the definition of what a repair *is*, and
 * still what turns an unparseable reply into a rejection that says why. It is
 * reached from here only by the compatibility branch in `composeBatch`, which
 * exists because `parseDraft` is a public, never-throwing parser of arbitrary
 * text and a caller running against an unconstrained endpoint may still hand it
 * a whole-canvas answer.
 */

import { randomUUID } from "node:crypto";

import { applyOp, clearsGaugeBar, gauge, type Gauge } from "@main/dsl";
import type { GenerateRequest, OllamaClient } from "@main/ollama";
import {
  buildDraftFormat,
  buildDraftPrompt,
  buildGaugePrompt,
  buildRetryPrompt,
} from "@main/prompts/draft";
import {
  TRANSPARENT,
  charIndex,
  indexChar,
  makeEmpty,
  normalize,
  type Grid,
} from "@shared/grid";
import { getPalette, type Palette } from "@shared/palettes";
import {
  DrawOpSchema,
  SpriteDocSchema,
  type DraftFailure,
  type DrawOp,
  type HarnessConfig,
  type Intent,
  type Size,
  type SpriteDoc,
} from "@shared/schema";

export { buildDraftPrompt };

/** The canvas §6.8's `callTimeoutMs` is quoted against: `× (w × h) / (32 × 32)`. */
const BASE_AREA = 32 * 32;

/**
 * How many defect lines a retry prompt carries.
 *
 * A 64×64 reply of pure noise has 128 describable defects; sending all of them
 * would bury the instruction in its own evidence and cost more prompt than the
 * sprite.
 */
const MAX_DEFECT_LINES = 12;

/**
 * A draft rejected twice — spec §6.3.
 *
 * `raw` is the model's own last output, preserved because §6.7 records it in
 * `SessionHistory.draftFailures`: a rejected draft has no valid `SpriteDoc`, so
 * without the raw text a failed run cannot be diagnosed after the fact.
 *
 * Both fields are also on the message, because §9 sends errors across IPC as a
 * result envelope and `ipcMain.handle` destroys an error's own properties.
 */
export class DraftRejectedError extends Error {
  override readonly name = "DraftRejectedError";

  constructor(
    readonly repairs: number,
    readonly raw: string,
  ) {
    super(
      `Draft rejected: ${repairs} repaired cells exceeded repairRejectThreshold. ` +
        `Raw output was ${raw.length} characters.`,
    );
  }
}

// ---------------------------------------------------------------------------
// parsing — spec §6.2a and §6.3
// ---------------------------------------------------------------------------

/**
 * What the model actually sent, before validation.
 *
 * `ops: null` and `rows: null` are both "the reply did not carry this shape",
 * deliberately distinct from an empty array: `{"ops":[]}` is a model saying it
 * has nothing to add — §6.2b's stop signal — and a reply with no `ops` key at
 * all is a model that did not answer the question.
 */
interface ExtractedDraft {
  ops: unknown[] | null;
  rows: string[] | null;
  intent: Intent;
}

/**
 * The first JSON object or array in `raw`, or `undefined`.
 *
 * Three candidates in order of trust: the whole reply, the contents of a fenced
 * block, and the span between the outermost braces (or brackets). Models wrap
 * their answer in all three shapes, and `think: false` makes the bare object the
 * common case rather than the lucky one.
 *
 * Wrapped in `{ value }` rather than returned bare so that a literal `null` —
 * which `JSON.parse` accepts — cannot be confused with "nothing parsed".
 */
function parseJsonish(raw: string): { value: unknown } | undefined {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced !== null) candidates.push(fenced[1].trim());

  const openBrace = trimmed.indexOf("{");
  const closeBrace = trimmed.lastIndexOf("}");
  if (openBrace >= 0 && closeBrace > openBrace) {
    candidates.push(trimmed.slice(openBrace, closeBrace + 1));
  }

  const openBracket = trimmed.indexOf("[");
  const closeBracket = trimmed.lastIndexOf("]");
  if (openBracket >= 0 && closeBracket > openBracket) {
    candidates.push(trimmed.slice(openBracket, closeBracket + 1));
  }

  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      // `null` and bare numbers are parseable JSON that carry no sprite.
      if (value !== null && typeof value === "object") return { value };
    } catch {
      // Not this candidate. A failed parse is the expected case, not an error.
    }
  }
  return undefined;
}

/** A non-string row becomes `""`, which `normalize` charges as a whole lost row. */
function toRows(value: unknown[]): string[] {
  return value.map((entry) => (typeof entry === "string" ? entry : ""));
}

/**
 * The model's intent, keeping only what `IntentSchema` would accept.
 *
 * Hand-built rather than parsed so that one bad optional field — `facing:
 * "left"` is the routine one — costs that field rather than the whole draft.
 * A bare string is taken as the subject: a model answering `"intent": "a red
 * fox"` has said exactly what the field is for.
 */
function readIntent(value: unknown): Intent {
  if (typeof value === "string") return { subject: value };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { subject: "" };
  }
  const record = value as Record<string, unknown>;
  const intent: Intent = {
    subject: typeof record.subject === "string" ? record.subject : "",
  };
  if (typeof record.style === "string") intent.style = record.style;
  if (record.facing === "front" || record.facing === "side" || record.facing === "three-quarter") {
    intent.facing = record.facing;
  }
  if (typeof record.notes === "string") intent.notes = record.notes;
  return intent;
}

/** Is this array plainly a list of operations rather than a list of rows? */
function looksLikeOps(value: unknown[]): boolean {
  return value.some(
    (entry) => entry !== null && typeof entry === "object" && "op" in (entry as object),
  );
}

/** `{ intent, ops }`, `{ intent, rows }`, a bare array of either, or nothing. */
function extractDraft(raw: string): ExtractedDraft {
  const parsed = parseJsonish(raw);
  if (parsed === undefined) return { ops: null, rows: null, intent: { subject: "" } };

  const { value } = parsed;
  // A model that answers with the list alone has still answered.
  if (Array.isArray(value)) {
    return looksLikeOps(value)
      ? { ops: value, rows: null, intent: { subject: "" } }
      : { ops: null, rows: toRows(value), intent: { subject: "" } };
  }

  const record = value as Record<string, unknown>;
  return {
    ops: Array.isArray(record.ops) ? record.ops : null,
    rows: Array.isArray(record.rows) ? toRows(record.rows) : null,
    intent: readIntent(record.intent),
  };
}

/** One batch of operations, validated — spec §6.2a. */
export interface ParsedOps {
  /** Every entry `DrawOpSchema` accepted and this palette can spell. */
  ops: DrawOp[];
  /** Entries that were refused. Named so a retry prompt can say how many. */
  dropped: number;
  /** `false` when the reply carried no `ops` array at all, as opposed to `[]`. */
  carried: boolean;
  intent: Intent;
}

/**
 * Model output → a validated op batch — spec §6.2a. **Never throws.**
 *
 * Entries are dropped individually rather than failing the batch, for §6.3's
 * reason one level down: a model that invented a sixth op has still composed the
 * other twelve correctly, and throwing the batch away costs an inference to
 * recover one operation.
 *
 * An `index` past the end of the palette is dropped rather than mapped to `.`.
 * §6.3 maps an off-palette *cell* to transparent because a lost cell is a lost
 * cell; an op mapped to transparent would *erase* whatever is underneath it,
 * which is a worse answer than not drawing. In production the decoder cannot
 * emit one anyway — `buildDraftFormat` builds the `index` enum from the palette.
 */
export function parseOps(raw: string, paletteSize: number): ParsedOps {
  const { ops, intent } = extractDraft(raw);
  if (ops === null) return { ops: [], dropped: 0, carried: false, intent };

  const kept: DrawOp[] = [];
  let dropped = 0;
  for (const entry of ops) {
    const parsed = DrawOpSchema.safeParse(entry);
    if (!parsed.success) {
      dropped++;
      continue;
    }
    const op = parsed.data;
    if ("index" in op && op.index !== TRANSPARENT && charIndex(op.index) >= paletteSize) {
      dropped++;
      continue;
    }
    kept.push(op);
  }
  return { ops: kept, dropped, carried: true, intent };
}

/**
 * Model output → a repaired grid, an intent, and the repair record — spec §6.3.
 *
 * **Never throws.** The signature takes no prompt, so an intent the model did
 * not send comes back with an empty `subject`; `draft()` substitutes the user's
 * own prompt when it builds the document.
 *
 * Under A10 the draft asks for operations, not rows, and the schema-constrained
 * `format` makes a row unrepresentable — so this is the parser for a *whole-
 * canvas* answer, which is what a `SpriteDoc` on disk and an unconstrained
 * endpoint still produce. `rows` is reported so a caller can tell "the model
 * answered with a canvas" from "the model answered with nothing", which the
 * repaired grid alone cannot distinguish.
 */
export function parseDraft(
  raw: string,
  size: Size,
  palette: Palette,
): {
  grid: Grid;
  rows: string[] | null;
  intent: Intent;
  repairs: number;
  repairedRows: number[];
} {
  const { rows, intent } = extractDraft(raw);
  const { grid, repairs, repairedRows } = normalize(
    rows ?? [],
    size.w,
    size.h,
    palette.colors.length,
  );
  return { grid, rows, intent, repairs, repairedRows };
}

// ---------------------------------------------------------------------------
// defect description — spec §6.3, "the retry prompt distinguishes defect kinds"
// ---------------------------------------------------------------------------

/** Every defect of one row, worded by kind. At most one line per kind. */
function describeRow(row: string, y: number, size: Size, palette: Palette): string[] {
  const lines: string[] = [];
  if (row.length !== size.w) {
    lines.push(`row ${y} had ${row.length} characters, expected ${size.w}`);
  }

  const paletteSize = palette.colors.length;
  let badChar: string | undefined;
  let offPalette: number | undefined;
  for (const ch of row) {
    if (ch === TRANSPARENT) continue;
    const index = charIndex(ch);
    if (index < 0) {
      badChar ??= ch;
    } else if (index >= paletteSize) {
      offPalette ??= index;
    }
  }

  if (badChar !== undefined) {
    lines.push(
      /^[A-F]$/.test(badChar)
        ? `row ${y} used '${badChar}' — hex digits must be lowercase, so write '${badChar.toLowerCase()}'`
        : `row ${y} used the character '${badChar}', which is neither '.' nor a hex digit`,
    );
  }
  if (offPalette !== undefined) {
    lines.push(
      `row ${y} used index ${offPalette}, but palette '${palette.id}' has ${paletteSize} ` +
        `colours — valid characters are '.' and 0-${indexChar(paletteSize - 1)}`,
    );
  }
  return lines;
}

/** The op-era defects: nothing landed on the canvas, or nothing was valid. */
function describeOps(raw: string, entries: unknown[], size: Size, palette: Palette): string[] {
  const parsed = parseOps(raw, palette.colors.length);
  const lines: string[] = [];

  if (entries.length === 0) {
    lines.push('your "ops" array was empty — one whole sprite is 8 to 16 operations');
  } else if (parsed.ops.length === 0) {
    lines.push(
      `none of your ${entries.length} entries was a valid operation — each one must be ` +
        'one of {"op":"ellipse"|"fill_rect"|"line"|"mirror_x"|"clear", ...}',
    );
  } else {
    lines.push(
      `your ${parsed.ops.length} operations drew nothing inside the canvas — every ` +
        `coordinate must land within x 0-${size.w - 1} and y 0-${size.h - 1}`,
    );
  }

  if (parsed.dropped > 0) {
    lines.push(
      `${parsed.dropped} of your entries were discarded — an operation needs every field ` +
        `its kind lists, and "index" must be '.' or 0-${indexChar(palette.colors.length - 1)}`,
    );
  }
  return lines;
}

/**
 * The rejected draft's defects, named by kind — spec §6.3.
 *
 * "row 4 used index 9, but palette 'gameboy' has 4 colours" is a different
 * instruction from "row 4 had 12 characters, expected 16", and `repairedRows`
 * alone cannot tell the model which mistake it made. That is the entire reason
 * this function exists rather than the retry prompt quoting `repairedRows`.
 *
 * Under A10 the first branch is the live one: a rejected draft is one whose
 * operations painted nothing. The row branches stay reachable for a whole-canvas
 * reply — see `parseDraft`.
 */
export function describeDefects(raw: string, size: Size, palette: Palette): string[] {
  const { ops, rows } = extractDraft(raw);
  if (ops !== null) return describeOps(raw, ops, size, palette);

  if (rows === null) {
    return [
      'your reply contained no JSON object with an "ops" array — reply with the JSON ' +
        "object only, no prose and no code fence",
    ];
  }

  const lines: string[] = [];
  if (rows.length !== size.h) {
    lines.push(`you returned ${rows.length} rows, expected exactly ${size.h}`);
  }

  let hidden = 0;
  for (let y = 0; y < Math.min(rows.length, size.h); y++) {
    for (const line of describeRow(rows[y], y, size, palette)) {
      if (lines.length < MAX_DEFECT_LINES) lines.push(line);
      else hidden++;
    }
  }
  if (hidden > 0) lines.push(`(and ${hidden} more defects of the same kinds)`);
  return lines;
}

// ---------------------------------------------------------------------------
// the stage
// ---------------------------------------------------------------------------

/**
 * The per-call deadline — spec §6.8, amendment A12.
 *
 * `max(callTimeoutFloorMs, callTimeoutMs × area / 32²)`. **The floor is the
 * amendment.** Pure area scaling gave a 16×16 `120000 × 256/1024 = 30 s`, which
 * a revise turn exceeds, so every 16×16 run ended `FAILED` after round 1 — the
 * app's first real generation. Cold-loading a 6-19 GB model costs 8-25 s
 * whatever is being drawn, and on the smallest canvas that was most of the
 * budget.
 *
 * Under A10 the draft's own cost no longer scales with area — a 64×64 is about
 * as many ops as a 16×16 — so the area term now only keeps the larger canvas
 * from being *tighter* than the smaller one. Re-derive both numbers from
 * `Round.timings` once the bench has data.
 */
export function draftTimeoutMs(cfg: HarnessConfig, size: Size): number {
  return Math.max(
    cfg.callTimeoutFloorMs,
    Math.round((cfg.callTimeoutMs * size.w * size.h) / BASE_AREA),
  );
}

/**
 * The first `SpriteDoc` of a session — spec §6.2, §7.5.
 *
 * `round: 1` (the draft *is* round 1) and `parentId: null` (it derives from
 * nothing) are the only two `meta` values this stage may decide; every later
 * document is assembled by the pipeline.
 *
 * The declared type is what keeps `colors: [...palette.colors]` honest — the
 * library's arrays are frozen singletons handed to every consumer, and the
 * `readonly` on `Palette.colors` makes aliasing one a compile error here.
 */
function buildDoc(
  input: { prompt: string; size: Size; paletteId: string },
  palette: Palette,
  composed: Composed,
  cfg: HarnessConfig,
): SpriteDoc {
  const intent: Intent =
    composed.intent.subject.trim().length > 0
      ? composed.intent
      : { ...composed.intent, subject: input.prompt };

  const doc: SpriteDoc = {
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    prompt: input.prompt,
    intent,
    size: input.size,
    palette: { id: palette.id, colors: [...palette.colors] },
    rows: composed.grid,
    meta: {
      generatorModel: cfg.models.generator,
      criticModel: cfg.models.critic,
      round: 1,
      repairs: composed.repairs,
      // Not optional in practice: the schema defaults it to `[]`, so a document
      // that omits it parses clean while claiming nothing was repaired, and
      // §6.5's `row-repaired` warning then never fires again.
      repairedRows: composed.repairedRows,
      parentId: null,
    },
  };

  // Validating our own output is cheap and closes the one gap the DSL cannot:
  // every write went through `setPixel`, so an off-palette character is already
  // impossible — and this parse is what says so if that ever stops being true.
  return SpriteDocSchema.parse(doc);
}

/**
 * `GenerateRequest` with `format` widened to the JSON Schema object A10 sends.
 *
 * Ollama's `format` accepts the string `"json"` **or** a whole JSON Schema, and
 * `generateBody` forwards the field verbatim — the wire is already correct.
 * `GenerateRequest.format` is typed `string` because Wave 5 predates A10 and
 * `"json"` was the only value anyone passed. Widening the field belongs in
 * `main/ollama.ts`, which this wave's whitelist does not open, so the widening
 * lives at this one boundary instead: `OllamaClient` remains assignable to
 * `DraftClient` (methods are bivariant), so every existing caller and the Wave 5
 * stub satisfy it unchanged.
 */
type SchemaFormatRequest = Omit<GenerateRequest, "format"> & {
  format?: string | Record<string, unknown>;
};

export interface DraftClient extends Omit<OllamaClient, "generate"> {
  generate(req: SchemaFormatRequest): Promise<string>;
}

export interface DraftDeps {
  client: DraftClient;
  /**
   * Fired once per **rejected** attempt, with the record §6.7 stores in
   * `SessionHistory.draftFailures` — spec amendment A9.
   *
   * `DraftRejectedError` carries only the last attempt, so attempt 1's raw
   * output was unrecoverable. Two rejections with the same defect mean the
   * prompt is wrong; two with different defects mean the model is unstable —
   * keeping only the second makes those indistinguishable, which is the whole
   * diagnostic purpose of the field.
   *
   * Optional, so Wave 6's callers are unaffected.
   */
  onAttempt?: (failure: DraftFailure) => void;
}

/**
 * The sentence `SessionHistory.draftFailures[].reason` carries.
 *
 * Names the ratio *and* both of its terms: `repairs` is unbounded (amendment
 * A5), so "525%" is a real reading and a lone percentage would look like a bug.
 */
function rejectionReason(repairs: number, cells: number, threshold: number): string {
  const pct = ((repairs / cells) * 100).toFixed(1);
  return (
    `${repairs} repaired cells of ${cells} (${pct}%) exceeded ` +
    `repairRejectThreshold ${threshold}`
  );
}

/** What one attempt's gauge loop produced — spec §6.2b. */
interface Composed {
  grid: Grid;
  intent: Intent;
  repairs: number;
  repairedRows: number[];
  /** The last reply, which `onAttempt` and `DraftRejectedError` carry. */
  raw: string;
  /** Every operation applied, in order — the legible artifact §6.2a argues for. */
  ops: DrawOp[];
  /** How many model calls this attempt spent. One, when batch 1 cleared the bar. */
  batches: number;
  reading: Gauge;
}

/**
 * One attempt: the A11 gauge loop — spec §6.2b.
 *
 * Emits a batch, renders it, measures the canvas, and shows the model both. It
 * stops at the **first** batch that clears `draftGaugeBar`, so a good first
 * batch costs one inference; only a weak draft pays for more. It also stops on
 * an empty `ops` array, because a batch that adds no operation cannot add one
 * next time either, and spinning through the remaining budget would cost four
 * more inferences to reach the same canvas.
 */
async function composeAttempt(
  deps: DraftDeps,
  input: { prompt: string; size: Size; paletteId: string },
  palette: Palette,
  cfg: HarnessConfig,
  defects: string[] | null,
): Promise<Composed> {
  const { size } = input;
  const paletteSize = palette.colors.length;
  const timeoutMs = draftTimeoutMs(cfg, size);
  const format = buildDraftFormat(palette);

  let grid = makeEmpty(size.w, size.h);
  let reading = gauge(grid);
  let intent: Intent = { subject: "" };
  let raw = "";
  let repairs = 0;
  let repairedRows: number[] = [];
  const ops: DrawOp[] = [];
  let batches = 0;

  for (let batch = 1; batch <= cfg.maxDraftBatches; batch++) {
    const prompt =
      batch > 1
        ? buildGaugePrompt({
            prompt: input.prompt,
            size,
            palette,
            canvas: grid,
            reading,
            batch,
            of: cfg.maxDraftBatches,
          })
        : defects === null
          ? buildDraftPrompt({ prompt: input.prompt, size, palette })
          : buildRetryPrompt({ prompt: input.prompt, size, palette, defects });

    raw = await deps.client.generate({
      model: cfg.models.generator,
      system: prompt.system,
      prompt: prompt.user,
      // A10: a JSON Schema, not `format: "json"`. Grammar-constrained decoding
      // is what made row width unrepresentable; the same applies to op shape.
      format,
      // Spec A8. Measured 26-50× fewer generated tokens; the `/no_think` prefix
      // v2 specified was inert, so this is a request field and not prompt text.
      think: false,
      // A fresh deadline per batch — each is its own call, not a continuation.
      signal: AbortSignal.timeout(timeoutMs),
    });
    batches++;

    const parsed = parseOps(raw, paletteSize);
    if (intent.subject.length === 0) intent = parsed.intent;

    if (parsed.ops.length === 0) {
      // No operation to apply. Either the model said it was finished (§6.2b's
      // empty `ops`), or it answered with a whole canvas, or it answered with
      // nothing at all. None of those is forward progress, so the loop ends —
      // and the whole-canvas case is the one place `normalize` is still reached
      // from this stage.
      const legacy = parseDraft(raw, size, palette);
      if (legacy.rows !== null) {
        grid = legacy.grid;
        repairs = legacy.repairs;
        repairedRows = legacy.repairedRows;
        if (intent.subject.length === 0) intent = legacy.intent;
      }
      reading = gauge(grid);
      break;
    }

    for (const op of parsed.ops) grid = applyOp(grid, op, paletteSize);
    ops.push(...parsed.ops);
    reading = gauge(grid);

    // A11's whole point: the harness stops, and it stops as soon as it can.
    if (clearsGaugeBar(reading, cfg.draftGaugeBar)) break;
  }

  // §6.3's last table row, in DSL terms. A draft that painted nothing is the
  // same failure as no parseable output — every cell of the canvas was lost —
  // and charging it that way is what keeps `repairRejectThreshold`,
  // `onAttempt` and `DraftRejectedError` meaning the same thing on both paths.
  if (reading.coverage === 0) {
    repairs = Math.max(repairs, size.w * size.h);
    repairedRows = Array.from({ length: size.h }, (_, y) => y);
  }

  return { grid, intent, repairs, repairedRows, raw, ops, batches, reading };
}

/**
 * Draft a sprite — spec §6.2a, §6.2b, §6.3.
 *
 * At most `maxDraftRetries + 1` attempts, each of them an A11 gauge loop of at
 * most `maxDraftBatches` calls. An attempt that painted nothing is retried with
 * its defects named; a second such attempt raises `DraftRejectedError`. A
 * transport failure — `OllamaUnreachableError`, `OllamaTimeoutError` —
 * propagates immediately and does **not** consume the retry budget: §7.1 draws
 * those as `DRAFTING → FAILED`, a different edge from `DRAFTING → DRAFTING`, and
 * re-asking an unreachable server only doubles the wait before the status bar
 * names the endpoint.
 */
export async function draft(
  deps: DraftDeps,
  input: { prompt: string; size: Size; paletteId: string },
  cfg: HarnessConfig,
): Promise<SpriteDoc> {
  // Throws on an unknown id, before the model is called — spec §6.1a.
  const palette = getPalette(input.paletteId);
  const cells = input.size.w * input.size.h;
  const attempts = cfg.maxDraftRetries + 1;

  let raw = "";
  let repairs = 0;
  let defects: string[] | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const composed = await composeAttempt(deps, input, palette, cfg, defects);
    raw = composed.raw;
    repairs = composed.repairs;

    // §6.3: reject when the ratio *exceeds* the threshold. `repairs` may exceed
    // `cells` — amendment A5 — so nothing here may clamp, and the comparison is
    // strict so a draft exactly at the threshold is kept.
    if (repairs / cells <= cfg.repairRejectThreshold) {
      return buildDoc(input, palette, composed, cfg);
    }

    // A9. Reported here rather than from the thrown error, because the error can
    // only carry one attempt and this loop is the only place every attempt's raw
    // output exists.
    deps.onAttempt?.({
      attempt,
      raw,
      repairs,
      reason: rejectionReason(repairs, cells, cfg.repairRejectThreshold),
    });
    defects = describeDefects(raw, input.size, palette);
  }

  throw new DraftRejectedError(repairs, raw);
}
