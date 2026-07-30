/**
 * The draft stage's prompt text — spec §7.4, plan Wave 6.
 *
 * Separated from `main/draft.ts` because prompt wording and parse/repair logic
 * change for entirely different reasons: the parser moves when the contract
 * moves, the prompt moves when a model turns out to misread it. Keeping them in
 * one file means every prompt tweak re-reviews the repair arithmetic.
 *
 * §7.4 pins the contents: encoding rules, canvas dimensions, the palette as an
 * indexed table, and two short worked examples. Three things about the wording
 * are load-bearing:
 *
 * **1. The palette table names the palette actually in use, not the encoding.**
 * `gameboy` has four colours, so `0`-`3` is the whole vocabulary and `9` is a
 * character that cannot mean anything. Telling the model `0`-`f` and then
 * repairing every index past 3 to transparent (spec A4) charges the repair
 * budget for a rule it was never given.
 *
 * **2. The examples are 8×8 and say so.** A worked example at the real canvas
 * size would be 64 rows of 64 characters at 64×64 — more prompt than sprite —
 * and an example whose size is left unstated is one the model may copy.
 *
 * **3. `think: false` lives on the request, not in this text** (spec A8). The
 * `/no_think` prefix v2 specified was measured inert, and worse than inert on
 * one prompt, so there is deliberately no such prefix here.
 */

import { indexChar } from "@shared/grid";
import type { Palette } from "@shared/palettes";
import type { Intent, Size } from "@shared/schema";

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

/** A worked example — the exact JSON object the model is asked to imitate. */
export interface DraftExample {
  intent: Intent;
  rows: string[];
}

/**
 * §7.4's "two short worked examples", as data rather than as prose.
 *
 * Exported so `tests/main/draft.test.ts` can hold them to the encoding the
 * prompt states — an example with a 7-character row or an `A` in it teaches the
 * defect to every draft, and inside a template literal nothing would notice.
 *
 * Both are 8×8 and use only indices 0-3, which every bundled palette carries
 * (§6.1a puts the floor at four entries), so neither example can demonstrate an
 * off-palette character to a `gameboy` draft.
 */
export const DRAFT_EXAMPLES: readonly DraftExample[] = [
  {
    intent: { subject: "a small tree", style: "chunky outline", facing: "front" },
    rows: [
      "..0000..",
      ".011110.",
      "01111110",
      "01121110",
      ".011110.",
      "...22...",
      "...22...",
      "..2222..",
    ],
  },
  {
    intent: { subject: "a red heart", facing: "front" },
    rows: [
      ".00..00.",
      "01100110",
      "01211210",
      "01111110",
      ".011110.",
      "..0110..",
      "...00...",
      "........",
    ],
  },
];

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
 * The draft prompt — spec §7.4.
 *
 * The palette appears twice, in the system half as a table and in the user half
 * as one line. That is deliberate rather than sloppy: the user half is the last
 * thing the model reads before it answers, and the single most common draft
 * defect is an index the palette does not have.
 */
export function buildDraftPrompt(input: DraftPromptInput): BuiltPrompt {
  const { size, palette } = input;
  const last = lastChar(palette);
  const count = palette.colors.length;

  const system = [
    "You are a pixel-art generator. You draw one sprite as a grid of text, one character per pixel.",
    "",
    "CANVAS",
    `The canvas is ${size.w} wide and ${size.h} tall. Return exactly ${size.h} rows of exactly ${size.w} characters, top row first.`,
    "",
    "ENCODING",
    "- '.' is transparent — nothing is drawn there.",
    "- '0'-'f' name a palette colour by index.",
    "- Lowercase only: 'A'-'F' are rejected, not corrected.",
    "- Each row is one plain string. No spaces, no separators, no comments, no coordinates.",
    "",
    `PALETTE — ${palette.id}, ${count} colours. The only valid characters are '.' and 0-${last}.`,
    paletteTable(palette),
    `An index above ${last} does not exist in this palette; any cell using one is erased.`,
    "",
    "OUTPUT",
    "Reply with one JSON object and nothing else — no prose, no explanation, no markdown fence:",
    `{"intent":{"subject":"...","style":"...","facing":"front|side|three-quarter","notes":"..."},"rows":[${size.h} strings of ${size.w} characters]}`,
    '"subject" is required. "style", "facing" and "notes" are optional — omit a field rather than guessing at it.',
    "",
    `EXAMPLES — these use an 8x8 canvas; yours is ${size.w}x${size.h}, so it needs ${size.h} rows of ${size.w} characters.`,
    ...DRAFT_EXAMPLES.map((example) => JSON.stringify(example)),
    "",
    "DRAWING",
    `- Fill the canvas: the subject should occupy most of the ${size.w}x${size.h} area.`,
    "- Outline the subject with the darkest index available, then shade the inside with at least two more.",
    "- Keep the silhouette readable at this size. Drop detail rather than blurring it.",
    "- Leave the space around the subject transparent.",
  ].join("\n");

  const user = [
    `Draw: ${input.prompt}`,
    "",
    `Canvas ${size.w}x${size.h} — exactly ${size.h} rows of exactly ${size.w} characters.`,
    `Palette ${palette.id} (${count} colours): ${paletteInline(palette)}. Valid characters: '.' and 0-${last}.`,
    `Reply with the JSON object only: {"intent":{"subject":"..."},"rows":[${size.h} strings of ${size.w} characters]}`,
  ].join("\n");

  return { system, user };
}

export interface RetryPromptInput extends DraftPromptInput {
  /** Defect lines from `describeDefects` — named by kind, per spec §6.3. */
  defects: string[];
}

/**
 * The retry prompt — spec §6.3's "the specific defects named back to the model".
 *
 * The whole draft prompt again, plus the defect list. `generate` is single-shot
 * and carries no conversation, so a retry that sent only the complaint would be
 * asking a model with no memory to fix a sprite it cannot see the rules for.
 *
 * The defects arrive already worded by kind: "row 4 used index 9, but palette
 * 'gameboy' has 4 colours" is a different instruction from "row 4 had 12
 * characters, expected 16", and `repairedRows` alone cannot tell them apart.
 */
export function buildRetryPrompt(input: RetryPromptInput): BuiltPrompt {
  const base = buildDraftPrompt(input);
  const defects =
    input.defects.length > 0
      ? input.defects.map((line) => `- ${line}`).join("\n")
      : "- too many cells had to be repaired";

  const user = [
    base.user,
    "",
    "YOUR PREVIOUS REPLY WAS REJECTED. Too much of it had to be repaired.",
    "Defects found:",
    defects,
    "",
    "Draw the whole sprite again as one JSON object, fixing every defect above. Same canvas, same palette, same rules.",
  ].join("\n");

  return { system: base.system, user };
}
