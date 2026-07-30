/**
 * The draft stage — prompt → generator → repaired `SpriteDoc`. Spec §6.2, §6.3,
 * §7.4, §7.5; plan Wave 6.
 *
 * `qwen3:8b` emits malformed rows routinely, not occasionally (§6.3), so almost
 * everything here is about turning expected sloppiness into either a valid
 * document or a rejection that says why. Five properties carry that weight:
 *
 * **1. `parseDraft` never throws.** Whatever arrives — prose, a fenced block, a
 * half-written object, an empty string — it produces a `w`×`h` grid and a repair
 * count. Unparseable output degrades to `rows: []`, which `normalize` charges as
 * `w × h` repairs and which therefore routes into the ordinary retry path. v1
 * left this undefined and a prose-only reply escaped the state machine as an
 * unhandled rejection.
 *
 * **2. The threshold is an unbounded ratio** (§6.3, amendment A5). `repairs` is
 * not a percentage and is not bounded by 1: 100 rows on a 16×16 canvas charges
 * `(100 − 16) × 16 = 1344` against 256 cells — 525% — even when every surviving
 * row is pristine. Clamping the ratio would make that draft indistinguishable
 * from one that merely lost every cell.
 *
 * **3. `normalize` is called with the palette's length** (§6.3, amendment A4).
 * An index past the end of a 4-colour ramp is repaired to `.` and charged like
 * any other invalid character. Dropping that argument would leave a `9` in a
 * `gameboy` document, which `SpriteDocSchema` refuses and the renderer cannot
 * colour.
 *
 * **4. Both halves of the repair record reach `meta`.** `repairedRows` is the
 * only source for §6.5's `row-repaired` warning — once the grid exists, a
 * repaired row is indistinguishable from one the model got right — and it has a
 * `[]` default on the schema, so omitting it produces a document that parses
 * clean while claiming nothing was repaired.
 *
 * **5. Every call sends `think: false`** (amendment A8) and carries an
 * `AbortSignal` armed with the area-scaled `callTimeoutMs` (§6.8). A 64×64 draft
 * is four thousand grid characters; a flat 120 s would abort legitimate work.
 *
 * `draft()` produces the first document and only the first: §7.5 gives `meta`
 * ownership to the pipeline, and every later round is assembled there from the
 * `Grid` that `revise()` returns.
 */

import { randomUUID } from "node:crypto";

import type { OllamaClient } from "@main/ollama";
import { buildDraftPrompt, buildRetryPrompt } from "@main/prompts/draft";
import { TRANSPARENT, charIndex, indexChar, normalize, type Grid } from "@shared/grid";
import { getPalette, type Palette } from "@shared/palettes";
import {
  SpriteDocSchema,
  type DraftFailure,
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
 * sprite. The lines that survive are the earliest rows, which is where a model
 * that lost the format usually lost it.
 */
const MAX_DEFECT_LINES = 12;

/**
 * A draft rejected twice over `repairRejectThreshold` — spec §6.3.
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
// parsing — spec §6.3
// ---------------------------------------------------------------------------

/**
 * What the model actually sent, before repair.
 *
 * `rows: null` is "no parseable output at all" — §6.3's last table row — and is
 * deliberately distinct from `rows: []`. Both charge `w × h` repairs, but only
 * the first can tell the retry prompt that the reply was not JSON.
 */
interface ExtractedDraft {
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

/** `{ intent, rows }`, a bare rows array, or nothing at all. */
function extractDraft(raw: string): ExtractedDraft {
  const parsed = parseJsonish(raw);
  if (parsed === undefined) return { rows: null, intent: { subject: "" } };

  const { value } = parsed;
  // A model that answers with the rows alone has still answered.
  if (Array.isArray(value)) return { rows: toRows(value), intent: { subject: "" } };

  const record = value as Record<string, unknown>;
  return {
    rows: Array.isArray(record.rows) ? toRows(record.rows) : null,
    intent: readIntent(record.intent),
  };
}

/**
 * Model output → a repaired grid, an intent, and the repair record — spec §6.3.
 *
 * **Never throws.** The signature takes no prompt, so an intent the model did
 * not send comes back with an empty `subject`; `draft()` substitutes the user's
 * own prompt when it builds the document.
 */
export function parseDraft(
  raw: string,
  size: Size,
  palette: Palette,
): { grid: Grid; intent: Intent; repairs: number; repairedRows: number[] } {
  const { rows, intent } = extractDraft(raw);
  const { grid, repairs, repairedRows } = normalize(
    rows ?? [],
    size.w,
    size.h,
    palette.colors.length,
  );
  return { grid, intent, repairs, repairedRows };
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

/**
 * The rejected draft's defects, named by kind — spec §6.3.
 *
 * "row 4 used index 9, but palette 'gameboy' has 4 colours" is a different
 * instruction from "row 4 had 12 characters, expected 16", and `repairedRows`
 * alone cannot tell the model which mistake it made. That is the entire reason
 * this function exists rather than the retry prompt quoting `repairedRows`.
 *
 * Rows the model never sent are covered by the row-count line and not described
 * individually: thirteen copies of "expected 16 characters" for rows that do not
 * exist is noise that pushes the real defect out of the prompt.
 */
export function describeDefects(raw: string, size: Size, palette: Palette): string[] {
  const { rows } = extractDraft(raw);
  if (rows === null) {
    return [
      'your reply contained no JSON object with a "rows" array — reply with the JSON ' +
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
 * `callTimeoutMs` scaled by canvas area — spec §6.8.
 *
 * A 64×64 draft is four times the grid characters of the 32×32 the default was
 * quoted against, and a 16×16 a quarter of them. Rounded, and floored at 1ms so
 * an aggressive config cannot produce a zero-length deadline.
 */
function scaledTimeoutMs(callTimeoutMs: number, size: Size): number {
  return Math.max(1, Math.round((callTimeoutMs * size.w * size.h) / BASE_AREA));
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
  parsed: ReturnType<typeof parseDraft>,
  cfg: HarnessConfig,
): SpriteDoc {
  const intent: Intent =
    parsed.intent.subject.trim().length > 0
      ? parsed.intent
      : { ...parsed.intent, subject: input.prompt };

  const doc: SpriteDoc = {
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    prompt: input.prompt,
    intent,
    size: input.size,
    palette: { id: palette.id, colors: [...palette.colors] },
    rows: parsed.grid,
    meta: {
      generatorModel: cfg.models.generator,
      criticModel: cfg.models.critic,
      round: 1,
      repairs: parsed.repairs,
      // Not optional in practice: the schema defaults it to `[]`, so a document
      // that omits it parses clean while claiming nothing was repaired, and
      // §6.5's `row-repaired` warning then never fires again.
      repairedRows: parsed.repairedRows,
      parentId: null,
    },
  };

  // Validating our own output is cheap and closes the one gap the repair path
  // cannot: if `normalize` were ever called without the palette length, an
  // off-palette character would reach here and this parse is what says so.
  return SpriteDocSchema.parse(doc);
}

export interface DraftDeps {
  client: OllamaClient;
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
   * It fires on a rejected attempt regardless of what happens next, so a run
   * whose retry succeeded still records the attempt that did not: "how often
   * does the retry save the run" is a question only that record can answer.
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

/**
 * Draft a sprite — spec §6.3's retry loop.
 *
 * At most `maxDraftRetries + 1` calls. A draft over the threshold is retried
 * with its defects named by kind; a second rejection raises
 * `DraftRejectedError`. A transport failure — `OllamaUnreachableError`,
 * `OllamaTimeoutError` — propagates immediately and does **not** consume the
 * retry budget: §7.1 draws those as `DRAFTING → FAILED`, a different edge from
 * `DRAFTING → DRAFTING` on repairs, and re-asking an unreachable server only
 * doubles the wait before the status bar names the endpoint.
 */
export async function draft(
  deps: DraftDeps,
  input: { prompt: string; size: Size; paletteId: string },
  cfg: HarnessConfig,
): Promise<SpriteDoc> {
  // Throws on an unknown id, before the model is called — spec §6.1a.
  const palette = getPalette(input.paletteId);
  const cells = input.size.w * input.size.h;
  const timeoutMs = scaledTimeoutMs(cfg.callTimeoutMs, input.size);
  const attempts = cfg.maxDraftRetries + 1;

  let raw = "";
  let repairs = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const prompt =
      attempt === 1
        ? buildDraftPrompt({ prompt: input.prompt, size: input.size, palette })
        : buildRetryPrompt({
            prompt: input.prompt,
            size: input.size,
            palette,
            defects: describeDefects(raw, input.size, palette),
          });

    raw = await deps.client.generate({
      model: cfg.models.generator,
      system: prompt.system,
      prompt: prompt.user,
      // Spec A8. Measured 26-50× fewer generated tokens; the `/no_think` prefix
      // v2 specified was inert, so this is a request field and not prompt text.
      think: false,
      // A fresh deadline per attempt — the retry is a new call, not a
      // continuation of the one that was rejected.
      signal: AbortSignal.timeout(timeoutMs),
    });

    const parsed = parseDraft(raw, input.size, palette);
    repairs = parsed.repairs;

    // §6.3: reject when the ratio *exceeds* the threshold. `repairs` may exceed
    // `cells` — see amendment A5 in the module header — so nothing here may
    // clamp, and the comparison is strict so a draft exactly at the threshold
    // is kept.
    if (repairs / cells <= cfg.repairRejectThreshold) {
      return buildDoc(input, palette, parsed, cfg);
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
  }

  throw new DraftRejectedError(repairs, raw);
}
