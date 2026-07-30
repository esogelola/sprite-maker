/**
 * The revise stage's prompts — spec §7.4.
 *
 * Separated from `main/revise.ts` because the loop and the words are tuned on
 * different schedules and by different evidence: the loop is pinned by the
 * transcript tests, the wording by watching a real `qwen3:8b` burn turns. Every
 * export here is a pure function of its arguments — no client, no config, no
 * clock — so a prompt can be diffed in a test without standing a loop up.
 *
 * §7.4 gives this stage three things to say: **the filtered issue list, the
 * current grid as text, and three tools.** The tools are marshalled by
 * `REVISE_TOOLS`; this module supplies the other two, plus the two pieces of
 * context a bare grid cannot carry — what the sprite is supposed to be, and
 * which palette indices actually exist.
 */

import type { Grid } from "@shared/grid";
import type { Issue, PaletteRef, SpriteDoc } from "@shared/schema";

/**
 * The standing instructions.
 *
 * Deliberately short. The per-call user message carries everything that varies,
 * and a long system block is re-sent on all 40 turns — it is the one string in
 * the system whose cost is multiplied by the turn cap.
 *
 * Two rules earn their place by being the ones a model gets wrong unprompted:
 * `x1` is inclusive (a half-open reading silently paints one cell short on
 * every fill), and `done` is *mandatory* rather than implied by having nothing
 * left to do — a model that simply stops talking hits the cap, and the round
 * is then recorded as having exhausted its turns.
 */
export const REVISE_SYSTEM = [
  "You are a pixel-art editor. You edit an existing sprite by calling tools.",
  "",
  "The canvas is a grid of single characters. `.` is transparent; the digits",
  "`0`-`9` and letters `a`-`f` are palette indices. Coordinates are 0-based:",
  "x counts columns from the left, y counts rows from the top.",
  "",
  "Rules:",
  "- Make the smallest edit that fixes an issue. You are correcting a sprite,",
  "  not redrawing it.",
  "- `fill_row`'s x1 is INCLUSIVE: x0=2, x1=5 writes four cells.",
  "- Only use palette indices the sprite's palette actually has.",
  "- When you are finished, you MUST call `done` with a one-line summary of",
  "  what you changed. Nothing else ends your turn.",
].join("\n");

/**
 * What to say when a turn fires no tool at all — spec §6.6.
 *
 * The most common `qwen3` tool-loop behaviour is to narrate the edit instead of
 * making it. Naming the three tools verbatim is the whole content of the nudge:
 * the model has not forgotten what to do, it has forgotten that doing it means
 * emitting a call.
 */
export const NO_TOOL_CALL_NUDGE = [
  "That turn made no tool call, so the sprite is unchanged.",
  "Reply with a tool call and no prose. The tools are `place_pixel`,",
  "`fill_row` and `done`. If the sprite is already correct, call `done`.",
].join("\n");

/** `w` wide, so a caller reading a row index does not have to count. */
function padIndex(n: number, width: number): string {
  return String(n).padStart(width, " ");
}

/**
 * The grid as text, with coordinate rulers.
 *
 * Every issue names a region in `(x, y)`, and the model has to find those cells
 * in a block of up to 64 identical-looking characters. Without rulers that is
 * counting, which is the single thing a language model is worst at and the
 * reason v1's agent edited the wrong row. The header repeats the units digit of
 * `x` and — above 16 wide — the tens digit above it, so a column can be read
 * off two characters rather than counted to.
 */
export function renderGridForPrompt(grid: Grid): string {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  const gutter = String(Math.max(h - 1, 0)).length;
  const pad = " ".repeat(gutter);

  const lines: string[] = [];
  if (w > 10) {
    const tens = Array.from({ length: w }, (_, x) =>
      x >= 10 ? String(Math.floor(x / 10)) : " ",
    ).join("");
    lines.push(`${pad}  ${tens}`);
  }
  const units = Array.from({ length: w }, (_, x) => String(x % 10)).join("");
  lines.push(`${pad}  ${units}`);
  grid.forEach((row, y) => lines.push(`${padIndex(y, gutter)} |${row}`));
  return lines.join("\n");
}

/**
 * The palette as an indexed table.
 *
 * The hex colours are here because "the outline is too dark" is only
 * actionable if the agent can tell which index is the dark one, and the index
 * ceiling is stated in full because it is the bound `setPixel` rejects against
 * — a 4-colour `gameboy` document refuses index 9, and a model that was never
 * told so will spend turns rediscovering it one error string at a time.
 */
export function renderPaletteForPrompt(palette: PaletteRef): string {
  const HEX_CHARS = "0123456789abcdef";
  const rows = palette.colors.map((hex, i) => `  ${HEX_CHARS[i]} = ${hex}`);
  return [
    `Palette \`${palette.id}\`, ${palette.colors.length} colors ` +
      `(valid indices 0-${HEX_CHARS[palette.colors.length - 1]}, plus \`.\` for transparent):`,
    ...rows,
  ].join("\n");
}

/**
 * One issue, as a line the agent can act on.
 *
 * `suggest` is printed only when it is non-empty, and labelled as a suggestion
 * rather than an instruction. §6.4 *empties* a low-confidence suggestion
 * instead of dropping the whole issue, precisely so the agent keeps the problem
 * and loses only the guess — printing `suggestion: ` with nothing after it
 * would hand that guess back as a blank the model feels obliged to fill.
 */
function renderIssue(issue: Issue, n: number): string {
  const [x0, y0, x1, y1] = issue.region;
  const head =
    `${n}. [${issue.severity}] region (${x0},${y0})-(${x1},${y1}) — ${issue.issue}`;
  return issue.suggest.length > 0 ? `${head}\n   suggestion (advisory): ${issue.suggest}` : head;
}

/**
 * The per-round user message: intent, palette, grid, issues.
 *
 * The empty issue list is a real case rather than a guard: §7.3 routes user
 * feedback in as a synthetic issue, and a round can reach `REVISING` with every
 * critic finding filtered out below the confidence floor. Saying so plainly and
 * asking for `done` is what keeps that round from spending forty turns looking
 * for a problem nobody reported.
 */
export function buildRevisePrompt(doc: SpriteDoc, issues: Issue[], grid: Grid): string {
  const facing = doc.intent.facing === undefined ? "" : `, ${doc.intent.facing} view`;
  const style = doc.intent.style === undefined ? "" : `, ${doc.intent.style}`;

  const sections = [
    `Sprite: ${doc.intent.subject}${style}${facing} — ${doc.size.w}x${doc.size.h}.`,
    ...(doc.intent.notes === undefined ? [] : [`Notes: ${doc.intent.notes}`]),
    "",
    renderPaletteForPrompt(doc.palette),
    "",
    "Current sprite:",
    "",
    renderGridForPrompt(grid),
    "",
  ];

  const body =
    issues.length === 0
      ? [
          "No issues were reported for this sprite.",
          "If it already matches the description, call `done` immediately.",
        ]
      : [
          `${issues.length} issue${issues.length === 1 ? "" : "s"} to fix, highest severity first:`,
          "",
          ...issues.map((issue, i) => renderIssue(issue, i + 1)),
          "",
          "Fix them with `place_pixel` and `fill_row`, then call `done`.",
        ];

  return [...sections, ...body].join("\n");
}
