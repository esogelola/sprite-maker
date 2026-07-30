/**
 * The bounded agentic loop — spec §6.6, §7.4. **The one place the model drives.**
 *
 * Every other stage hands the model a prompt and parses one reply. Here the
 * model chooses what to do next up to `maxReviseTurns` times, so the failure
 * modes are conversational rather than arithmetic: none of them changes a pixel
 * and all of them burn the cap. Four are load-bearing enough to state here.
 *
 * **1. The assistant's turn is appended INCLUDING its `tool_calls`, before the
 * tool results.** Verified against a live Ollama 0.32.1 and recorded in
 * `captures/2026-07-29-wave-5-tool-call-wire-format.txt`: if the assistant turn
 * is omitted, or serialized flat, Ollama's decoder drops the keys, the chat
 * template renders no call, the tool results arrive unmoored — and the model
 * re-issues the identical call. HTTP 200, no error, no warning. That is the
 * turn cap burning itself with nothing in the log to say so. `main/ollama.ts`
 * marshals the nesting; the only job left here is to actually append the turn.
 *
 * **2. A rejected call returns an error STRING, never throws.** A throw escapes
 * the loop and fails the whole round over one bad coordinate; a string is a
 * thing the model can read and correct itself from. The attempt still costs a
 * turn, so a model that cannot correct itself still terminates.
 *
 * **3. Numeric strings are coerced before validation** (amendment P10). A model
 * emitting JSON `"3"` where the contract says `3` is expressing well-formed
 * intent, and a technically-correct rejection of it burns turns for nothing.
 *
 * **4. A turn with zero tool calls counts against the cap.** This is the most
 * common `qwen3` tool-loop behaviour — narrating the edit instead of making it.
 * Counting only tool-firing turns spins forever on a message array that grows
 * but never changes shape, which is the worst available failure: no output, no
 * error, and no bound.
 *
 * **This returns a `Grid`, not a `SpriteDoc`** — spec §7.5. The pipeline
 * constructs every `meta`. A revised document built here would silently inherit
 * the draft's `id`, `round`, `createdAt` and `parentId: null`, so every round
 * of a session would share one identity and the lineage field would be
 * permanently inert. That was a real v1 defect, and the cheapest way to make it
 * unrepresentable is to never build a document in this file.
 */

import type { OllamaClient } from "@main/ollama";
import { NO_TOOL_CALL_NUDGE, REVISE_SYSTEM, buildRevisePrompt } from "@main/prompts/revise";
import {
  GridError,
  TRANSPARENT,
  charIndex,
  fillRow,
  indexChar,
  setPixel,
  type Grid,
} from "@shared/grid";
import { modelOptions } from "@shared/schema";
import type {
  ChatMessage,
  HarnessConfig,
  Issue,
  Size,
  SpriteDoc,
  ToolCall,
  ToolDef,
} from "@shared/schema";

/** The area `HarnessConfig.callTimeoutMs` is quoted against — spec §6.8. */
const TIMEOUT_REFERENCE_AREA = 32 * 32;

// ---------------------------------------------------------------------------
// the tools — spec §6.6
// ---------------------------------------------------------------------------

/**
 * `index` accepts a number or a string in the schema we hand the model.
 *
 * Not because the contract is loose — §6.6 says `number | "."` — but because
 * `"."` is a string and a single-member `anyOf` would make the transparent case
 * unrepresentable in the very schema that has to describe it. The narrowing
 * back to a character happens in `coerceIndex`, against the document's actual
 * palette, which is a bound no static schema here could state: `REVISE_TOOLS`
 * is a module constant and the palette is per-document.
 */
const INDEX_PARAM = {
  anyOf: [{ type: "integer" }, { type: "string" }],
  description: 'A palette index (0-9, a-f), or "." to clear the cell to transparent.',
};

export const REVISE_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "place_pixel",
      description:
        "Set one cell of the sprite. Coordinates are 0-based, with x counting " +
        "columns from the left and y counting rows from the top.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", description: "Column, 0-based, from the left edge." },
          y: { type: "integer", description: "Row, 0-based, from the top edge." },
          index: INDEX_PARAM,
        },
        required: ["x", "y", "index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fill_row",
      description:
        "Fill a horizontal span of row y, from x0 to x1 INCLUSIVE of x1 — " +
        "x0=2 and x1=5 writes four cells. x0 must not be greater than x1; " +
        "use x0=x1 to write a single cell.",
      parameters: {
        type: "object",
        properties: {
          y: { type: "integer", description: "Row, 0-based, from the top edge." },
          x0: { type: "integer", description: "First column of the span, inclusive." },
          x1: { type: "integer", description: "Last column of the span, INCLUSIVE." },
          index: INDEX_PARAM,
        },
        required: ["y", "x0", "x1", "index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Finish editing. Call this when the reported issues are fixed, or when " +
        "the sprite is already correct. Nothing else ends the session.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "One line describing what you changed.",
          },
        },
        required: ["summary"],
      },
    },
  },
];

/** Named once so the nudge, the unknown-tool error and the schema cannot drift. */
const TOOL_NAMES = REVISE_TOOLS.map((t) => t.function.name);

// ---------------------------------------------------------------------------
// argument coercion — amendment P10
// ---------------------------------------------------------------------------

/** A rejected argument, carrying the sentence the model gets back. */
class ArgumentError extends Error {}

/** Only whole decimal numbers, optionally signed and surrounded by spaces. */
const INT_RE = /^[+-]?\d+$/;

/**
 * An integer argument, accepting the numeric-string spelling.
 *
 * A fractional value is refused rather than rounded: `place_pixel(5.5, 7)`
 * names no cell, and silently choosing one of the two neighbours paints
 * somewhere the model did not ask for — the one outcome worse than an error
 * string, because nothing downstream can tell it happened. `setPixel` would
 * reject it anyway; catching it here just makes the message name the argument.
 */
function coerceInt(raw: unknown, tool: string, field: string): number {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new ArgumentError(
        `\`${tool}\` needs a whole number for \`${field}\`, got ${raw}.`,
      );
    }
    return raw;
  }
  if (typeof raw === "string" && INT_RE.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  if (raw === undefined || raw === null) {
    throw new ArgumentError(`\`${tool}\` requires \`${field}\`, which was missing.`);
  }
  throw new ArgumentError(
    `\`${tool}\` needs a whole number for \`${field}\`, got ${JSON.stringify(raw)}.`,
  );
}

/**
 * A palette index argument → the row character that spells it.
 *
 * Three spellings are accepted, and the third is the one worth justifying.
 *
 * - `"."` (or the number's absence of one) is transparent.
 * - A number, or its numeric-string form, goes through `indexChar` — so `10`
 *   becomes `a`, and an index outside the encoding raises a `GridError` the
 *   caller reports like any other.
 * - **A single hex character** — `"b"` — is taken as the index it spells.
 *
 * The third exists because the prompt renders the grid *as those characters*.
 * A model shown `bbbb` and asked to match that colour will answer `"b"`, which
 * is well-formed intent in exactly the sense amendment P10 describes. It is
 * also unambiguous: for `0`-`9` the digit and the decimal readings agree, and
 * for `a`-`f` there is no decimal reading at all. The palette bound is not
 * relaxed by any of this — `setPixel` still rejects `f` on a 4-colour document.
 */
function coerceIndex(raw: unknown, tool: string): string {
  if (typeof raw === "number") return indexChar(raw);

  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === TRANSPARENT) return TRANSPARENT;
    if (INT_RE.test(text)) return indexChar(Number.parseInt(text, 10));
    if (text.length === 1 && charIndex(text) >= 0) return text;
  }

  if (raw === undefined || raw === null) {
    throw new ArgumentError(`\`${tool}\` requires \`index\`, which was missing.`);
  }
  throw new ArgumentError(
    `\`${tool}\` needs a palette index (a whole number, or "." for transparent) ` +
      `for \`index\`, got ${JSON.stringify(raw)}.`,
  );
}

// ---------------------------------------------------------------------------
// error strings — spec §6.6
// ---------------------------------------------------------------------------

/**
 * A `GridError` as a sentence the model can correct itself from.
 *
 * Branches on `code`, never on the message text — that is what `GridError.code`
 * exists for, and it is why `shared/grid.ts` carries a machine-readable field
 * beside its prose. Each branch appends the bound that was violated, because
 * the underlying message states what went wrong and this is the layer that
 * knows what would have been right: the canvas is `w`×`h` here, and the palette
 * has this many entries.
 */
function describeGridError(error: GridError, doc: SpriteDoc): string {
  const { w, h } = doc.size;
  const size = doc.palette.colors.length;
  const lastIndex = indexChar(size - 1);

  switch (error.code) {
    case "out-of-bounds":
      return (
        `Error (out-of-bounds): ${error.message}. This canvas is ${w}x${h}, so ` +
        `x must be 0-${w - 1} and y must be 0-${h - 1}, and \`fill_row\` needs ` +
        `x0 <= x1 because x1 is inclusive.`
      );
    case "off-palette":
      return (
        `Error (off-palette): ${error.message}. Palette \`${doc.palette.id}\` has ` +
        `${size} colors, so \`index\` must be 0-${lastIndex}, or "." for transparent.`
      );
    case "bad-char":
      return (
        `Error (bad-char): ${error.message}. Give \`index\` as a whole number ` +
        `0-${lastIndex}, or "." for transparent.`
      );
  }
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

export interface ReviseDeps {
  client: OllamaClient;
  /**
   * Fired once per turn with the 1-based turn number, before the model is
   * asked. Wave 9 turns this into §7.1's `revise-turn` event: this is the
   * longest stage in the system, and in v1 it emitted nothing at all, so a
   * 40-turn loop showed one static label for minutes.
   */
  onTurn?: (n: number) => void;
}

export interface ReviseResult {
  /** The edited pixels. **Not** a document — see this file's header and §7.5. */
  grid: Grid;
  turns: number;
  hitCap: boolean;
  summary: string;
}

/**
 * One tool call, applied.
 *
 * Returns the grid it produced and the string the model gets back. Never
 * throws: every rejection this function can reach is converted here, which is
 * what keeps the caller's loop free of a try/catch whose absence would be
 * silent.
 */
function applyCall(
  call: ToolCall,
  grid: Grid,
  doc: SpriteDoc,
): { grid: Grid; result: string; summary?: string } {
  const paletteSize = doc.palette.colors.length;

  try {
    switch (call.name) {
      case "place_pixel": {
        const x = coerceInt(call.arguments.x, "place_pixel", "x");
        const y = coerceInt(call.arguments.y, "place_pixel", "y");
        const ch = coerceIndex(call.arguments.index, "place_pixel");
        // Through `shared/grid.ts`, never by splicing the row here: the agent
        // and the user's mouse click must hit identical validation (§6.1).
        return {
          grid: setPixel(grid, x, y, ch, paletteSize),
          result: `OK: (${x},${y}) is now \`${ch}\`.`,
        };
      }

      case "fill_row": {
        const y = coerceInt(call.arguments.y, "fill_row", "y");
        const x0 = coerceInt(call.arguments.x0, "fill_row", "x0");
        const x1 = coerceInt(call.arguments.x1, "fill_row", "x1");
        const ch = coerceIndex(call.arguments.index, "fill_row");
        return {
          grid: fillRow(grid, y, x0, x1, ch, paletteSize),
          result: `OK: row ${y}, columns ${x0}-${x1} inclusive (${x1 - x0 + 1} cells) are now \`${ch}\`.`,
        };
      }

      case "done": {
        const raw = call.arguments.summary;
        // Lenient on purpose. `done` is the only call that ends the loop, and
        // rejecting one for a missing summary spends the remaining turns
        // arguing about a field nothing validates — the round would then be
        // recorded as having hit the cap, which is a worse lie than a blank
        // summary.
        const summary = typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw);
        return { grid, result: "OK: finished.", summary };
      }

      default:
        return {
          grid,
          result:
            `Error (unknown-tool): there is no tool named \`${call.name}\`. ` +
            `The available tools are ${TOOL_NAMES.map((n) => `\`${n}\``).join(", ")}.`,
        };
    }
  } catch (error) {
    if (error instanceof GridError) {
      return { grid, result: describeGridError(error, doc) };
    }
    if (error instanceof ArgumentError) {
      return { grid, result: `Error (bad-argument): ${error.message}` };
    }
    throw error;
  }
}

/**
 * The per-turn deadline — spec §6.8, amendment A12.
 *
 * `max(callTimeoutFloorMs, callTimeoutMs × area / 32²)`. The area term is quoted
 * per 32×32 because a 64×64 canvas is four times the pixels and four times the
 * tokens, and one budget for both sizes either starves the large canvas or lets
 * the small one hang.
 *
 * **The floor is the amendment, and this stage is the one it was measured on.**
 * A 16×16 got `120000 × 256/1024 = 30 s`, which a real revise turn exceeds — so
 * every 16×16 run ended `FAILED` after round 1, which was the app's first real
 * generation (§6.8, A12). Cold-loading a 6-19 GB model costs 8-25 s of that
 * whatever is being edited. A12 words the rule generally; the floor was applied
 * in `draft.ts` first only because the other two stages were outside that wave's
 * whitelist.
 *
 * Exported so the floor is pinned directly rather than inferred from how long a
 * hanging client takes to abort: `RecordedCall` carries no signal, so the loop's
 * own deadline is otherwise only observable through wall clock.
 */
export function reviseTimeoutMs(cfg: HarnessConfig, size: Size): number {
  return Math.max(
    cfg.callTimeoutFloorMs,
    Math.round((cfg.callTimeoutMs * size.w * size.h) / TIMEOUT_REFERENCE_AREA),
  );
}

/**
 * Run the agent over `doc` until it calls `done` or runs out of turns.
 *
 * The contract the pipeline depends on: this **never** throws for anything the
 * model did — only for something the transport did. An unreachable Ollama
 * propagates, because §7.1 draws a `FAILED` edge out of `REVISING` and
 * swallowing it would report a successful round that never ran.
 */
export async function revise(
  deps: ReviseDeps,
  doc: SpriteDoc,
  issues: Issue[],
  cfg: HarnessConfig,
): Promise<ReviseResult> {
  // Copied, so the returned grid is never an alias of the caller's document
  // even on a round where the agent changed nothing.
  let grid: Grid = [...doc.rows];

  const messages: ChatMessage[] = [
    { role: "system", content: REVISE_SYSTEM },
    { role: "user", content: buildRevisePrompt(doc, issues, grid) },
  ];

  // §6.8 / A12 — see `reviseTimeoutMs`. This is a call site, and the floor
  // matters most here: 30 s was measured to be less than one revise turn.
  const timeoutMs = reviseTimeoutMs(cfg, doc.size);

  let turns = 0;
  let doneSummary: string | undefined;

  while (turns < cfg.maxReviseTurns) {
    turns++;
    deps.onTurn?.(turns);

    const turn = await deps.client.chatWithTools({
      model: cfg.models.generator,
      messages,
      tools: REVISE_TOOLS,
      // A13, on every turn. This is the stage with the most calls per round —
      // up to 40 — so one unseeded turn here is where a run that called itself
      // reproducible would actually diverge. `seed` is absent entirely when the
      // config's is `null`; it is never sent as a literal null.
      options: modelOptions(cfg),
      // Spec A8. `false`, and top-level — this is the stage where it matters
      // most: 40 turns times 3 rounds otherwise pay for a reasoning trace that
      // lands in a field nothing reads. Measured 86x token reduction.
      think: false,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (turn.toolCalls.length === 0) {
      // Counts against the cap (§6.6). The assistant's prose goes in too: drop
      // it and the transcript holds two consecutive user messages, and the
      // model — having no record of having said it — says it again.
      messages.push({ role: "assistant", content: turn.content });
      messages.push({ role: "user", content: NO_TOOL_CALL_NUDGE });
      continue;
    }

    // Behaviour 1: the assistant turn, WITH its calls, BEFORE the results.
    messages.push({
      role: "assistant",
      content: turn.content,
      tool_calls: turn.toolCalls,
    });

    for (const call of turn.toolCalls) {
      const applied = applyCall(call, grid, doc);
      grid = applied.grid;
      // Every call is answered, and every answer names the call it answers —
      // including the calls that came after `done` in the same turn. A tool
      // call left unanswered is a malformed transcript.
      messages.push({ role: "tool", content: applied.result, tool_call_id: call.id });
      if (applied.summary !== undefined) doneSummary = applied.summary;
    }

    // Broken after the whole turn, not mid-way through it, so edits that
    // travelled alongside `done` still land.
    if (doneSummary !== undefined) break;
  }

  const hitCap = doneSummary === undefined;

  return {
    grid,
    turns,
    hitCap,
    // Harness prose when the agent never gave any, rather than `""`: this
    // string is what the filmstrip and §13's bench CSV render for the round,
    // and a blank cell there reads as a missing record rather than as the
    // exhausted budget it is. `hitCap` sits beside it, so the two can never be
    // confused for the agent's own account.
    summary:
      doneSummary ??
      `Stopped at the ${cfg.maxReviseTurns}-turn cap without calling done().`,
  };
}
