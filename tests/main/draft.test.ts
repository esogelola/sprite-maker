/**
 * The draft stage — spec §6.2, §6.3, §7.4, plan Wave 6.
 *
 * Written before `src/main/draft.ts` existed. Four of the behaviours pinned
 * below are ones whose breakage is *invisible* at the call site:
 *
 * - **`meta.repairedRows`** has a `[]` default on the schema, so a `draft()`
 *   that forgets it produces a document which parses clean while claiming
 *   nothing was repaired — and `row-repaired` then never fires in production.
 * - **The repair threshold is an unbounded ratio** (spec §6.3, A5): 100 rows on
 *   a 16×16 canvas charges 1344 against 256 cells, so the arithmetic may not
 *   assume a ratio ≤ 1.
 * - **`think: false`** is asserted on the stub's recorded call, never on prompt
 *   text. The `/no_think` prefix v2 specified was measured inert (spec A8), so
 *   a prompt-text assertion cannot tell suppression from decoration.
 * - **A prose-only reply** must route through the ordinary retry path. v1 left
 *   this undefined and it escaped the state machine as an unhandled rejection.
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
  parseDraft,
} from "@main/draft";
import { OllamaUnreachableError, type GenerateRequest, type OllamaClient } from "@main/ollama";
import { DRAFT_EXAMPLES } from "@main/prompts/draft";
import { getPalette } from "@shared/palettes";
import {
  DraftFailureSchema,
  HarnessConfigSchema,
  SpriteDocSchema,
  type DraftFailure,
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

/**
 * A well-formed sprite using only indices 0-3, so the *same* rows are valid
 * against `gameboy` (4 colours) and against every 16-colour palette.
 */
function cleanRows(size: Size): string[] {
  return Array.from({ length: size.h }, (_, y) =>
    Array.from({ length: size.w }, (_, x) =>
      x === 0 || y === 0 || x === size.w - 1 || y === size.h - 1 ? "." : String((x + y) % 4),
    ).join(""),
  );
}

/** The model's reply as `generate` hands it back — a JSON object, no fence. */
function reply(rows: string[], intent?: unknown): string {
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

/** Every row eight characters short: 128 repairs / 256 cells = 0.5, well over 0.2. */
const OVER_THRESHOLD_16 = reply(shorten(CLEAN_16, ALL_ROWS_16, 8));

const INPUT_16 = { prompt: "a sitting red fox", size: SIZE_16, paletteId: "gameboy" };

/**
 * A client that records the `AbortSignal` of each call.
 *
 * `RecordedCall` carries no signal and `tests/stubs/ollama.ts` belongs to Wave 5,
 * so the area-scaled timeout (§6.8) is observed through a local client instead.
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
// buildDraftPrompt — spec §7.4
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

  it("states the required output shape", () => {
    expect(whole).toContain('"rows"');
    expect(whole).toContain('"intent"');
    expect(whole).toContain('"subject"');
  });

  it("states the canvas dimensions", () => {
    expect(built.user).toMatch(/16\s*(?:x|×|wide|rows)/i);
    expect(built.system).toContain("16");
  });

  it("bounds the valid characters to the palette actually in use", () => {
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

  it("scales its stated dimensions with the canvas", () => {
    const big = buildDraftPrompt({ prompt: "a tree", size: SIZE_64, palette: PICO_8 });
    const text = `${big.system}\n${big.user}`;
    expect(text).toContain("64");
    expect(text).not.toMatch(/exactly 16 rows/);
  });

  it("its own worked examples obey the rules it states", () => {
    // §7.4 asks for two short worked examples. A prompt that demonstrates a
    // malformed grid teaches the defect to every draft, so the examples are held
    // to the encoding rather than merely counted.
    expect(DRAFT_EXAMPLES.length).toBeGreaterThanOrEqual(2);
    for (const example of DRAFT_EXAMPLES) {
      expect(built.system).toContain(JSON.stringify(example));
      expect(example.intent.subject.length).toBeGreaterThan(0);
      const width = example.rows[0].length;
      for (const row of example.rows) {
        expect(row).toMatch(/^[.0-3]+$/); // 0-3 is spellable in every bundled palette
        expect(row).toHaveLength(width);
      }
      expect(example.rows).toHaveLength(width); // square, like every §6.2 canvas
    }
  });
});

// ---------------------------------------------------------------------------
// parseDraft — spec §6.3
// ---------------------------------------------------------------------------

describe("parseDraft", () => {
  it("returns the grid unchanged and zero repairs on a clean reply", () => {
    const parsed = parseDraft(reply(CLEAN_16, { subject: "a fox" }), SIZE_16, GAMEBOY);
    expect(parsed.grid).toEqual(CLEAN_16);
    expect(parsed.repairs).toBe(0);
    expect(parsed.repairedRows).toEqual([]);
    expect(parsed.intent.subject).toBe("a fox");
  });

  it("reads the optional intent fields and drops the ones that are not legal", () => {
    const raw = reply(CLEAN_16, {
      subject: "a fox",
      style: "chunky outline",
      facing: "side",
      notes: "tail curled",
    });
    expect(parseDraft(raw, SIZE_16, GAMEBOY).intent).toEqual({
      subject: "a fox",
      style: "chunky outline",
      facing: "side",
      notes: "tail curled",
    });

    const bogus = reply(CLEAN_16, { subject: "a fox", facing: "left", style: 42, notes: null });
    expect(parseDraft(bogus, SIZE_16, GAMEBOY).intent).toEqual({ subject: "a fox" });
  });

  it("accepts a JSON object wrapped in a fenced code block", () => {
    const raw = `Here you go:\n\`\`\`json\n${reply(CLEAN_16, { subject: "a fox" })}\n\`\`\`\n`;
    const parsed = parseDraft(raw, SIZE_16, GAMEBOY);
    expect(parsed.repairs).toBe(0);
    expect(parsed.grid).toEqual(CLEAN_16);
  });

  it("accepts a JSON object with prose on either side of it", () => {
    const raw = `Sure! ${reply(CLEAN_16, { subject: "a fox" })} Hope that helps.`;
    expect(parseDraft(raw, SIZE_16, GAMEBOY).repairs).toBe(0);
  });

  it("charges w x h repairs for a prose-only reply, and does not throw", () => {
    const parsed = parseDraft("I'm sorry, I can't draw pixel art.", SIZE_16, GAMEBOY);
    expect(parsed.repairs).toBe(16 * 16);
    expect(parsed.repairedRows).toEqual(ALL_ROWS_16);
    expect(parsed.grid).toEqual(Array(16).fill(".".repeat(16)));
    // No prompt reaches `parseDraft` — its signature is `(raw, size, palette)` —
    // so the subject falls back to empty here and `draft()` substitutes the
    // user's own prompt. See the `draft()` block below.
    expect(parsed.intent).toEqual({ subject: "" });
  });

  it("charges w x h repairs for an empty reply", () => {
    expect(parseDraft("", SIZE_16, GAMEBOY).repairs).toBe(256);
    expect(parseDraft("   \n  ", SIZE_32, PICO_8).repairs).toBe(1024);
  });

  it("charges w x h repairs for JSON that carries no rows array", () => {
    expect(parseDraft('{"intent":{"subject":"a fox"}}', SIZE_16, GAMEBOY).repairs).toBe(256);
  });

  it("names the exact rows it repaired", () => {
    const parsed = parseDraft(reply(shorten(CLEAN_16, [2, 5, 9], 1)), SIZE_16, GAMEBOY);
    expect(parsed.repairs).toBe(3);
    expect(parsed.repairedRows).toEqual([2, 5, 9]);
  });

  it("repairs an index past the end of the palette to transparent — spec A4", () => {
    const raw = reply(poke(CLEAN_16, 4, 5, "9"));
    const parsed = parseDraft(raw, SIZE_16, GAMEBOY);
    expect(parsed.repairs).toBe(1);
    expect(parsed.repairedRows).toEqual([4]);
    expect(parsed.grid[4][5]).toBe(".");

    // The same character against a 16-colour palette is not a defect at all.
    expect(parseDraft(raw, SIZE_16, PICO_8).repairs).toBe(0);
  });

  it("repairs an invalid character, uppercase included — spec §6.1", () => {
    expect(parseDraft(reply(poke(CLEAN_16, 3, 3, "x")), SIZE_16, GAMEBOY).repairs).toBe(1);
    expect(parseDraft(reply(poke(CLEAN_16, 3, 3, "A")), SIZE_16, PICO_8).repairs).toBe(1);
  });

  it("charges dropped rows past the canvas height — the unbounded ratio, spec A5", () => {
    const hundred = Array.from({ length: 100 }, (_, y) => (y < 16 ? CLEAN_16[y] : ".".repeat(16)));
    const parsed = parseDraft(reply(hundred), SIZE_16, GAMEBOY);
    expect(parsed.repairs).toBe((100 - 16) * 16); // 1344 charged against 256 cells
    expect(parsed.repairs / (16 * 16)).toBeGreaterThan(1);
  });

  it("pads a reply with too few rows", () => {
    const parsed = parseDraft(reply(CLEAN_16.slice(0, 3)), SIZE_16, GAMEBOY);
    expect(parsed.repairs).toBe(13 * 16);
    expect(parsed.grid).toHaveLength(16);
  });

  it("treats a bare rows array as the rows it plainly is", () => {
    const parsed = parseDraft(JSON.stringify(CLEAN_16), SIZE_16, GAMEBOY);
    expect(parsed.repairs).toBe(0);
    expect(parsed.intent).toEqual({ subject: "" });
  });

  it("takes an intent given as a bare string as the subject", () => {
    expect(parseDraft(reply(CLEAN_16, "a red fox"), SIZE_16, GAMEBOY).intent).toEqual({
      subject: "a red fox",
    });
  });

  it("never throws, whatever arrives", () => {
    const junk = [
      "",
      "{",
      "{}",
      "[]",
      "null",
      "3",
      '{"rows":null}',
      '{"rows":[1,2,3]}',
      '{"rows":{"0":"...."}}',
      '{"intent":[],"rows":["..."]}',
      "```json\nnot json\n```",
      "<think>hm, a fox</think>",
    ];
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
  it("returns nothing for a clean reply", () => {
    expect(describeDefects(reply(CLEAN_16, { subject: "a fox" }), SIZE_16, GAMEBOY)).toEqual([]);
  });

  it("names a length defect by its kind", () => {
    const lines = describeDefects(reply(shorten(CLEAN_16, [4], 4)), SIZE_16, GAMEBOY);
    expect(lines.join("\n")).toContain("row 4 had 12 characters, expected 16");
  });

  it("names an off-palette index by its kind, and by the palette", () => {
    const text = describeDefects(reply(poke(CLEAN_16, 4, 5, "9")), SIZE_16, GAMEBOY).join("\n");
    expect(text).toContain("row 4 used index 9");
    expect(text).toContain("gameboy");
    expect(text).toContain("4 colours");
  });

  it("keeps the two kinds distinct — the whole point of the retry prompt", () => {
    const lengthOnly = describeDefects(reply(shorten(CLEAN_16, [4], 4)), SIZE_16, GAMEBOY).join("");
    const paletteOnly = describeDefects(reply(poke(CLEAN_16, 4, 5, "9")), SIZE_16, GAMEBOY).join("");
    expect(lengthOnly).not.toContain("used index");
    expect(paletteOnly).not.toContain("characters, expected");
  });

  it("names uppercase separately from an unknown character", () => {
    expect(describeDefects(reply(poke(CLEAN_16, 2, 2, "A")), SIZE_16, PICO_8).join("")).toMatch(
      /lowercase/i,
    );
    expect(describeDefects(reply(poke(CLEAN_16, 2, 2, "$")), SIZE_16, PICO_8).join("")).toContain(
      "'$'",
    );
  });

  it("names a wrong row count", () => {
    const hundred = Array.from({ length: 100 }, () => ".".repeat(16));
    expect(describeDefects(reply(hundred), SIZE_16, GAMEBOY).join("")).toContain(
      "you returned 100 rows, expected exactly 16",
    );
    expect(describeDefects(reply(CLEAN_16.slice(0, 3)), SIZE_16, GAMEBOY).join("")).toContain(
      "you returned 3 rows, expected exactly 16",
    );
  });

  it("does not repeat itself once per row the model never sent", () => {
    expect(describeDefects(reply(CLEAN_16.slice(0, 3)), SIZE_16, GAMEBOY)).toHaveLength(1);
  });

  it("says so when nothing parseable arrived at all", () => {
    const text = describeDefects("I'm sorry, I can't draw pixel art.", SIZE_16, GAMEBOY).join("");
    expect(text).toMatch(/JSON/i);
    expect(text).toMatch(/rows/);
  });

  it("stays bounded on a catastrophic 64x64 reply", () => {
    const junk = Array.from({ length: 64 }, () => "x".repeat(3));
    expect(describeDefects(reply(junk), SIZE_64, GAMEBOY).length).toBeLessThanOrEqual(16);
  });
});

// ---------------------------------------------------------------------------
// draft — spec §6.2, §6.3, §7.4, §7.5
// ---------------------------------------------------------------------------

describe("draft", () => {
  it("returns a document that validates against SpriteDocSchema", async () => {
    const stub = createStubClient({ generate: [reply(CLEAN_16, { subject: "a fox" })] });
    const doc = await draft({ client: stub }, INPUT_16, cfg());

    expect(() => SpriteDocSchema.parse(doc)).not.toThrow();
    expect(doc.rows).toEqual(CLEAN_16);
    expect(doc.size).toEqual(SIZE_16);
    expect(doc.prompt).toBe("a sitting red fox");
    expect(doc.intent.subject).toBe("a fox");
    expect(stub.calls).toHaveLength(1);
  });

  it("fills the meta fields the draft owns — spec §7.5", async () => {
    const stub = createStubClient({ generate: [reply(CLEAN_16, { subject: "a fox" })] });
    const doc = await draft(
      { client: stub },
      INPUT_16,
      cfg({ models: { generator: "qwen3:8b", critic: "qwen3-vl:8b-instruct-q4_K_M" } }),
    );

    expect(doc.meta.round).toBe(1); // the draft is round 1
    expect(doc.meta.parentId).toBeNull();
    expect(doc.meta.generatorModel).toBe("qwen3:8b");
    expect(doc.meta.criticModel).toBe("qwen3-vl:8b-instruct-q4_K_M");
    expect(doc.meta.repairs).toBe(0);
    expect(doc.meta.repairedRows).toEqual([]);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.id.length).toBeGreaterThan(0);
    expect(Date.parse(doc.createdAt)).not.toBeNaN();
  });

  it("gives two drafts different identities", async () => {
    const stub = createStubClient({ generate: [reply(CLEAN_16)] });
    const a = await draft({ client: stub }, INPUT_16, cfg());
    const b = await draft({ client: stub }, INPUT_16, cfg());
    expect(a.id).not.toBe(b.id);
  });

  it("copies the palette rather than aliasing the frozen singleton", async () => {
    const stub = createStubClient({ generate: [reply(CLEAN_16)] });
    const doc = await draft({ client: stub }, INPUT_16, cfg());

    expect(doc.palette.id).toBe("gameboy");
    expect(doc.palette.colors).toEqual([...GAMEBOY.colors]);
    expect(doc.palette.colors).not.toBe(GAMEBOY.colors);
    // The library's array is frozen, so a doc holding that instance would throw
    // here — and every consumer would otherwise be editing every sprite.
    expect(() => doc.palette.colors.push("#ffffff")).not.toThrow();
    expect(GAMEBOY.colors).toHaveLength(4);
  });

  it("carries repairs AND repairedRows through to meta", async () => {
    // Three one-character-short rows: 3 / 256, far under the 0.2 threshold, so
    // the document is accepted *with* its repair record intact.
    const raw = reply(shorten(CLEAN_16, [2, 5, 9], 1));
    const stub = createStubClient({ generate: [raw] });
    const doc = await draft({ client: stub }, INPUT_16, cfg());

    const expected = parseDraft(raw, SIZE_16, GAMEBOY);
    expect(doc.meta.repairs).toBe(expected.repairs);
    expect(doc.meta.repairedRows).toEqual(expected.repairedRows);
    expect(doc.meta.repairs).toBe(3);
    expect(doc.meta.repairedRows).toEqual([2, 5, 9]);
    expect(stub.calls).toHaveLength(1);
  });

  it("falls back to the user's prompt when the model omitted the intent", async () => {
    const stub = createStubClient({ generate: [reply(CLEAN_16)] });
    const doc = await draft({ client: stub }, INPUT_16, cfg());
    expect(doc.intent.subject).toBe("a sitting red fox");
  });

  it("keeps a repaired off-palette draft inside its declared palette", async () => {
    // A `9` on a four-colour ramp. If `normalize` were called without
    // `palette.colors.length`, the character survives and `SpriteDocSchema`
    // refuses the document (spec A4) — so this fails loudly rather than shipping
    // a doc the renderer cannot colour.
    const stub = createStubClient({ generate: [reply(poke(CLEAN_16, 4, 5, "9"))] });
    const doc = await draft({ client: stub }, INPUT_16, cfg());
    expect(doc.rows[4][5]).toBe(".");
    expect(doc.meta.repairs).toBe(1);
    expect(doc.meta.repairedRows).toEqual([4]);
  });

  it("sends think: false on every call — spec A8", async () => {
    const stub = createStubClient({ generate: [OVER_THRESHOLD_16, reply(CLEAN_16)] });
    await draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 1 }));

    expect(stub.calls).toHaveLength(2);
    for (const call of stub.calls) {
      expect(call.method).toBe("generate");
      expect(call.think).toBe(false);
    }
  });

  it("binds to the configured generator model", async () => {
    const stub = createStubClient({ generate: [reply(CLEAN_16)] });
    await draft(
      { client: stub },
      INPUT_16,
      cfg({ models: { generator: "qwen3-vl:8b-instruct-q4_K_M", critic: "whatever:1b" } }),
    );
    expect(stub.calls[0].model).toBe("qwen3-vl:8b-instruct-q4_K_M");
  });

  it("sends the built prompt as system + user", async () => {
    const stub = createStubClient({ generate: [reply(CLEAN_16)] });
    await draft({ client: stub }, INPUT_16, cfg());

    const built = buildDraftPrompt({ prompt: "a sitting red fox", size: SIZE_16, palette: GAMEBOY });
    expect(stub.calls[0].system).toBe(built.system);
    expect(stub.calls[0].prompt).toBe(built.user);
  });

  it("throws on an unknown palette id before it calls the model", async () => {
    const stub = createStubClient({ generate: [reply(CLEAN_16)] });
    await expect(
      draft({ client: stub }, { ...INPUT_16, paletteId: "not-a-palette" }, cfg()),
    ).rejects.toThrow(/not-a-palette/);
    expect(stub.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // the retry path — spec §6.3
  // -------------------------------------------------------------------------

  it("retries exactly once when the first draft is over the threshold", async () => {
    const stub = createStubClient({
      generate: [OVER_THRESHOLD_16, reply(CLEAN_16, { subject: "a fox" })],
    });

    const doc = await draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 1 }));

    expect(stub.calls).toHaveLength(2); // not 3
    expect(doc.meta.repairs).toBe(0); // the accepted attempt's count, not the rejected one's
    expect(doc.rows).toEqual(CLEAN_16);
  });

  it("names the defects by kind in the retry prompt, not merely the row numbers", async () => {
    const stub = createStubClient({ generate: [OVER_THRESHOLD_16, reply(CLEAN_16)] });
    await draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 1 }));

    const retry = stub.calls[1].prompt ?? "";
    expect(retry).toContain("row 4 had 8 characters, expected 16");
    expect(retry).not.toContain("used index");
  });

  it("names an off-palette retry differently from a length retry", async () => {
    const offPalette = ALL_ROWS_16.reduce((rows, y) => poke(rows, y, 5, "9"), CLEAN_16);
    // 16 off-palette cells is 6% of the canvas, so the threshold is lowered to
    // reach the retry — the point here is the wording, not the arithmetic.
    const stub = createStubClient({ generate: [reply(offPalette), reply(CLEAN_16)] });
    await draft(
      { client: stub },
      INPUT_16,
      cfg({ maxDraftRetries: 1, repairRejectThreshold: 0.01 }),
    );

    const retry = stub.calls[1].prompt ?? "";
    expect(retry).toContain("row 4 used index 9");
    expect(retry).toContain("gameboy");
    expect(retry).not.toContain("characters, expected");
  });

  it("names the row count in the retry prompt when the model returned too many rows", async () => {
    const hundred = Array.from({ length: 100 }, (_, y) => (y < 16 ? CLEAN_16[y] : ".".repeat(16)));
    const stub = createStubClient({ generate: [reply(hundred), reply(CLEAN_16)] });
    await draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 1 }));

    expect(stub.calls[1].prompt).toContain("you returned 100 rows, expected exactly 16");
  });

  it("still sends the encoding rules and the subject on the retry", async () => {
    const stub = createStubClient({ generate: [reply([]), reply(CLEAN_16)] });
    await draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 1 }));

    const retry = `${stub.calls[1].system ?? ""}\n${stub.calls[1].prompt ?? ""}`;
    for (const hex of GAMEBOY.colors) expect(retry).toContain(hex);
    expect(retry).toContain("a sitting red fox");
    expect(retry).toContain('"rows"');
  });

  it("rejects above the threshold and accepts at it — the strict > of §6.3", async () => {
    // 51 / 256 = 0.19921875 (accepted); 52 / 256 = 0.203125 (rejected).
    const at51 = CLEAN_16.map((row, y) => (y < 3 ? "" : y === 3 ? row.slice(0, 13) : row));
    const at52 = CLEAN_16.map((row, y) => (y < 3 ? "" : y === 3 ? row.slice(0, 12) : row));
    expect(parseDraft(reply(at51), SIZE_16, GAMEBOY).repairs).toBe(51);
    expect(parseDraft(reply(at52), SIZE_16, GAMEBOY).repairs).toBe(52);

    const accepted = createStubClient({ generate: [reply(at51)] });
    const doc = await draft({ client: accepted }, INPUT_16, cfg());
    expect(accepted.calls).toHaveLength(1);
    expect(doc.meta.repairs).toBe(51);

    const rejected = createStubClient({ generate: [reply(at52), reply(CLEAN_16)] });
    await draft({ client: rejected }, INPUT_16, cfg());
    expect(rejected.calls).toHaveLength(2);

    // And exactly at it: 64 / 256 = 0.25 is not *greater than* 0.25, so this
    // draft is kept. `>` and `>=` differ only on this input.
    const at64 = CLEAN_16.map((row, y) => (y < 4 ? "" : row));
    expect(parseDraft(reply(at64), SIZE_16, GAMEBOY).repairs).toBe(64);
    const exact = createStubClient({ generate: [reply(at64)] });
    await draft({ client: exact }, INPUT_16, cfg({ repairRejectThreshold: 0.25 }));
    expect(exact.calls).toHaveLength(1);
  });

  it("raises DraftRejectedError carrying the last raw output after the second failure", async () => {
    const first = reply(shorten(CLEAN_16, ALL_ROWS_16, 8));
    const second = reply(shorten(CLEAN_16, ALL_ROWS_16, 12));
    const stub = createStubClient({ generate: [first, second] });

    const error = await draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 1 })).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DraftRejectedError);
    expect(error).toBeInstanceOf(Error);
    const rejected = error as DraftRejectedError;
    expect(rejected.name).toBe("DraftRejectedError");
    expect(rejected.raw).toBe(second); // the last attempt, the one §6.7 persists
    expect(rejected.repairs).toBe(16 * 12);
    expect(rejected.message).toContain(String(16 * 12));
    expect(stub.calls).toHaveLength(2);
  });

  it("routes a prose-only reply through the retry path rather than throwing", async () => {
    const prose = "I'm sorry, I can't draw pixel art. Would you like a description instead?";
    const stub = createStubClient({ generate: [prose, reply(CLEAN_16, { subject: "a fox" })] });

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
    expect((error as DraftRejectedError).raw).toBe(prose);
    expect((error as DraftRejectedError).repairs).toBe(256);
    expect(stub.calls).toHaveLength(2);
  });

  it("honours maxDraftRetries: 0 — one call, no retry", async () => {
    const stub = createStubClient({ generate: [OVER_THRESHOLD_16] });

    await expect(
      draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 0 })),
    ).rejects.toBeInstanceOf(DraftRejectedError);
    expect(stub.calls).toHaveLength(1);
  });

  it("honours maxDraftRetries: 2 — three calls", async () => {
    const stub = createStubClient({ generate: [OVER_THRESHOLD_16] });

    await expect(
      draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 2 })),
    ).rejects.toBeInstanceOf(DraftRejectedError);
    expect(stub.calls).toHaveLength(3);
    for (const call of stub.calls) expect(call.think).toBe(false);
  });

  it("rejects the 100-rows-on-a-16x16-canvas draft — the unbounded ratio, spec A5", async () => {
    // 1344 repairs against 256 cells while all 16 surviving rows are pristine.
    const hundred = Array.from({ length: 100 }, (_, y) => (y < 16 ? CLEAN_16[y] : ".".repeat(16)));
    const stub = createStubClient({ generate: [reply(hundred)] });

    const error = await draft({ client: stub }, INPUT_16, cfg({ maxDraftRetries: 0 })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DraftRejectedError);
    expect((error as DraftRejectedError).repairs).toBe(1344);

    // At the *maximum* threshold the ratio still has to reject it: 1344 / 256
    // is 5.25, not 1.0. A ratio clamped to 1 — the shape the arithmetic
    // naturally takes if `repairs` is mistaken for a fraction — accepts this
    // draft, and 84 rows of a sprite nobody asked for reach the linter.
    const permissive = createStubClient({ generate: [reply(hundred)] });
    await expect(
      draft(
        { client: permissive },
        INPUT_16,
        cfg({ maxDraftRetries: 0, repairRejectThreshold: 1 }),
      ),
    ).rejects.toBeInstanceOf(DraftRejectedError);
  });

  it("does not spend the retry budget on a transport failure — spec §7.1", async () => {
    // `DRAFTING → FAILED` on timeout / unreachable is a different edge from
    // `DRAFTING → DRAFTING` on repairs. Retrying an unreachable Ollama doubles
    // every failure's latency and tells the user nothing new.
    const stub = createStubClient({
      generate: [new OllamaUnreachableError("http://127.0.0.1:11434/api/generate")],
    });

    await expect(draft({ client: stub }, INPUT_16, cfg())).rejects.toBeInstanceOf(
      OllamaUnreachableError,
    );
    expect(stub.calls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // the area-scaled timeout — spec §6.8
  // -------------------------------------------------------------------------

  it("arms every call with an AbortSignal that has not already fired", async () => {
    const { client, signals } = probeClient((n) =>
      n === 1 ? OVER_THRESHOLD_16 : reply(CLEAN_16),
    );
    await draft({ client }, INPUT_16, cfg({ maxDraftRetries: 1 }));

    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
    expect(signals[0]).not.toBe(signals[1]); // a fresh deadline per attempt
  });

  it("scales the timeout DOWN on a 16x16 canvas — 800ms x 256/1024 = 200ms", async () => {
    const started = Date.now();
    await expect(
      draft({ client: hangingClient() }, INPUT_16, cfg({ callTimeoutMs: 800 })),
    ).rejects.toThrow("aborted");
    // An unscaled 800ms deadline cannot have fired by here; the 300ms of slack
    // is for a loaded machine, not for the arithmetic.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("scales the timeout UP on a 64x64 canvas — 60ms x 4096/1024 = 240ms", async () => {
    const settled = draft(
      { client: hangingClient() },
      { prompt: "a tree", size: SIZE_64, paletteId: "pico-8" },
      cfg({ callTimeoutMs: 60 }),
    ).then(
      () => "resolved",
      () => "rejected",
    );

    // An unscaled 60ms deadline would have aborted 90ms ago.
    expect(await Promise.race([settled, sleep(150)])).toBe("pending");
    expect(await settled).toBe("rejected");
  });

  // -------------------------------------------------------------------------
  // other canvases and palettes
  // -------------------------------------------------------------------------

  it("drafts a 32x32 pico-8 sprite", async () => {
    const stub = createStubClient({ generate: [reply(CLEAN_32, { subject: "a chest" })] });
    const doc = await draft(
      { client: stub },
      { prompt: "a treasure chest", size: SIZE_32, paletteId: "pico-8" },
      cfg(),
    );

    expect(() => SpriteDocSchema.parse(doc)).not.toThrow();
    expect(doc.rows).toHaveLength(32);
    expect(doc.palette.colors).toHaveLength(16);
    expect(doc.meta.repairs).toBe(0);
  });

  it("scales the threshold with the canvas rather than counting rows", async () => {
    // 48 repairs is 19% of a 16x16 canvas but 4.7% of a 32x32 one — the same
    // absolute count, two different verdicts.
    const stub = createStubClient({ generate: [reply(shorten(CLEAN_32, [0, 1, 2, 3], 12))] });
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
  //
  // `draftFailures` is an array, but `DraftRejectedError` carries only the last
  // attempt, so attempt 1's raw output was unrecoverable. Two rejections with
  // the same defect mean the prompt is wrong; two with different defects mean
  // the model is unstable — one entry makes those indistinguishable.
  // -------------------------------------------------------------------------

  it("reports every rejected attempt through onAttempt, each with its own raw", async () => {
    const first = reply(shorten(CLEAN_16, ALL_ROWS_16, 8));
    const second = reply(shorten(CLEAN_16, ALL_ROWS_16, 12));
    const stub = createStubClient({ generate: [first, second] });
    const failures: DraftFailure[] = [];

    await expect(
      draft({ client: stub, onAttempt: (f) => failures.push(f) }, INPUT_16, cfg()),
    ).rejects.toBeInstanceOf(DraftRejectedError);

    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.attempt)).toEqual([1, 2]);
    expect(failures[0].raw).toBe(first);
    expect(failures[1].raw).toBe(second);
    expect(failures[0].repairs).toBe(16 * 8);
    expect(failures[1].repairs).toBe(16 * 12);
    for (const failure of failures) {
      expect(() => DraftFailureSchema.parse(failure)).not.toThrow();
      expect(failure.reason).toContain("repairRejectThreshold");
    }
  });

  it("fires for a rejected attempt the retry then recovered from", async () => {
    const stub = createStubClient({ generate: [OVER_THRESHOLD_16, reply(CLEAN_16)] });
    const failures: DraftFailure[] = [];

    const doc = await draft({ client: stub, onAttempt: (f) => failures.push(f) }, INPUT_16, cfg());

    expect(doc.meta.repairs).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].attempt).toBe(1);
  });

  it("does not fire for an accepted attempt", async () => {
    const stub = createStubClient({ generate: [reply(CLEAN_16)] });
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
    const stub = createStubClient({ generate: [reply(hundred)] });
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
    const stub = createStubClient({ generate: [reply(CLEAN_16)] });
    await expect(draft({ client: stub }, INPUT_16, cfg())).resolves.toBeDefined();
  });
});
