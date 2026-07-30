/**
 * The draft stage — spec §6.2a (A10), §6.2b (A11), §6.3, §6.8 (A12), §7.4.
 *
 * Rewritten for Wave 6b. The stage this file used to test asked the model for
 * `size.h` rows of `size.w` characters; the app's first real generation returned
 * a six-wide vertical bar, and the benchmarks
 * (`captures/2026-07-30-generator-capability-benchmark.txt`,
 * `captures/2026-07-30-shape-dsl-benchmark.txt`) showed that is not a prompt
 * problem — no local 8B model can do 256 cells of blind bookkeeping, and the
 * same model composes a recognisable sprite from thirteen shape operations.
 *
 * Five behaviours are pinned because their breakage is *invisible* at the call
 * site:
 *
 * - **The loop stops on the first batch that clears the bar** (A11). A loop that
 *   always runs five batches produces the same sprite five times more slowly,
 *   and the benchmark measured five batches making a good sprite *worse*.
 * - **An empty `ops` array stops the loop** rather than spinning through the
 *   remaining budget to reach the identical canvas.
 * - **`callTimeoutMs` respects `callTimeoutFloorMs`** (A12). Pure area scaling
 *   gave a 16×16 thirty seconds and failed every 16×16 run after round 1.
 * - **`format` is a JSON Schema, not `"json"`** (A10). Asserted on the stub's
 *   recorded call, because the prompt text cannot tell the two apart.
 * - **`think: false`** is likewise asserted on the recorded call. The
 *   `/no_think` prefix v2 specified was measured inert (A8).
 *
 * Every test here runs against a scripted stub or a hand-rolled client; the file
 * is green with Ollama stopped.
 */

import { describe, expect, it } from "vitest";

import {
  DraftRejectedError,
  buildDraftPrompt,
  describeDefects,
  draft,
  draftTimeoutMs,
  parseDraft,
  parseOps,
} from "@main/draft";
import { clearsGaugeBar, gauge, renderOps } from "@main/dsl";
import { OllamaUnreachableError, type GenerateRequest, type OllamaClient } from "@main/ollama";
import {
  DRAFT_EXAMPLES,
  EXAMPLE_CANVAS,
  MAX_OPS_PER_BATCH,
  buildDraftFormat,
  buildGaugePrompt,
  mirrorAxis,
} from "@main/prompts/draft";
import { makeEmpty } from "@shared/grid";
import { getPalette } from "@shared/palettes";
import {
  DraftFailureSchema,
  DrawOpSchema,
  HarnessConfigSchema,
  SpriteDocSchema,
  type DraftFailure,
  type DrawOp,
  type HarnessConfig,
  type Size,
} from "@shared/schema";

import { createStubClient } from "../stubs/ollama";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const SIZE_16: Size = { w: 16, h: 16 };
const SIZE_32: Size = { w: 32, h: 32 };
const SIZE_64: Size = { w: 64, h: 64 };

const GAMEBOY = getPalette("gameboy");
const PICO_8 = getPalette("pico-8");

/** Every §6.8 default, then the overrides a test actually cares about. */
function cfg(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return HarnessConfigSchema.parse(overrides);
}

const INPUT_16 = { prompt: "a sitting red fox", size: SIZE_16, paletteId: "gameboy" };

/**
 * An op batch that clears the default gauge bar on a 16×16 four-colour canvas.
 *
 * Eight operations: a mass, a body, an ear, an eye, `mirror_x`, a margin tidy and
 * two feet — the same shape as the run recorded in the DSL benchmark. Asserted to
 * clear the bar below, so a test that expects one model call is testing the loop
 * rather than the fixture.
 */
const GOOD_OPS: DrawOp[] = [
  { op: "ellipse", cx: 8, cy: 5, rx: 4, ry: 3, index: "2" },
  { op: "fill_rect", x0: 5, y0: 8, x1: 10, y1: 12, index: "2" },
  { op: "line", x0: 3, y0: 1, x1: 6, y1: 4, index: "0" },
  { op: "ellipse", cx: 6, cy: 5, rx: 0, ry: 0, index: "3" },
  { op: "mirror_x", axis: 8 },
  { op: "clear", x0: 0, y0: 14, x1: 15, y1: 15 },
  { op: "line", x0: 6, y0: 13, x1: 6, y1: 13, index: "1" },
  { op: "line", x0: 9, y0: 13, x1: 9, y1: 13, index: "1" },
];

/** One monochrome block: coverage 0.06, one colour, two distinct rows. */
const WEAK_OPS: DrawOp[] = [{ op: "fill_rect", x0: 6, y0: 6, x1: 9, y1: 9, index: "1" }];

/** The row `WEAK_OPS` paints, which the gauge prompt has to show back. */
const WEAK_ROW = "......1111......";

/** The model's reply as `generate` hands it back — a JSON object, no fence. */
function opsReply(ops: DrawOp[], intent?: unknown): string {
  return JSON.stringify(intent === undefined ? { ops } : { intent, ops });
}

/** The grid `ops` render to on a 16×16 four-colour canvas. */
function render16(ops: DrawOp[]): string[] {
  return renderOps(ops, SIZE_16, GAMEBOY.colors.length);
}

/**
 * A well-formed whole-canvas answer using only indices 0-3.
 *
 * The compatibility branch — see `parseDraft` — not the path the prompt asks
 * for. §6.3's repair arithmetic is only reachable through it, so it is what the
 * threshold tests below are written against.
 */
function cleanRows(size: Size): string[] {
  return Array.from({ length: size.h }, (_, y) =>
    Array.from({ length: size.w }, (_, x) =>
      x === 0 || y === 0 || x === size.w - 1 || y === size.h - 1 ? "." : String((x + y) % 4),
    ).join(""),
  );
}

function rowsReply(rows: string[], intent?: unknown): string {
  return JSON.stringify(intent === undefined ? { rows } : { intent, rows });
}

/** `rows` with the named rows shortened by `drop` characters. */
function shorten(rows: string[], indices: number[], drop: number): string[] {
  return rows.map((row, y) => (indices.includes(y) ? row.slice(0, row.length - drop) : row));
}

/** `rows` with one character of the named row overwritten. */
function poke(rows: string[], y: number, x: number, ch: string): string[] {
  return rows.map((row, i) => (i === y ? row.slice(0, x) + ch + row.slice(x + 1) : row));
}

const CLEAN_16 = cleanRows(SIZE_16);
const CLEAN_32 = cleanRows(SIZE_32);
const ALL_ROWS_16 = [...Array(16).keys()];

/**
 * Narrows `RecordedCall.format` to the JSON Schema arm A10's draft sends.
 *
 * Wave 6c widened `OllamaFormat` — and with it the stub's recorded field — to
 * `string | Record<string, unknown>`, so this is no longer casting away a wrong
 * type; it is picking one arm of a union that genuinely has two, because
 * `format: "json"` is still what the critic sends on the same field.
 */
function recordedFormat(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * A client that records the `AbortSignal` of each call.
 *
 * `RecordedCall` carries no signal and `tests/stubs/ollama.ts` belongs to Wave 5,
 * so the floored, area-scaled timeout (§6.8, A12) is observed through a local
 * client instead.
 */
function probeClient(answer: (n: number) => string): {
  client: OllamaClient;
  signals: (AbortSignal | undefined)[];
} {
  const signals: (AbortSignal | undefined)[] = [];
  const unscripted = async (): Promise<never> => {
    throw new Error("draft() called a method other than generate()");
  };
  const client: OllamaClient = {
    listModels: unscripted,
    vision: unscripted,
    chatWithTools: unscripted,
    async generate(req: GenerateRequest): Promise<string> {
      signals.push(req.signal);
      return answer(signals.length);
    },
  };
  return { client, signals };
}

/** A client whose call never settles until its own `AbortSignal` fires. */
function hangingClient(): OllamaClient {
  const unscripted = async (): Promise<never> => {
    throw new Error("draft() called a method other than generate()");
  };
  return {
    listModels: unscripted,
    vision: unscripted,
    chatWithTools: unscripted,
    generate(req: GenerateRequest): Promise<string> {
      return new Promise<string>((_resolve, reject) => {
        const signal = req.signal;
        if (signal === undefined) {
          reject(new Error("draft() sent no AbortSignal"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  };
}

const sleep = (ms: number): Promise<"pending"> =>
  new Promise((resolve) => setTimeout(() => resolve("pending"), ms));

// ---------------------------------------------------------------------------
// the fixtures themselves — a loop test is only as good as its batches
// ---------------------------------------------------------------------------

describe("the gauge fixtures", () => {
  it("GOOD_OPS clears the default bar and WEAK_OPS does not", () => {
    const bar = cfg().draftGaugeBar;
    expect(clearsGaugeBar(gauge(render16(GOOD_OPS)), bar)).toBe(true);
    expect(clearsGaugeBar(gauge(render16(WEAK_OPS)), bar)).toBe(false);
  });

  it("WEAK_OPS paints something — a weak draft is not an empty one", () => {
    const reading = gauge(render16(WEAK_OPS));
    expect(reading.coverage).toBeGreaterThan(0);
    expect(reading.colours).toBe(1);
    expect(render16(WEAK_OPS)[6]).toBe(WEAK_ROW);
  });
});

// ---------------------------------------------------------------------------
// buildDraftPrompt — spec §7.4, rewritten for A10
// ---------------------------------------------------------------------------

describe("buildDraftPrompt", () => {
  const built = buildDraftPrompt({ prompt: "a sitting red fox", size: SIZE_16, palette: GAMEBOY });
  const whole = `${built.system}\n${built.user}`;

  it("returns a system and a user half, both non-empty", () => {
    expect(built.system.length).toBeGreaterThan(0);
    expect(built.user.length).toBeGreaterThan(0);
  });

  it("names every palette index beside its hex", () => {
    for (const [i, hex] of GAMEBOY.colors.entries()) {
      expect(whole).toContain(hex);
      expect(whole).toMatch(new RegExp(`${i}[^\\n]*${hex}`));
    }
  });

  it("names every index of a 16-colour palette, including the a-f half", () => {
    const wide = buildDraftPrompt({ prompt: "a chest", size: SIZE_32, palette: PICO_8 });
    const text = `${wide.system}\n${wide.user}`;
    for (const [i, hex] of PICO_8.colors.entries()) {
      expect(text).toMatch(new RegExp(`${"0123456789abcdef"[i]}[^\\n]*${hex}`));
    }
    expect(text).toContain("#ffccaa"); // index f — the entry a 0-9 loop would miss
  });

  it("asks for operations, not rows — the whole of A10", () => {
    expect(whole).toContain('"ops"');
    expect(whole).toContain('"intent"');
    expect(whole).toContain('"subject"');
    // The old contract. A prompt that still mentions rows is a prompt that will
    // get rows, which the benchmark showed this model cannot produce.
    expect(whole).not.toContain('"rows"');
    expect(whole).not.toMatch(/rows of exactly/);
  });

  it("names all five ops with a worked instance of each", () => {
    for (const name of ["ellipse", "fill_rect", "line", "mirror_x", "clear"]) {
      expect(built.system).toContain(`"op":"${name}"`);
    }
  });

  it("carries the HOW TO BUILD block — the lines that produced the margins", () => {
    // §6.2a: every benchmark run reached for `mirror_x`, and margins came out
    // right, only because the prompt asked in these words. Direct emission never
    // respected margins at all.
    expect(built.system).toContain("HOW TO BUILD");
    expect(built.system.toLowerCase()).toContain("largest mass");
    expect(built.system).toContain("mirror_x");
    expect(built.system.toLowerCase()).toContain("at least 3 different colours");
  });

  it("states the canvas dimensions and the inner margin", () => {
    expect(built.system).toContain("16 wide and 16 tall");
    expect(whole).toContain("x 1-14, y 1-14");

    const big = buildDraftPrompt({ prompt: "a tree", size: SIZE_64, palette: PICO_8 });
    expect(big.system).toContain("64 wide and 64 tall");
    expect(`${big.system}\n${big.user}`).toContain("x 1-62, y 1-62");
  });

  it("states the mirror axis as a number, scaled to the canvas", () => {
    // The benchmark shows the model copies the example's axis verbatim, so a
    // 32×32 draft told `axis: 8` mirrors a quarter of its canvas.
    expect(mirrorAxis(SIZE_16)).toBe(8);
    expect(mirrorAxis(SIZE_64)).toBe(32);
    expect(built.system).toContain('{"op":"mirror_x","axis":8}');
    expect(built.system).toContain("copies x 0-7 onto x 8-15");

    const big = buildDraftPrompt({ prompt: "a tree", size: SIZE_64, palette: PICO_8 });
    expect(big.system).toContain('{"op":"mirror_x","axis":32}');
    expect(big.system).toContain("copies x 0-31 onto x 32-63");
  });

  it("bounds the valid index to the palette actually in use", () => {
    // gameboy has four colours, so indices 4 and up cannot be spelled at all.
    expect(whole).toMatch(/0-3/);
    const wide = buildDraftPrompt({ prompt: "a chest", size: SIZE_32, palette: PICO_8 });
    expect(`${wide.system}\n${wide.user}`).toMatch(/0-f/);
  });

  it("requires lowercase — spec §6.1 rejects A-F rather than folding them", () => {
    expect(whole.toLowerCase()).toContain("lowercase");
  });

  it("carries the user's own words into the user half", () => {
    expect(built.user).toContain("a sitting red fox");
  });

  it("states the per-batch op ceiling it is bounded by", () => {
    expect(built.system).toContain(String(MAX_OPS_PER_BATCH));
    expect(MAX_OPS_PER_BATCH).toBeGreaterThanOrEqual(16);
  });

  it("its own worked examples obey the rules it states", () => {
    // §7.4 asks for two short worked examples. A prompt that demonstrates an
    // illegal op — or one that draws nothing — teaches the defect to every
    // draft, so the examples are validated and rendered rather than counted.
    expect(DRAFT_EXAMPLES.length).toBeGreaterThanOrEqual(2);
    for (const example of DRAFT_EXAMPLES) {
      expect(built.system).toContain(JSON.stringify(example));
      expect(example.intent.subject.length).toBeGreaterThan(0);
      for (const op of example.ops) {
        expect(DrawOpSchema.safeParse(op).success).toBe(true);
        // 0-3 is spellable in every bundled palette (§6.1a).
        if ("index" in op) expect(op.index).toMatch(/^[.0-3]$/);
      }
      // And it actually draws: an example whose ops cancel out teaches nothing.
      const drawn = gauge(renderOps(example.ops, SIZE_16, GAMEBOY.colors.length));
      expect(drawn.coverage).toBeGreaterThan(0.05);
      expect(drawn.colours).toBeGreaterThanOrEqual(2);
    }
    // And the canvas they are drawn on is stated, so a 64×64 draft is told to
    // scale rather than copying 16×16 coordinates.
    expect(built.system).toContain(`${EXAMPLE_CANVAS}x${EXAMPLE_CANVAS} canvas`);
  });
});

// ---------------------------------------------------------------------------
// buildDraftFormat — the decoder grammar, spec §6.2a
// ---------------------------------------------------------------------------

describe("buildDraftFormat", () => {
  it("is a JSON Schema for the op array, not the string \"json\"", () => {
    const format = buildDraftFormat(GAMEBOY);
    expect(typeof format).toBe("object");
    expect(format.type).toBe("object");
    const properties = format.properties as Record<string, Record<string, unknown>>;
    expect(properties.ops.type).toBe("array");
    expect(format.required).toEqual(["ops"]);
  });

  it("builds the index enum from the palette, so off-palette is undecodable", () => {
    // The generator benchmark's §3: a schema `format` makes a defect a decoder
    // invariant rather than something the repair table has to forgive.
    const enumOf = (palette: typeof GAMEBOY): unknown => {
      const properties = buildDraftFormat(palette).properties as Record<string, Record<string, unknown>>;
      const items = (properties.ops.items as { anyOf: Record<string, unknown>[] }).anyOf;
      const ellipse = items[0].properties as Record<string, { enum?: unknown }>;
      return ellipse.index.enum;
    };
    expect(enumOf(GAMEBOY)).toEqual([".", "0", "1", "2", "3"]);
    expect(enumOf(PICO_8)).toHaveLength(17); // '.' plus 0-f
  });

  it("offers exactly the five ops, each pinned by a const op name", () => {
    const properties = buildDraftFormat(GAMEBOY).properties as Record<string, Record<string, unknown>>;
    const items = (properties.ops.items as { anyOf: Record<string, unknown>[] }).anyOf;
    const names = items.map(
      (variant) => ((variant.properties as Record<string, { const?: string }>).op.const),
    );
    expect(names).toEqual(["ellipse", "fill_rect", "line", "mirror_x", "clear"]);
    for (const variant of items) expect(variant.additionalProperties).toBe(false);
  });

  it("caps the batch at MAX_OPS_PER_BATCH", () => {
    const properties = buildDraftFormat(GAMEBOY).properties as Record<string, Record<string, unknown>>;
    expect(properties.ops.maxItems).toBe(MAX_OPS_PER_BATCH);
  });

  it("does not force a minimum op count — an empty batch is §6.2b's stop signal", () => {
    const properties = buildDraftFormat(GAMEBOY).properties as Record<string, Record<string, unknown>>;
    expect(properties.ops.minItems).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildGaugePrompt — spec §6.2b
// ---------------------------------------------------------------------------

describe("buildGaugePrompt", () => {
  const canvas = render16(WEAK_OPS);
  const built = buildGaugePrompt({
    prompt: "a sitting red fox",
    size: SIZE_16,
    palette: GAMEBOY,
    canvas,
    reading: gauge(canvas),
    batch: 2,
    of: 5,
  });

  it("keeps the whole system half — `generate` carries no conversation", () => {
    const base = buildDraftPrompt({ prompt: "a sitting red fox", size: SIZE_16, palette: GAMEBOY });
    expect(built.system).toBe(base.system);
  });

  it("shows the canvas as drawn so far", () => {
    for (const row of canvas) expect(built.user).toContain(row);
    expect(built.user).toContain(WEAK_ROW);
  });

  it("shows the measurements beside it, with the target for each", () => {
    expect(built.user).toContain("coverage 0.06");
    expect(built.user).toContain("0.12 to 0.80");
    expect(built.user).toContain("1 colours used (use at least 3)");
    expect(built.user).toContain("2 distinct rows of 16");
    expect(built.user).toContain("bounding box x 6-9, y 6-9");
  });

  it("says which batch this is and how many remain", () => {
    expect(built.user).toContain("batch 2 of 5");
  });

  it("says the ops are applied on top, not instead", () => {
    // A model that restarted would undo its own work, and the loop would then
    // measure the same canvas five times.
    expect(built.user).toContain("ON TOP");
    expect(built.user.toLowerCase()).toContain("do not redraw what is already right");
  });

  it("names the specific gap when the canvas is monochrome", () => {
    expect(built.user.toLowerCase()).toContain("shading and an outline");
  });

  it("says 'nothing is drawn yet' rather than a degenerate bounding box", () => {
    const blank = makeEmpty(16, 16);
    const empty = buildGaugePrompt({
      prompt: "a fox",
      size: SIZE_16,
      palette: GAMEBOY,
      canvas: blank,
      reading: gauge(blank),
      batch: 2,
      of: 5,
    });
    expect(empty.user).toContain("nothing is drawn yet");
    expect(empty.user).toContain("coverage 0.00");
    expect(empty.user).not.toContain("bounding box");
  });
});

// ---------------------------------------------------------------------------
// parseOps — spec §6.2a
// ---------------------------------------------------------------------------

describe("parseOps", () => {
  it("reads a clean batch and its intent", () => {
    const parsed = parseOps(opsReply(GOOD_OPS, { subject: "a fox" }), 4);
    expect(parsed.ops).toEqual(GOOD_OPS);
    expect(parsed.dropped).toBe(0);
    expect(parsed.carried).toBe(true);
    expect(parsed.intent.subject).toBe("a fox");
  });

  it("accepts a batch wrapped in a fenced code block, or in prose", () => {
    const body = opsReply(WEAK_OPS);
    expect(parseOps(`Here you go:\n\`\`\`json\n${body}\n\`\`\``, 4).ops).toEqual(WEAK_OPS);
    expect(parseOps(`Sure! ${body} Hope that helps.`, 4).ops).toEqual(WEAK_OPS);
  });

  it("takes a bare array of operations as the batch it plainly is", () => {
    const parsed = parseOps(JSON.stringify(WEAK_OPS), 4);
    expect(parsed.ops).toEqual(WEAK_OPS);
    expect(parsed.carried).toBe(true);
  });

  it("distinguishes an EMPTY batch from no batch at all", () => {
    // `{"ops":[]}` is §6.2b's stop signal — the model saying it has nothing to
    // add. A reply with no `ops` key is a model that did not answer.
    const empty = parseOps('{"ops":[]}', 4);
    expect(empty.ops).toEqual([]);
    expect(empty.carried).toBe(true);

    const absent = parseOps('{"intent":{"subject":"a fox"}}', 4);
    expect(absent.ops).toEqual([]);
    expect(absent.carried).toBe(false);
  });

  it("drops one invalid entry rather than the whole batch", () => {
    const raw = JSON.stringify({
      ops: [
        WEAK_OPS[0],
        { op: "flood_fill", x0: 0, y0: 0, index: "1" },
        { op: "mirror_x" },
        { op: "line", x0: 0, y0: 0, x1: 3, y1: 3, index: "1" },
      ],
    });
    const parsed = parseOps(raw, 4);
    expect(parsed.ops).toHaveLength(2);
    expect(parsed.dropped).toBe(2);
  });

  it("drops an op whose index the palette cannot spell", () => {
    // §6.3 maps an off-palette *cell* to transparent; an op mapped to
    // transparent would ERASE what is under it, which is worse than not drawing.
    const raw = opsReply([{ op: "fill_rect", x0: 0, y0: 0, x1: 3, y1: 3, index: "9" }]);
    expect(parseOps(raw, 4)).toMatchObject({ ops: [], dropped: 1, carried: true });
    // The same op against a 16-colour palette is not a defect at all.
    expect(parseOps(raw, 16).ops).toHaveLength(1);
  });

  it("keeps mirror_x and clear at every palette size — neither names a colour", () => {
    const raw = opsReply([
      { op: "mirror_x", axis: 8 },
      { op: "clear", x0: 0, y0: 0, x1: 1, y1: 1 },
    ]);
    expect(parseOps(raw, 4).ops).toHaveLength(2);
  });

  it("keeps an op whose index is '.' — transparent is legal everywhere", () => {
    const raw = opsReply([{ op: "fill_rect", x0: 0, y0: 0, x1: 1, y1: 1, index: "." }]);
    expect(parseOps(raw, 4).ops).toHaveLength(1);
  });

  it("keeps index '0' — the falsy character, and the commonest outline colour", () => {
    const raw = opsReply([{ op: "line", x0: 0, y0: 0, x1: 3, y1: 3, index: "0" }]);
    expect(parseOps(raw, 4).ops).toHaveLength(1);
    expect(parseOps(raw, 4).dropped).toBe(0);
  });

  it("never throws, whatever arrives", () => {
    const junk = [
      "",
      "{",
      "{}",
      "[]",
      "null",
      "3",
      '{"ops":null}',
      '{"ops":[1,2,3]}',
      '{"ops":{"0":{"op":"mirror_x","axis":8}}}',
      '{"ops":[{"op":"mirror_x","axis":"eight"}]}',
      "```json\nnot json\n```",
      "<think>hm, a fox</think>",
      "I'm sorry, I can't draw pixel art.",
    ];
    for (const raw of junk) {
      expect(() => parseOps(raw, 4)).not.toThrow();
      expect(Array.isArray(parseOps(raw, 4).ops)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// parseDraft — the whole-canvas compatibility path, spec §6.3
//
// Under A10 the decoder cannot emit a row, so nothing on the draft path reaches
// these branches. `normalize` stays because it is still the parser for a
// document loaded from disk and still the definition of what a repair IS — the
// rejection arithmetic on both paths is expressed in its terms.
// ---------------------------------------------------------------------------

describe("parseDraft", () => {
  it("returns the grid unchanged and zero repairs on a clean whole-canvas reply", () => {
    const parsed = parseDraft(rowsReply(CLEAN_16, { subject: "a fox" }), SIZE_16, GAMEBOY);
    expect(parsed.grid).toEqual(CLEAN_16);
    expect(parsed.rows).toEqual(CLEAN_16);
    expect(parsed.repairs).toBe(0);
    expect(parsed.repairedRows).toEqual([]);
    expect(parsed.intent.subject).toBe("a fox");
  });

  it("reports rows: null when the reply carried no canvas", () => {
    // The one thing the repaired grid cannot say for itself: 16 rows of dots
    // from a prose reply and 16 rows of dots the model actually sent are the
    // same value, and only one of them is an answer.
    expect(parseDraft("I'm sorry, I can't draw pixel art.", SIZE_16, GAMEBOY).rows).toBeNull();
    expect(parseDraft(opsReply(GOOD_OPS), SIZE_16, GAMEBOY).rows).toBeNull();
    expect(parseDraft(rowsReply([]), SIZE_16, GAMEBOY).rows).toEqual([]);
  });

  it("charges w x h repairs for a prose-only reply, and does not throw", () => {
    const parsed = parseDraft("I'm sorry, I can't draw pixel art.", SIZE_16, GAMEBOY);
    expect(parsed.repairs).toBe(16 * 16);
    expect(parsed.repairedRows).toEqual(ALL_ROWS_16);
    expect(parsed.grid).toEqual(Array(16).fill(".".repeat(16)));
    expect(parsed.intent).toEqual({ subject: "" });
  });

  it("names the exact rows it repaired", () => {
    const parsed = parseDraft(rowsReply(shorten(CLEAN_16, [2, 5, 9], 1)), SIZE_16, GAMEBOY);
    expect(parsed.repairs).toBe(3);
    expect(parsed.repairedRows).toEqual([2, 5, 9]);
  });

  it("repairs an index past the end of the palette to transparent — spec A4", () => {
    const raw = rowsReply(poke(CLEAN_16, 4, 5, "9"));
    const parsed = parseDraft(raw, SIZE_16, GAMEBOY);
    expect(parsed.repairs).toBe(1);
    expect(parsed.grid[4][5]).toBe(".");
    expect(parseDraft(raw, SIZE_16, PICO_8).repairs).toBe(0);
  });

  it("charges dropped rows past the canvas height — the unbounded ratio, spec A5", () => {
    const hundred = Array.from({ length: 100 }, (_, y) => (y < 16 ? CLEAN_16[y] : ".".repeat(16)));
    const parsed = parseDraft(rowsReply(hundred), SIZE_16, GAMEBOY);
    expect(parsed.repairs).toBe((100 - 16) * 16); // 1344 charged against 256 cells
    expect(parsed.repairs / (16 * 16)).toBeGreaterThan(1);
  });

  it("does not mistake an op batch for a list of rows", () => {
    // Both arrive as a bare JSON array. Reading GOOD_OPS as rows would charge
    // the whole canvas and reject a perfectly good draft.
    const parsed = parseDraft(JSON.stringify(GOOD_OPS), SIZE_16, GAMEBOY);
    expect(parsed.rows).toBeNull();
    expect(parseOps(JSON.stringify(GOOD_OPS), 4).ops).toEqual(GOOD_OPS);
  });

  it("never throws, whatever arrives", () => {
    const junk = ["", "{", "{}", "[]", "null", "3", '{"rows":null}', '{"rows":[1,2,3]}'];
    for (const raw of junk) {
      expect(() => parseDraft(raw, SIZE_16, GAMEBOY)).not.toThrow();
      const parsed = parseDraft(raw, SIZE_16, GAMEBOY);
      expect(parsed.grid).toHaveLength(16);
      for (const row of parsed.grid) expect(row).toHaveLength(16);
    }
  });
});

// ---------------------------------------------------------------------------
// describeDefects — the retry prompt's raw material, spec §6.3
// ---------------------------------------------------------------------------

describe("describeDefects", () => {
  it("says the operations drew nothing when every one missed the canvas", () => {
    const offCanvas = opsReply([{ op: "fill_rect", x0: 40, y0: 40, x1: 60, y1: 60, index: "1" }]);
    const text = describeDefects(offCanvas, SIZE_16, GAMEBOY).join("\n");
    expect(text).toContain("drew nothing inside the canvas");
    expect(text).toContain("x 0-15");
    expect(text).toContain("y 0-15");
  });

  it("says the ops array was empty when the model sent none", () => {
    expect(describeDefects('{"ops":[]}', SIZE_16, GAMEBOY).join("")).toContain(
      'your "ops" array was empty',
    );
  });

  it("says none of the entries was a valid operation", () => {
    const raw = JSON.stringify({ ops: [{ op: "flood_fill" }, { nope: 1 }] });
    const text = describeDefects(raw, SIZE_16, GAMEBOY).join("\n");
    expect(text).toContain("none of your 2 entries was a valid operation");
    expect(text).toContain("ellipse");
  });

  it("counts the discarded entries separately from the ones that missed", () => {
    const raw = JSON.stringify({
      ops: [
        { op: "fill_rect", x0: 40, y0: 40, x1: 60, y1: 60, index: "1" },
        { op: "fill_rect", x0: 0, y0: 0, x1: 1, y1: 1, index: "9" },
      ],
    });
    const lines = describeDefects(raw, SIZE_16, GAMEBOY);
    expect(lines.join("\n")).toContain("drew nothing inside the canvas");
    expect(lines.join("\n")).toContain("1 of your entries were discarded");
    expect(lines.join("\n")).toContain("0-3"); // the palette it may actually spell
  });

  it("says so when nothing parseable arrived at all", () => {
    const text = describeDefects("I'm sorry, I can't draw pixel art.", SIZE_16, GAMEBOY).join("");
    expect(text).toMatch(/JSON/i);
    expect(text).toContain('"ops"');
  });

  it("still names a whole-canvas reply's defects by kind — §6.3", () => {
    const length = describeDefects(rowsReply(shorten(CLEAN_16, [4], 4)), SIZE_16, GAMEBOY).join("\n");
    expect(length).toContain("row 4 had 12 characters, expected 16");
    expect(length).not.toContain("used index");

    const palette = describeDefects(rowsReply(poke(CLEAN_16, 4, 5, "9")), SIZE_16, GAMEBOY).join("\n");
    expect(palette).toContain("row 4 used index 9");
    expect(palette).toContain("gameboy");
    expect(palette).not.toContain("characters, expected");
  });

  it("names uppercase separately from an unknown character", () => {
    expect(describeDefects(rowsReply(poke(CLEAN_16, 2, 2, "A")), SIZE_16, PICO_8).join("")).toMatch(
      /lowercase/i,
    );
    expect(describeDefects(rowsReply(poke(CLEAN_16, 2, 2, "$")), SIZE_16, PICO_8).join("")).toContain(
      "'$'",
    );
  });

  it("names a wrong row count without repeating itself per absent row", () => {
    expect(describeDefects(rowsReply(CLEAN_16.slice(0, 3)), SIZE_16, GAMEBOY)).toEqual([
      "you returned 3 rows, expected exactly 16",
    ]);
  });

  it("returns nothing for a clean whole-canvas reply", () => {
    expect(describeDefects(rowsReply(CLEAN_16, { subject: "a fox" }), SIZE_16, GAMEBOY)).toEqual([]);
  });

  it("stays bounded on a catastrophic 64x64 reply", () => {
    const junk = Array.from({ length: 64 }, () => "x".repeat(3));
    expect(describeDefects(rowsReply(junk), SIZE_64, GAMEBOY).length).toBeLessThanOrEqual(16);
  });
});

// ---------------------------------------------------------------------------
// draftTimeoutMs — spec §6.8, amendment A12
// ---------------------------------------------------------------------------

describe("draftTimeoutMs", () => {
  it("gives a 16x16 the FLOOR, not 120000 x 256/1024", () => {
    // Acceptance criterion 8, and the measured failure A12 exists to fix: the
    // area-scaled 30s was less than a `qwen3:8b` revise turn, so every 16x16 run
    // ended FAILED after round 1 — the app's first real generation.
    expect(draftTimeoutMs(cfg(), SIZE_16)).toBe(45000);
    expect(draftTimeoutMs(cfg(), SIZE_16)).not.toBe(30000);
  });

  it("still scales up past the floor on the larger canvases", () => {
    expect(draftTimeoutMs(cfg(), SIZE_32)).toBe(120000);
    expect(draftTimeoutMs(cfg(), SIZE_64)).toBe(480000);
  });

  it("honours a raised floor over a larger area term", () => {
    expect(draftTimeoutMs(cfg({ callTimeoutFloorMs: 200000 }), SIZE_32)).toBe(200000);
  });

  it("never returns a zero-length deadline", () => {
    expect(
      draftTimeoutMs(cfg({ callTimeoutMs: 1, callTimeoutFloorMs: 1 }), SIZE_16),
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// draft — the document it builds, spec §6.2, §7.5
// ---------------------------------------------------------------------------

describe("draft", () => {
  it("returns a document that validates against SpriteDocSchema", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS, { subject: "a fox" })] });
    const doc = await draft({ client: stub }, INPUT_16, cfg());

    expect(() => SpriteDocSchema.parse(doc)).not.toThrow();
    expect(doc.rows).toEqual(render16(GOOD_OPS));
    expect(doc.size).toEqual(SIZE_16);
    expect(doc.prompt).toBe("a sitting red fox");
    expect(doc.intent.subject).toBe("a fox");
  });

  it("renders the ops the model sent, in the order it sent them", async () => {
    // The whole of A10: the document is the interpreter's output, and the ops
    // are a legible artifact a human can read back off it.
    const ops: DrawOp[] = [
      { op: "fill_rect", x0: 4, y0: 4, x1: 11, y1: 11, index: "1" },
      { op: "fill_rect", x0: 6, y0: 6, x1: 9, y1: 9, index: "2" },
      { op: "ellipse", cx: 7, cy: 7, rx: 0, ry: 0, index: "3" },
    ];
    const stub = createStubClient({ generate: [opsReply(ops)] });
    const doc = await draft({ client: stub }, INPUT_16, cfg({ maxDraftBatches: 1 }));

    expect(doc.rows).toEqual(render16(ops));
    expect(doc.rows[4].slice(4, 12)).toBe("11111111");
    expect(doc.rows[7].slice(6, 10)).toBe("2322");
  });

  it("fills the meta fields the draft owns — spec §7.5", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS, { subject: "a fox" })] });
    const doc = await draft(
      { client: stub },
      INPUT_16,
      cfg({ models: { generator: "qwen3:8b", critic: "qwen3-vl:8b-instruct-q4_K_M" } }),
    );

    expect(doc.meta.round).toBe(1); // the draft is round 1
    expect(doc.meta.parentId).toBeNull();
    expect(doc.meta.generatorModel).toBe("qwen3:8b");
    expect(doc.meta.criticModel).toBe("qwen3-vl:8b-instruct-q4_K_M");
    expect(doc.schemaVersion).toBe(1);
    expect(doc.id.length).toBeGreaterThan(0);
    expect(Date.parse(doc.createdAt)).not.toBeNaN();
  });

  it("reports zero repairs on the DSL path — there is no width to get wrong", async () => {
    // §6.2a: row-length repair is unreachable from this stage. `repairs` is not
    // quietly repurposed to mean something else; it stays the §6.3 count, and on
    // this path that count is zero.
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    const doc = await draft({ client: stub }, INPUT_16, cfg());
    expect(doc.meta.repairs).toBe(0);
    expect(doc.meta.repairedRows).toEqual([]);
  });

  it("gives two drafts different identities", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    const a = await draft({ client: stub }, INPUT_16, cfg());
    const b = await draft({ client: stub }, INPUT_16, cfg());
    expect(a.id).not.toBe(b.id);
  });

  it("copies the palette rather than aliasing the frozen singleton", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    const doc = await draft({ client: stub }, INPUT_16, cfg());

    expect(doc.palette.id).toBe("gameboy");
    expect(doc.palette.colors).toEqual([...GAMEBOY.colors]);
    expect(doc.palette.colors).not.toBe(GAMEBOY.colors);
    expect(() => doc.palette.colors.push("#ffffff")).not.toThrow();
    expect(GAMEBOY.colors).toHaveLength(4);
  });

  it("falls back to the user's prompt when the model omitted the intent", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    const doc = await draft({ client: stub }, INPUT_16, cfg());
    expect(doc.intent.subject).toBe("a sitting red fox");
  });

  it("drops an off-palette op rather than producing a document the renderer cannot colour", async () => {
    const ops: DrawOp[] = [
      ...GOOD_OPS,
      { op: "fill_rect", x0: 1, y0: 1, x1: 3, y1: 3, index: "9" },
    ];
    const stub = createStubClient({ generate: [opsReply(ops)] });
    const doc = await draft({ client: stub }, INPUT_16, cfg());

    expect(() => SpriteDocSchema.parse(doc)).not.toThrow();
    expect(doc.rows).toEqual(render16(GOOD_OPS));
    expect(doc.rows.join("")).not.toContain("9");
  });

  it("throws on an unknown palette id before it calls the model", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    await expect(
      draft({ client: stub }, { ...INPUT_16, paletteId: "not-a-palette" }, cfg()),
    ).rejects.toThrow(/not-a-palette/);
    expect(stub.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // the request — spec §6.2a, A8
  // -------------------------------------------------------------------------

  it("sends the built prompt as system + user", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    await draft({ client: stub }, INPUT_16, cfg());

    const built = buildDraftPrompt({ prompt: "a sitting red fox", size: SIZE_16, palette: GAMEBOY });
    expect(stub.calls[0].system).toBe(built.system);
    expect(stub.calls[0].prompt).toBe(built.user);
  });

  it("sends the op JSON Schema as format, never format: \"json\"", async () => {
    // A10: grammar-constrained decoding is what made row width unrepresentable
    // in the old path; the same move makes op shape — and an off-palette index —
    // unrepresentable here. Asserted on the recorded call, because the prompt
    // text cannot tell a schema from a bare `"json"`.
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    await draft({ client: stub }, INPUT_16, cfg());

    const format = recordedFormat(stub.calls[0].format);
    expect(format).not.toBe("json");
    expect(format).toEqual(buildDraftFormat(GAMEBOY));
    expect(format.required).toEqual(["ops"]);
  });

  it("sends the format built for the palette in use", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    await draft({ client: stub }, { prompt: "a chest", size: SIZE_32, paletteId: "pico-8" }, cfg());
    expect(recordedFormat(stub.calls[0].format)).toEqual(buildDraftFormat(PICO_8));
  });

  it("sends think: false on every call — spec A8", async () => {
    const stub = createStubClient({ generate: [opsReply(WEAK_OPS)] });
    await draft({ client: stub }, INPUT_16, cfg({ maxDraftBatches: 3 }));

    expect(stub.calls).toHaveLength(3);
    for (const call of stub.calls) {
      expect(call.method).toBe("generate");
      expect(call.think).toBe(false);
    }
  });

  it("binds to the configured generator model", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    await draft(
      { client: stub },
      INPUT_16,
      cfg({ models: { generator: "qwen3-vl:8b-instruct-q4_K_M", critic: "whatever:1b" } }),
    );
    expect(stub.calls[0].model).toBe("qwen3-vl:8b-instruct-q4_K_M");
  });

  // -------------------------------------------------------------------------
  // A13 — the DRAFT stage's options bag
  //
  // Asserted here, on this stage's own recorded call, and not only in
  // `schema.test.ts`: a stage that forgets to pass `options` at all is exactly
  // the defect A13 was written for, and `modelOptions` being correct says
  // nothing about whether anyone calls it.
  // -------------------------------------------------------------------------

  it("sends options.seed and options.temperature on every draft call — A13", async () => {
    const stub = createStubClient({ generate: [opsReply(WEAK_OPS)] });
    await draft({ client: stub }, INPUT_16, cfg({ seed: 1234, temperature: 0.25, maxDraftBatches: 3 }));

    expect(stub.calls).toHaveLength(3);
    for (const call of stub.calls) {
      expect(call.options).toEqual({ seed: 1234, temperature: 0.25 });
    }
  });

  it("keeps seed: 0 and temperature: 0 on the wire — the falsy-zero trap", async () => {
    // A bench run sets exactly these. A truthiness check on either drops it and
    // the run silently reverts to Ollama's defaults.
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    await draft({ client: stub }, INPUT_16, cfg({ seed: 0, temperature: 0 }));

    expect(stub.calls[0].options).toEqual({ seed: 0, temperature: 0 });
  });

  it("OMITS seed when the config seed is null, and still sends temperature", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    await draft({ client: stub }, INPUT_16, cfg());

    const options = stub.calls[0].options;
    expect(options).toEqual({ temperature: 0.6 });
    expect("seed" in (options ?? {})).toBe(false);
    expect(JSON.stringify(options)).not.toContain("seed");
  });

  it("reads temperature from the config rather than hardcoding it", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    await draft({ client: stub }, INPUT_16, cfg({ temperature: 1.9 }));
    expect(stub.calls[0].options?.temperature).toBe(1.9);
  });

  it("puts seed INSIDE options, never at the top level — A8's trap in reverse", async () => {
    // `think` is top-level and must not be in `options`; `seed` and
    // `temperature` are options keys and must not be top-level. Ollama drops an
    // unknown top-level field as silently as it drops an unknown option key.
    //
    // Read off the *raw request*, not off `RecordedCall`: the stub records only
    // the fields it knows about, so a top-level `seed` would simply vanish from
    // the log and the assertion would pass on a request that never carried one.
    const seen: Record<string, unknown>[] = [];
    const unscripted = async (): Promise<never> => {
      throw new Error("draft() called a method other than generate()");
    };
    const client: OllamaClient = {
      listModels: unscripted,
      vision: unscripted,
      chatWithTools: unscripted,
      async generate(req: GenerateRequest): Promise<string> {
        seen.push(req as unknown as Record<string, unknown>);
        return opsReply(GOOD_OPS);
      },
    };

    await draft({ client }, INPUT_16, cfg({ seed: 7 }));

    expect(seen).toHaveLength(1);
    expect(seen[0].seed).toBeUndefined();
    expect(seen[0].temperature).toBeUndefined();
    expect(seen[0].options).toEqual({ seed: 7, temperature: 0.6 });
  });

  // -------------------------------------------------------------------------
  // the gauge loop — spec §6.2b, amendment A11
  // -------------------------------------------------------------------------

  it("STOPS AFTER ONE CALL when the first batch clears the bar", async () => {
    // Acceptance criterion 6, and the whole of A11: the harness owns the stop
    // decision. In the benchmark the model never once set `done: true`, so a
    // loop waiting to be told would always spend its whole budget — and five
    // batches made a good sprite worse.
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    const doc = await draft({ client: stub }, INPUT_16, cfg({ maxDraftBatches: 5 }));

    expect(stub.calls).toHaveLength(1);
    expect(doc.rows).toEqual(render16(GOOD_OPS));
    expect(clearsGaugeBar(gauge(doc.rows), cfg().draftGaugeBar)).toBe(true);
  });

  it("DRAWS MORE when the first batch is weak, and stops at the one that clears", async () => {
    const stub = createStubClient({
      generate: [opsReply(WEAK_OPS), opsReply(WEAK_OPS), opsReply(GOOD_OPS)],
    });
    const doc = await draft({ client: stub }, INPUT_16, cfg({ maxDraftBatches: 5 }));

    expect(stub.calls).toHaveLength(3); // not 5 — it stopped when the bar cleared
    expect(clearsGaugeBar(gauge(doc.rows), cfg().draftGaugeBar)).toBe(true);
  });

  it("accumulates onto the same canvas rather than restarting each batch", async () => {
    const first: DrawOp[] = [{ op: "fill_rect", x0: 1, y0: 1, x1: 3, y1: 3, index: "1" }];
    const second: DrawOp[] = [{ op: "fill_rect", x0: 10, y0: 10, x1: 12, y1: 12, index: "2" }];
    const stub = createStubClient({ generate: [opsReply(first), opsReply(second)] });
    const doc = await draft({ client: stub }, INPUT_16, cfg({ maxDraftBatches: 2 }));

    // Both batches are present. A loop that rendered only the last batch would
    // throw away four fifths of the sprite it paid for.
    expect(doc.rows).toEqual(render16([...first, ...second]));
    expect(doc.rows[1][1]).toBe("1");
    expect(doc.rows[10][10]).toBe("2");
  });

  it("shows the model the canvas and its measurements between batches", async () => {
    const stub = createStubClient({ generate: [opsReply(WEAK_OPS), opsReply(GOOD_OPS)] });
    await draft({ client: stub }, INPUT_16, cfg({ maxDraftBatches: 5 }));

    const second = stub.calls[1].prompt ?? "";
    expect(second).toContain(WEAK_ROW); // the canvas so far
    expect(second).toContain("coverage 0.06");
    expect(second).toContain("1 colours used (use at least 3)");
    expect(second).toContain("batch 2 of 5");
    // And the first call did NOT carry a canvas — there was none to show.
    expect(stub.calls[0].prompt).not.toContain("THE CANVAS SO FAR");
  });

  it("spends at most maxDraftBatches calls on a draft that never clears", async () => {
    const stub = createStubClient({ generate: [opsReply(WEAK_OPS)] }); // the last entry is reused
    const doc = await draft({ client: stub }, INPUT_16, cfg({ maxDraftBatches: 5 }));

    expect(stub.calls).toHaveLength(5);
    // A draft that never cleared the bar is still a draft: the bar is a STOP
    // condition, not an acceptance test. Judging quality is the critic's job.
    expect(clearsGaugeBar(gauge(doc.rows), cfg().draftGaugeBar)).toBe(false);
    expect(gauge(doc.rows).coverage).toBeGreaterThan(0);
  });

  it("honours maxDraftBatches: 1 — one call, no gauge turn", async () => {
    const stub = createStubClient({ generate: [opsReply(WEAK_OPS)] });
    await draft({ client: stub }, INPUT_16, cfg({ maxDraftBatches: 1 }));
    expect(stub.calls).toHaveLength(1);
  });

  it("STOPS ON AN EMPTY ops ARRAY rather than spinning", async () => {
    // Acceptance criterion 7. §6.2b: an empty batch is "no further progress",
    // and a batch that adds nothing cannot add something next time either.
    const stub = createStubClient({ generate: [opsReply(WEAK_OPS), '{"ops":[]}'] });
    const doc = await draft({ client: stub }, INPUT_16, cfg({ maxDraftBatches: 5 }));

    expect(stub.calls).toHaveLength(2); // not 5
    expect(doc.rows).toEqual(render16(WEAK_OPS));
  });

  it("stops on a batch whose every entry was discarded", async () => {
    const stub = createStubClient({
      generate: [opsReply(WEAK_OPS), JSON.stringify({ ops: [{ op: "flood_fill" }] })],
    });
    await draft({ client: stub }, INPUT_16, cfg({ maxDraftBatches: 5 }));
    expect(stub.calls).toHaveLength(2);
  });

  it("arms every batch with its own AbortSignal, none already fired", async () => {
    const { client, signals } = probeClient((n) =>
      n < 3 ? opsReply(WEAK_OPS) : opsReply(GOOD_OPS),
    );
    await draft({ client }, INPUT_16, cfg({ maxDraftBatches: 5 }));

    expect(signals).toHaveLength(3);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
    expect(signals[0]).not.toBe(signals[1]); // a fresh deadline per batch
  });

  it("aborts a batch at the floored deadline", async () => {
    const started = Date.now();
    await expect(
      draft(
        { client: hangingClient() },
        INPUT_16,
        cfg({ callTimeoutMs: 800, callTimeoutFloorMs: 200 }),
      ),
    ).rejects.toThrow("aborted");
    // The floor decides here, not the 200ms area scaling of `callTimeoutMs`.
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(700);
  });

  it("scales the deadline UP past the floor on a 64x64 canvas", async () => {
    const settled = draft(
      { client: hangingClient() },
      { prompt: "a tree", size: SIZE_64, paletteId: "pico-8" },
      cfg({ callTimeoutMs: 60, callTimeoutFloorMs: 1 }),
    ).then(
      () => "resolved",
      () => "rejected",
    );

    // 60ms x 4096/1024 = 240ms; an unscaled 60ms would have aborted 90ms ago.
    expect(await Promise.race([settled, sleep(150)])).toBe("pending");
    expect(await settled).toBe("rejected");
  });

  // -------------------------------------------------------------------------
  // rejection and retry — spec §6.3, A9
  // -------------------------------------------------------------------------

  it("gives a batch that missed the canvas another batch before rejecting it", async () => {
    // Ops that all landed outside are still ops: the model tried, the gauge
    // reports "nothing is drawn yet", and the next batch is exactly the
    // correction A11 exists to buy. Rejecting the attempt here would spend a
    // whole retry — a fresh prompt with no memory — on what one more batch fixes.
    const offCanvas = opsReply([{ op: "fill_rect", x0: 40, y0: 40, x1: 60, y1: 60, index: "1" }]);
    const stub = createStubClient({ generate: [offCanvas, opsReply(GOOD_OPS)] });
    const failures: DraftFailure[] = [];

    const doc = await draft(
      { client: stub, onAttempt: (f) => failures.push(f) },
      INPUT_16,
      cfg({ maxDraftBatches: 5 }),
    );

    expect(stub.calls).toHaveLength(2);
    expect(doc.rows).toEqual(render16(GOOD_OPS));
    expect(failures).toEqual([]); // no attempt was rejected
    expect(stub.calls[1].prompt).toContain("nothing is drawn yet");
  });

  it("rejects an attempt that painted nothing and retries with the defects named", async () => {
    const offCanvas = opsReply([{ op: "fill_rect", x0: 40, y0: 40, x1: 60, y1: 60, index: "1" }]);
    const stub = createStubClient({ generate: [offCanvas, opsReply(GOOD_OPS)] });

    const doc = await draft(
      { client: stub },
      INPUT_16,
      cfg({ maxDraftRetries: 1, maxDraftBatches: 1 }),
    );

    expect(stub.calls).toHaveLength(2);
    expect(doc.rows).toEqual(render16(GOOD_OPS));
    expect(stub.calls[1].prompt).toContain("YOUR PREVIOUS REPLY WAS REJECTED");
    expect(stub.calls[1].prompt).toContain("drew nothing inside the canvas");
    // A retry is a fresh composition, not a continuation: it carries the defects
    // and no canvas, because there is no canvas worth carrying.
    expect(stub.calls[1].prompt).not.toContain("THE CANVAS SO FAR");
  });

  it("charges an empty canvas the whole canvas — §6.3's last table row", async () => {
    const stub = createStubClient({ generate: ['{"ops":[]}'] });
    const failures: DraftFailure[] = [];

    const error = await draft(
      { client: stub, onAttempt: (f) => failures.push(f) },
      INPUT_16,
      cfg({ maxDraftRetries: 1 }),
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DraftRejectedError);
    expect((error as DraftRejectedError).repairs).toBe(16 * 16);
    expect(failures.map((f) => f.repairs)).toEqual([256, 256]);
    // One call per attempt: an empty batch stops the loop, so the retry budget
    // is what bounds this and not `maxDraftBatches`.
    expect(stub.calls).toHaveLength(2);
  });

  it("routes a prose-only reply through the retry path rather than throwing", async () => {
    const prose = "I'm sorry, I can't draw pixel art. Would you like a description instead?";
    const stub = createStubClient({ generate: [prose, opsReply(GOOD_OPS)] });

    const doc = await draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 1 }));

    expect(stub.calls).toHaveLength(2);
    expect(doc.meta.repairs).toBe(0);
    expect(stub.calls[1].prompt).toMatch(/JSON/i);
  });

  it("raises DraftRejectedError — never an unhandled throw — when both replies are prose", async () => {
    const prose = "I'm sorry, I can't draw pixel art.";
    const stub = createStubClient({ generate: [prose] }); // the last entry is reused

    const error = await draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 1 })).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DraftRejectedError);
    expect(error).toBeInstanceOf(Error);
    const rejected = error as DraftRejectedError;
    expect(rejected.name).toBe("DraftRejectedError");
    expect(rejected.raw).toBe(prose);
    expect(rejected.repairs).toBe(256);
    expect(rejected.message).toContain("256");
    expect(stub.calls).toHaveLength(2);
  });

  it("honours maxDraftRetries: 0 — one attempt, no retry", async () => {
    const stub = createStubClient({ generate: ['{"ops":[]}'] });

    await expect(
      draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 0 })),
    ).rejects.toBeInstanceOf(DraftRejectedError);
    expect(stub.calls).toHaveLength(1);
  });

  it("honours maxDraftRetries: 2 — three attempts", async () => {
    const stub = createStubClient({ generate: ['{"ops":[]}'] });

    await expect(
      draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 2 })),
    ).rejects.toBeInstanceOf(DraftRejectedError);
    expect(stub.calls).toHaveLength(3);
    for (const call of stub.calls) expect(call.think).toBe(false);
  });

  it("keeps a weak draft rather than rejecting it — the bar is not the threshold", async () => {
    const stub = createStubClient({ generate: [opsReply(WEAK_OPS)] });
    const doc = await draft({ client: stub }, INPUT_16, cfg({ maxDraftBatches: 1 }));
    expect(doc.meta.repairs).toBe(0);
    expect(stub.calls).toHaveLength(1);
  });

  it("does not spend the retry budget on a transport failure — spec §7.1", async () => {
    // `DRAFTING → FAILED` on timeout / unreachable is a different edge from
    // `DRAFTING → DRAFTING` on a rejected draft. Retrying an unreachable Ollama
    // doubles every failure's latency and tells the user nothing new.
    const stub = createStubClient({
      generate: [new OllamaUnreachableError("http://127.0.0.1:11434/api/generate")],
    });

    await expect(draft({ client: stub }, INPUT_16, cfg())).rejects.toBeInstanceOf(
      OllamaUnreachableError,
    );
    expect(stub.calls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // the whole-canvas compatibility path — spec §6.3's arithmetic, unchanged
  // -------------------------------------------------------------------------

  it("accepts a whole-canvas reply and stops the loop on it", async () => {
    // A reply with no `ops` is not a batch: it is an answer, and there is no
    // second half of it to ask for. One call, and §6.3's repair record intact.
    const raw = rowsReply(shorten(CLEAN_16, [2, 5, 9], 1), { subject: "a fox" });
    const stub = createStubClient({ generate: [raw] });
    const doc = await draft({ client: stub }, INPUT_16, cfg({ maxDraftBatches: 5 }));

    expect(stub.calls).toHaveLength(1);
    expect(doc.meta.repairs).toBe(3);
    expect(doc.meta.repairedRows).toEqual([2, 5, 9]);
    expect(doc.intent.subject).toBe("a fox");
  });

  it("rejects above the threshold and accepts at it — the strict > of §6.3", async () => {
    // 51 / 256 = 0.19921875 (accepted); 52 / 256 = 0.203125 (rejected).
    const at51 = CLEAN_16.map((row, y) => (y < 3 ? "" : y === 3 ? row.slice(0, 13) : row));
    const at52 = CLEAN_16.map((row, y) => (y < 3 ? "" : y === 3 ? row.slice(0, 12) : row));
    expect(parseDraft(rowsReply(at51), SIZE_16, GAMEBOY).repairs).toBe(51);
    expect(parseDraft(rowsReply(at52), SIZE_16, GAMEBOY).repairs).toBe(52);

    const accepted = createStubClient({ generate: [rowsReply(at51)] });
    const doc = await draft({ client: accepted }, INPUT_16, cfg());
    expect(accepted.calls).toHaveLength(1);
    expect(doc.meta.repairs).toBe(51);

    const rejected = createStubClient({ generate: [rowsReply(at52), opsReply(GOOD_OPS)] });
    await draft({ client: rejected }, INPUT_16, cfg());
    expect(rejected.calls).toHaveLength(2);

    // And exactly at it: 64 / 256 = 0.25 is not *greater than* 0.25, so this
    // draft is kept. `>` and `>=` differ only on this input.
    const at64 = CLEAN_16.map((row, y) => (y < 4 ? "" : row));
    expect(parseDraft(rowsReply(at64), SIZE_16, GAMEBOY).repairs).toBe(64);
    const exact = createStubClient({ generate: [rowsReply(at64)] });
    await draft({ client: exact }, INPUT_16, cfg({ repairRejectThreshold: 0.25 }));
    expect(exact.calls).toHaveLength(1);
  });

  it("rejects the 100-rows-on-a-16x16-canvas draft — the unbounded ratio, spec A5", async () => {
    // 1344 repairs against 256 cells while all 16 surviving rows are pristine.
    const hundred = Array.from({ length: 100 }, (_, y) => (y < 16 ? CLEAN_16[y] : ".".repeat(16)));
    const stub = createStubClient({ generate: [rowsReply(hundred)] });

    const error = await draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 0 })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DraftRejectedError);
    expect((error as DraftRejectedError).repairs).toBe(1344);

    // At the *maximum* threshold the ratio still has to reject it: 1344 / 256 is
    // 5.25, not 1.0. A ratio clamped to 1 — the shape the arithmetic naturally
    // takes if `repairs` is mistaken for a fraction — accepts this draft.
    const permissive = createStubClient({ generate: [rowsReply(hundred)] });
    await expect(
      draft({ client: permissive }, INPUT_16, cfg({ maxDraftRetries: 0, repairRejectThreshold: 1 })),
    ).rejects.toBeInstanceOf(DraftRejectedError);
  });

  it("keeps a repaired off-palette canvas inside its declared palette", async () => {
    const stub = createStubClient({ generate: [rowsReply(poke(CLEAN_16, 4, 5, "9"))] });
    const doc = await draft({ client: stub }, INPUT_16, cfg());
    expect(doc.rows[4][5]).toBe(".");
    expect(doc.meta.repairs).toBe(1);
    expect(doc.meta.repairedRows).toEqual([4]);
  });

  // -------------------------------------------------------------------------
  // other canvases and palettes
  // -------------------------------------------------------------------------

  it("drafts a 32x32 pico-8 sprite from ops", async () => {
    const ops: DrawOp[] = [
      { op: "ellipse", cx: 16, cy: 12, rx: 9, ry: 7, index: "8" },
      { op: "fill_rect", x0: 10, y0: 18, x1: 21, y1: 27, index: "9" },
      { op: "ellipse", cx: 12, cy: 11, rx: 1, ry: 1, index: "0" },
      { op: "mirror_x", axis: 16 },
    ];
    const stub = createStubClient({ generate: [opsReply(ops, { subject: "a chest" })] });
    const doc = await draft(
      { client: stub },
      { prompt: "a treasure chest", size: SIZE_32, paletteId: "pico-8" },
      cfg(),
    );

    expect(() => SpriteDocSchema.parse(doc)).not.toThrow();
    expect(doc.rows).toHaveLength(32);
    expect(doc.palette.colors).toHaveLength(16);
    expect(doc.meta.repairs).toBe(0);
    expect(doc.rows).toEqual(renderOps(ops, SIZE_32, 16));
  });

  it("accepts a 32x32 whole-canvas reply at a repair count a 16x16 would reject", async () => {
    // 48 repairs is 19% of a 16x16 canvas but 4.7% of a 32x32 one — the same
    // absolute count, two different verdicts.
    const stub = createStubClient({ generate: [rowsReply(shorten(CLEAN_32, [0, 1, 2, 3], 12))] });
    const doc = await draft(
      { client: stub },
      { prompt: "a chest", size: SIZE_32, paletteId: "pico-8" },
      cfg(),
    );
    expect(doc.meta.repairs).toBe(48);
    expect(stub.calls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // the attempt reporter — spec amendment A9
  // -------------------------------------------------------------------------

  it("reports every rejected attempt through onAttempt, each with its own raw", async () => {
    const first = opsReply([{ op: "fill_rect", x0: 40, y0: 40, x1: 60, y1: 60, index: "1" }]);
    const second = "still not a sprite";
    const stub = createStubClient({ generate: [first, second] });
    const failures: DraftFailure[] = [];

    await expect(
      draft(
        { client: stub, onAttempt: (f) => failures.push(f) },
        INPUT_16,
        cfg({ maxDraftBatches: 1 }),
      ),
    ).rejects.toBeInstanceOf(DraftRejectedError);

    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.attempt)).toEqual([1, 2]);
    expect(failures[0].raw).toBe(first);
    expect(failures[1].raw).toBe(second);
    expect(failures[0].raw).not.toBe(failures[1].raw);
    for (const failure of failures) {
      expect(() => DraftFailureSchema.parse(failure)).not.toThrow();
      expect(failure.reason).toContain("repairRejectThreshold");
    }
  });

  it("reports the LAST batch of a rejected attempt, which is what the model last said", async () => {
    // An attempt is several calls now, so `raw` has to name one of them. The
    // last is the only one a retry prompt can be built from — it is the reply
    // that ended the attempt, and the earlier batches are already on a canvas
    // that is being thrown away.
    const missed = opsReply([{ op: "line", x0: 30, y0: 30, x1: 40, y1: 40, index: "1" }]);
    const stub = createStubClient({ generate: [missed, '{"ops":[]}'] });
    const failures: DraftFailure[] = [];

    await expect(
      draft(
        { client: stub, onAttempt: (f) => failures.push(f) },
        INPUT_16,
        cfg({ maxDraftRetries: 0, maxDraftBatches: 5 }),
      ),
    ).rejects.toBeInstanceOf(DraftRejectedError);

    expect(stub.calls).toHaveLength(2);
    expect(failures).toHaveLength(1);
    expect(failures[0].raw).toBe('{"ops":[]}');
  });

  it("fires for a rejected attempt the retry then recovered from", async () => {
    const stub = createStubClient({ generate: ['{"ops":[]}', opsReply(GOOD_OPS)] });
    const failures: DraftFailure[] = [];

    const doc = await draft({ client: stub, onAttempt: (f) => failures.push(f) }, INPUT_16, cfg());

    expect(doc.meta.repairs).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].attempt).toBe(1);
  });

  it("does not fire for an accepted attempt", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    const failures: DraftFailure[] = [];

    await draft({ client: stub, onAttempt: (f) => failures.push(f) }, INPUT_16, cfg());

    expect(failures).toEqual([]);
  });

  it("does not fire for a WEAK but non-empty draft", async () => {
    // A draft that never cleared the bar is not a rejected draft. Reporting it
    // as one would fill `draftFailures` with every ordinary run.
    const stub = createStubClient({ generate: [opsReply(WEAK_OPS)] });
    const failures: DraftFailure[] = [];

    await draft({ client: stub, onAttempt: (f) => failures.push(f) }, INPUT_16, cfg());

    expect(failures).toEqual([]);
  });

  it("does not fire on a transport failure — that is not a rejected draft", async () => {
    const stub = createStubClient({
      generate: [new OllamaUnreachableError("http://127.0.0.1:11434/api/generate")],
    });
    const failures: DraftFailure[] = [];

    await expect(
      draft({ client: stub, onAttempt: (f) => failures.push(f) }, INPUT_16, cfg()),
    ).rejects.toBeInstanceOf(OllamaUnreachableError);

    expect(failures).toEqual([]);
  });

  it("names the ratio and both of its terms, unclamped — amendment A5", async () => {
    const hundred = Array.from({ length: 100 }, (_, y) => (y < 16 ? CLEAN_16[y] : ".".repeat(16)));
    const stub = createStubClient({ generate: [rowsReply(hundred)] });
    const failures: DraftFailure[] = [];

    await expect(
      draft(
        { client: stub, onAttempt: (f) => failures.push(f) },
        INPUT_16,
        cfg({ maxDraftRetries: 0 }),
      ),
    ).rejects.toBeInstanceOf(DraftRejectedError);

    expect(failures[0].reason).toBe(
      "1344 repaired cells of 256 (525.0%) exceeded repairRejectThreshold 0.2",
    );
  });

  it("stays optional — the Wave 6 call shape is unchanged", async () => {
    const stub = createStubClient({ generate: [opsReply(GOOD_OPS)] });
    await expect(draft({ client: stub }, INPUT_16, cfg())).resolves.toBeDefined();
  });
});
