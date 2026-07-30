/**
 * The draft stage's prompt text — spec §7.4, §6.2a (A10), §6.2b (A11).
 *
 * Separated from `main/draft.ts` because prompt wording and interpreter logic
 * change for entirely different reasons: the parser moves when the contract
 * moves, the prompt moves when a model turns out to misread it.
 *
 * **Amendment A10 replaced what this prompt asks for.** It used to ask for
 * `size.h` rows of `size.w` characters, and the generator benchmark
 * (`captures/2026-07-30-generator-capability-benchmark.txt`) proved no local
 * model can supply that: `qwen3:8b` returns a solid rectangle even at 8×8 in
 * plain text. It now asks for 8-20 shape operations, which the DSL benchmark
 * (`captures/2026-07-30-shape-dsl-benchmark.txt`) showed the same model composes
 * into a recognisable sprite. Five things about the wording are load-bearing:
 *
 * **1. The palette table names the palette actually in use, not the encoding.**
 * `gameboy` has four colours, so `0`-`3` is the whole vocabulary and `9` is a
 * character that cannot mean anything.
 *
 * **2. The `HOW TO BUILD` block is doing real work.** Every benchmark run
 * reached for `mirror_x`, and the margins came out right, only because the
 * prompt asked for them in these words. Direct emission never respected margins.
 *
 * **3. `format` is a JSON Schema, not `format: "json"`** (§6.2a). Grammar-
 * constrained decoding is what made row width unrepresentable in the old path;
 * the same applies to op shape, and here it also makes an off-palette `index`
 * unrepresentable — the enum is built from the palette in use.
 *
 * **4. `think: false` lives on the request, not in this text** (spec A8). The
 * `/no_think` prefix v2 specified was measured inert, so there is deliberately
 * no such prefix here.
 *
 * **5. The gauge prompt shows the canvas *and* its measurements** (§6.2b). The
 * one-shot failure the loop exists to catch is a model that commits to a single
 * fill and never notices it has produced a monochrome mass — it cannot notice
 * without being shown.
 */

import type { Gauge } from "@main/dsl";
import { TRANSPARENT, indexChar } from "@shared/grid";
import type { Palette } from "@shared/palettes";
import { OP_COORD_LIMIT, type DrawOp, type Intent, type Size } from "@shared/schema";

/** What every builder here returns: the two halves `generate` takes (§6.9). */
export interface BuiltPrompt {
  system: string;
  user: string;
}

export interface DraftPromptInput {
  prompt: string;
  size: Size;
  palette: Palette;
}

/**
 * The most operations one batch may carry.
 *
 * The benchmark's whole sprites ran 5-13 ops; 20 leaves headroom for a 64×64
 * without letting a runaway generation spend a batch's entire token budget on
 * one reply. `maxDraftBatches` (§6.8) bounds the number of batches, this bounds
 * their size, and between them the draft's cost is bounded without either being
 * a limit the model can feel in normal use.
 */
export const MAX_OPS_PER_BATCH = 20;

/** A worked example — the exact JSON object the model is asked to imitate. */
export interface DraftExample {
  intent: Intent;
  ops: DrawOp[];
}

/** The canvas `DRAFT_EXAMPLES` are drawn on, stated in the prompt beside them. */
export const EXAMPLE_CANVAS = 16;

/**
 * §7.4's "two short worked examples", as data rather than as prose.
 *
 * Exported so `tests/main/draft.test.ts` can hold them to the rules the prompt
 * states — an example using an index no palette has, or drawing nothing at all,
 * teaches the defect to every draft, and inside a template literal nothing would
 * notice.
 *
 * Both use only indices 0-3, which every bundled palette carries (§6.1a puts the
 * floor at four entries), so neither example can demonstrate an off-palette
 * character to a `gameboy` draft. Both also follow `HOW TO BUILD` in order:
 * mass, then detail, then `mirror_x`, then the small marks.
 */
export const DRAFT_EXAMPLES: readonly DraftExample[] = [
  {
    intent: { subject: "a small tree", style: "chunky outline", facing: "front" },
    ops: [
      { op: "ellipse", cx: 8, cy: 5, rx: 5, ry: 4, index: "1" },
      { op: "fill_rect", x0: 7, y0: 9, x1: 8, y1: 13, index: "2" },
      { op: "ellipse", cx: 5, cy: 4, rx: 1, ry: 1, index: "3" },
      { op: "mirror_x", axis: 8 },
      { op: "line", x0: 4, y0: 14, x1: 11, y1: 14, index: "0" },
    ],
  },
  {
    intent: { subject: "a red heart", facing: "front" },
    ops: [
      { op: "ellipse", cx: 5, cy: 5, rx: 3, ry: 3, index: "2" },
      { op: "fill_rect", x0: 3, y0: 6, x1: 8, y1: 8, index: "2" },
      { op: "line", x0: 3, y0: 9, x1: 7, y1: 13, index: "2" },
      { op: "ellipse", cx: 4, cy: 4, rx: 0, ry: 0, index: "3" },
      { op: "mirror_x", axis: 8 },
      { op: "clear", x0: 0, y0: 14, x1: 15, y1: 15 },
    ],
  },
];

// ---------------------------------------------------------------------------
// the palette, twice — spec §7.4
// ---------------------------------------------------------------------------

/** `0 = #0f380f`, one line per entry — §7.4's "palette as an indexed table". */
function paletteTable(palette: Palette): string {
  return palette.colors.map((hex, i) => `  ${indexChar(i)} = ${hex}`).join("\n");
}

/** The same table on one line, for the user half's restatement. */
function paletteInline(palette: Palette): string {
  return palette.colors.map((hex, i) => `${indexChar(i)}=${hex}`).join(", ");
}

/** The highest character this palette can spell — `3` for `gameboy`, `f` for the rest. */
function lastChar(palette: Palette): string {
  return indexChar(palette.colors.length - 1);
}

/**
 * The column `mirror_x` reflects about on this canvas.
 *
 * `w / 2` is the only axis that covers every column exactly once: source `x`
 * lands at `2 * axis - 1 - x`, so on a 16-wide canvas `axis: 8` maps 0 → 15 and
 * 7 → 8. Stated in the prompt as a number rather than as a rule, because the
 * benchmark shows the model copies the example's axis verbatim.
 */
export function mirrorAxis(size: Size): number {
  return Math.floor(size.w / 2);
}

// ---------------------------------------------------------------------------
// the decoder grammar — spec §6.2a
// ---------------------------------------------------------------------------

/**
 * The JSON Schema sent as `format`, built for one palette — spec §6.2a.
 *
 * **Not `format: "json"`.** Ollama compiles a JSON Schema into a decoding
 * grammar, which is what made row width a decoder invariant in the old path
 * (capture §3); the same move makes op shape one here. `index` is an enum over
 * the palette actually in use, so `9` on a four-colour ramp is not a defect the
 * repair table has to forgive — it is a token the decoder cannot emit.
 *
 * `intent` is optional: a model that spends its budget on the sprite rather than
 * on restating the subject has done the right thing, and `draft()` falls back to
 * the user's own words.
 */
export function buildDraftFormat(palette: Palette): Record<string, unknown> {
  const coord = { type: "integer", minimum: -OP_COORD_LIMIT, maximum: OP_COORD_LIMIT };
  const radius = { type: "integer", minimum: 0, maximum: OP_COORD_LIMIT };
  const index = {
    type: "string",
    enum: [TRANSPARENT, ...palette.colors.map((_, i) => indexChar(i))],
  };
  const variant = (op: string, props: Record<string, unknown>) => ({
    type: "object",
    properties: { op: { const: op }, ...props },
    required: ["op", ...Object.keys(props)],
    additionalProperties: false,
  });

  return {
    type: "object",
    properties: {
      intent: {
        type: "object",
        properties: { subject: { type: "string" } },
        required: ["subject"],
      },
      ops: {
        type: "array",
        maxItems: MAX_OPS_PER_BATCH,
        items: {
          anyOf: [
            variant("ellipse", { cx: coord, cy: coord, rx: radius, ry: radius, index }),
            variant("fill_rect", { x0: coord, y0: coord, x1: coord, y1: coord, index }),
            variant("line", { x0: coord, y0: coord, x1: coord, y1: coord, index }),
            variant("mirror_x", { axis: coord }),
            variant("clear", { x0: coord, y0: coord, x1: coord, y1: coord }),
          ],
        },
      },
    },
    required: ["ops"],
  };
}

// ---------------------------------------------------------------------------
// the draft prompt — spec §7.4, §6.2a
// ---------------------------------------------------------------------------

/** The op vocabulary, with one worked instance of each — spec §6.2a. */
function operationTable(size: Size): string[] {
  const axis = mirrorAxis(size);
  const mid = Math.floor(size.w / 2);
  return [
    `  {"op":"ellipse","cx":${mid},"cy":${mid},"rx":4,"ry":3,"index":"2"}`,
    "      a filled ellipse centred on (cx,cy). rx/ry of 0 is a single pixel.",
    `  {"op":"fill_rect","x0":5,"y0":9,"x1":10,"y1":13,"index":"2"}`,
    "      a filled rectangle. Both corners are included.",
    `  {"op":"line","x0":3,"y0":2,"x1":6,"y1":5,"index":"0"}`,
    "      a one-pixel line. Both endpoints are included.",
    `  {"op":"mirror_x","axis":${axis}}`,
    `      copies x 0-${axis - 1} onto x ${axis}-${size.w - 1}, reflected. Free symmetry.`,
    `  {"op":"clear","x0":0,"y0":0,"x1":3,"y1":3}`,
    "      erases a rectangle back to transparent. No index — it cannot paint.",
  ];
}

/**
 * The draft prompt — spec §7.4, rewritten for A10.
 *
 * The palette appears twice, in the system half as a table and in the user half
 * as one line. That is deliberate rather than sloppy: the user half is the last
 * thing the model reads before it answers.
 */
export function buildDraftPrompt(input: DraftPromptInput): BuiltPrompt {
  const { size, palette } = input;
  const last = lastChar(palette);
  const count = palette.colors.length;
  const axis = mirrorAxis(size);
  const inner = `x 1-${size.w - 2}, y 1-${size.h - 2}`;

  const system = [
    "You are a pixel-art director. You do not write pixels — you compose the shape",
    "operations an interpreter draws for you. It counts the cells; you decide where",
    "the shapes go.",
    "",
    "CANVAS",
    `The canvas is ${size.w} wide and ${size.h} tall. x runs 0-${size.w - 1} left to right,`,
    `y runs 0-${size.h - 1} top to bottom. Keep everything inside ${inner} so the`,
    "sprite has a margin.",
    "",
    `PALETTE — ${palette.id}, ${count} colours. "index" is ONE character: '.' or 0-${last}.`,
    paletteTable(palette),
    `'.' is transparent and erases. An index above ${last} does not exist in this palette.`,
    "Lowercase only: 'A'-'F' are rejected, not corrected.",
    "",
    "OPERATIONS — drawn in the order you list them; later ones paint over earlier ones.",
    ...operationTable(size),
    "",
    "HOW TO BUILD",
    "1. Block in the largest mass first — the body — as one ellipse or fill_rect.",
    "2. Add the head, then the limbs, as further ellipses and rectangles.",
    `3. Draw the LEFT half of anything symmetric, then {"op":"mirror_x","axis":${axis}} once.`,
    "4. Outline with the darkest index, then add the small marks: eyes, mouth, feet.",
    "5. Use clear to cut a notch, separate two shapes, or tidy the margin.",
    `Use at least 3 different colours. 8-16 operations is a whole sprite; ${MAX_OPS_PER_BATCH} is the most`,
    "one reply may carry.",
    "",
    "OUTPUT",
    "Reply with one JSON object and nothing else — no prose, no explanation, no markdown fence:",
    '{"intent":{"subject":"..."},"ops":[ ... ]}',
    '"subject" is what you are drawing, in a few words.',
    "",
    `EXAMPLES — these are drawn on a ${EXAMPLE_CANVAS}x${EXAMPLE_CANVAS} canvas; yours is ${size.w}x${size.h},`,
    "so scale the coordinates to fit it.",
    ...DRAFT_EXAMPLES.map((example) => JSON.stringify(example)),
  ].join("\n");

  const user = [
    `Draw: ${input.prompt}`,
    "",
    `Canvas ${size.w}x${size.h} — x and y both 0-${size.w - 1}. Keep the sprite inside ${inner}.`,
    `Palette ${palette.id} (${count} colours): ${paletteInline(palette)}. Valid "index": '.' and 0-${last}.`,
    `Compose the shape operations. Draw the left half, then mirror_x about axis ${axis}.`,
    'Reply with the JSON object only: {"intent":{"subject":"..."},"ops":[...]}',
  ].join("\n");

  return { system, user };
}

// ---------------------------------------------------------------------------
// the gauge prompt — spec §6.2b
// ---------------------------------------------------------------------------

export interface GaugePromptInput extends DraftPromptInput {
  /** The canvas as drawn so far — the model's own operations, rendered. */
  canvas: readonly string[];
  reading: Gauge;
  /** 1-based, and `of` is `maxDraftBatches` — the model is told what it has left. */
  batch: number;
  of: number;
}

/** The measurements, worded with the target beside each figure — spec §6.2b. */
function measurements(reading: Gauge, size: Size): string[] {
  const bbox =
    reading.bbox === null
      ? "- nothing is drawn yet"
      : `- bounding box x ${reading.bbox[0]}-${reading.bbox[2]}, y ${reading.bbox[1]}-${reading.bbox[3]}` +
        ` on a ${size.w}x${size.h} canvas`;
  return [
    `- coverage ${reading.coverage.toFixed(2)} of the canvas (aim for 0.12 to 0.80)`,
    `- ${reading.colours} colours used (use at least 3)`,
    `- ${reading.distinctRows} distinct rows of ${size.h} (aim for at least 8 — a flat mass has few)`,
    bbox,
  ];
}

/**
 * The prompt for batch 2 and later — spec §6.2b, amendment A11.
 *
 * The system half is the draft prompt's, unchanged: `generate` is single-shot
 * and carries no conversation, so a follow-up that sent only the canvas would be
 * asking a model with no memory to continue a sprite whose rules it cannot see.
 *
 * The canvas is shown as text and the measurements beside it. The measurements
 * are the point: the failure this loop exists to catch is a model that fills once
 * and never notices it has produced a monochrome mass, and "1 colour used (use at
 * least 3)" is the sentence that catches it.
 *
 * "Do not redraw what is already right" is load-bearing too — the ops are applied
 * **on top of** this canvas, and a model that restarted would undo its own work.
 */
export function buildGaugePrompt(input: GaugePromptInput): BuiltPrompt {
  const base = buildDraftPrompt(input);
  const { size, palette, reading } = input;

  const user = [
    base.user,
    "",
    `THE CANVAS SO FAR — batch ${input.batch} of ${input.of}. Your operations are applied ON TOP of it.`,
    ...input.canvas,
    "",
    "MEASUREMENTS",
    ...measurements(reading, size),
    "",
    "Add the operations that close the gap. Do not redraw what is already right —",
    "everything above is already on the canvas.",
    reading.colours < 3
      ? `Add shading and an outline in indices you have not used yet (0-${lastChar(palette)}).`
      : "Refine the silhouette and the small marks: eyes, outline, feet.",
    'Reply with the JSON object only: {"ops":[...]}',
  ].join("\n");

  return { system: base.system, user };
}

// ---------------------------------------------------------------------------
// the retry prompt — spec §6.3
// ---------------------------------------------------------------------------

export interface RetryPromptInput extends DraftPromptInput {
  /** Defect lines from `describeDefects` — named by kind, per spec §6.3. */
  defects: string[];
}

/**
 * The retry prompt — spec §6.3's "the specific defects named back to the model".
 *
 * The whole draft prompt again, plus the defect list, for the same reason
 * `buildGaugePrompt` restates the system half: `generate` carries no
 * conversation.
 *
 * Under A10 a retry no longer follows a *malformed* draft — width and op shape
 * are decoder invariants now — but it still follows an *empty* one, which is the
 * failure `describeDefects` words for the model.
 */
export function buildRetryPrompt(input: RetryPromptInput): BuiltPrompt {
  const base = buildDraftPrompt(input);
  const defects =
    input.defects.length > 0
      ? input.defects.map((line) => `- ${line}`).join("\n")
      : "- the operations you sent drew nothing on the canvas";

  const user = [
    base.user,
    "",
    "YOUR PREVIOUS REPLY WAS REJECTED. It did not produce a usable sprite.",
    "Defects found:",
    defects,
    "",
    "Compose the whole sprite again. Same canvas, same palette, same rules.",
  ].join("\n");

  return { system: base.system, user };
}
