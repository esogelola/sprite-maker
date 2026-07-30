/**
 * The critic's prompts — spec §4.4, §4.5, §7.4.
 *
 * Separate from `main/critique.ts` because the two answer to different things:
 * `critique.ts` owns the repair table and the reprompt budget, which are pinned
 * by §6.4 and tested by construction; this file owns the wording, which is
 * tuned against a real model and changes whenever the capture in
 * `docs/superpowers/specs/captures/` drifts.
 *
 * Three decisions here are load-bearing rather than cosmetic:
 *
 * **The grid goes in the user turn, in full, unabbreviated.** §4.4 splits the
 * job: the image supplies gestalt ("does this read as a fox?"), the text
 * supplies coordinates. Asking a vision encoder to derive `(11, 6)` from a
 * resampled thumbnail is where this design would otherwise fail, so every row
 * is sent verbatim with a printed column ruler beside it.
 *
 * **The system turn carries no per-document fact.** It is one constant string,
 * which is what lets `tests/main/critique.test.ts` assert the whole output
 * contract in one place, and what keeps a prompt-cache key stable across rounds.
 *
 * **The linter's findings are included and marked as already known.** §4.2
 * splits the review: orphan pixels and contrast pairs are decidable and are
 * computed exactly, so a VLM re-deriving them spends its attention badly and
 * hallucinates coordinates for findings we already hold.
 */

import { pickCriticBackground } from "@main/render";
import type { LintReport, LintWarning, SpriteDoc } from "@shared/schema";

/** How many cells of one warning are worth naming before the list stops earning. */
const MAX_LISTED_CELLS = 12;

/** How much of a rejected response to quote back to the critic on the reprompt. */
const MAX_QUOTED_RAW = 1200;

/**
 * The output contract, verbatim and per-document-fact-free.
 *
 * The two confidence fields get a paragraph rather than a clause because
 * collapsing them is the failure §6.4 names: one number written into both
 * destroys the *"something is definitely wrong here, but my fix is a guess"*
 * signal that the whole two-tier filter exists to carry.
 */
export const CRITIQUE_SYSTEM = `You are a pixel-art critic. You review one low-resolution sprite and reply with a single JSON object.

You are shown the same sprite twice:
- an IMAGE, upscaled with nearest-neighbour sampling, so one sprite pixel is one flat square block. Judge from it what the sprite READS AS: silhouette, proportion, whether the subject is recognisable at a glance.
- the exact INDEX GRID as text, one line per row. Take every coordinate you report from the grid. Never estimate a coordinate from the image.

Coordinates: (0, 0) is the top-left cell, x increases to the right, y increases downward. A region is [x0, y0, x1, y1] and is INCLUSIVE on all four bounds. Every region must lie inside the canvas.

Reply with exactly this JSON object and nothing else — no prose, no explanation, no markdown fence:

{
  "readsAs": "what the sprite actually looks like, in a few words",
  "matchesIntent": true,
  "overall": 3,
  "issues": [
    {
      "id": "short-slug",
      "region": [x0, y0, x1, y1],
      "severity": "high",
      "issue": "what is wrong here, in one sentence",
      "suggest": "what you would do about it",
      "confidence": 0.9,
      "suggestConfidence": 0.4
    }
  ]
}

Field rules:
- "readsAs" describes what you SEE, not what was asked for. If it reads as a blob, say so.
- "matchesIntent" is whether the sprite depicts the requested subject.
- "overall" is an integer from 1 (unusable) to 5 (ship it).
- "severity" is one of "high", "medium", "low".
- "confidence" answers: IS THE PROBLEM REAL? How sure are you that what you are pointing at is actually wrong.
- "suggestConfidence" answers: IS THIS FIX CORRECT? How sure are you that your proposed change is the right one.

Those are two different questions and they take two different numbers. The most useful finding you can give is a high "confidence" with a low "suggestConfidence": the problem is definitely there, your fix is only a guess. Never raise "suggestConfidence" to match "confidence", and if you have no fix in mind, send "suggest": "" with "suggestConfidence": 0.

Reporting rules:
- At most 8 issues, most important first.
- Report only what you can point at with a region. No general advice.
- Every issue must be visible in the grid you were given. Do not invent detail the resolution cannot hold.
- An empty "issues" array is a valid and welcome answer for a sprite that works.`;

/** `pico-8` index 11 prints as `b` — the row encoding of §6.1. */
const HEX_CHARS = "0123456789abcdef";

/** `0  #000000`, one line per entry the sprite could reference. */
function paletteTable(doc: SpriteDoc): string {
  return doc.palette.colors
    .map((hex, index) => `  ${HEX_CHARS[index]}  ${hex}`)
    .join("\n");
}

/**
 * The grid, with a two-line column ruler and a row index on every line.
 *
 * The ruler is not decoration: the critic's only job that the linter cannot do
 * is to name *where* a compositional problem is, and a 32-wide run of `.` and
 * hex digits has no landmarks in it at all.
 */
function gridBlock(doc: SpriteDoc): string {
  const { w } = doc.size;
  const gutter = "   ";
  const tens = Array.from({ length: w }, (_, x) =>
    x < 10 ? " " : String(Math.floor(x / 10)),
  ).join("");
  const ones = Array.from({ length: w }, (_, x) => String(x % 10)).join("");
  const rows = doc.rows.map((row, y) => `${String(y).padStart(2, "0")} ${row}`);
  return [`${gutter}${tens}`, `${gutter}${ones}`, ...rows].join("\n");
}

/** `(3,4) (3,5) (3,6)`, capped — a hundred coordinates is not a finding. */
function cellList(warning: LintWarning): string {
  if (warning.cells.length === 0) return "";
  const shown = warning.cells
    .slice(0, MAX_LISTED_CELLS)
    .map(([x, y]) => `(${x},${y})`)
    .join(" ");
  const rest = warning.cells.length - MAX_LISTED_CELLS;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

/** What the deterministic half of the review already knows — §4.2. */
function lintBlock(report: LintReport): string {
  const { coverage, paletteUsed, orphanCount, symmetryScore } = report.metrics;
  const metrics =
    `coverage ${(coverage * 100).toFixed(1)}% non-transparent, ` +
    `${paletteUsed} palette entries used, ` +
    `${orphanCount} orphan pixels, ` +
    `symmetry ${symmetryScore.toFixed(2)} about the vertical axis`;

  if (report.warnings.length === 0) {
    return `No deterministic warnings.\n${metrics}`;
  }

  const lines = report.warnings.map((warning) => {
    const cells = cellList(warning);
    return `- ${warning.code}: ${warning.message}${cells === "" ? "" : ` — at ${cells}`}`;
  });
  return [...lines, metrics].join("\n");
}

/** `subject`, plus whichever optional fields the intent actually carries. */
function intentBlock(doc: SpriteDoc): string {
  const { subject, style, facing, notes } = doc.intent;
  const lines = [`SUBJECT: ${subject}`];
  if (style !== undefined) lines.push(`STYLE: ${style}`);
  if (facing !== undefined) lines.push(`FACING: ${facing}`);
  if (notes !== undefined) lines.push(`NOTES: ${notes}`);
  return lines.join("\n");
}

/**
 * The critic's two turns — spec §7.4.
 *
 * `system` is `CRITIQUE_SYSTEM` unchanged; `user` carries the intent, the
 * palette, the linter's findings and the grid. The image is attached by
 * `critique()`, which owns the scale (§6.8) and the background (§4.5).
 */
export function buildCritiquePrompt(
  doc: SpriteDoc,
  lint: LintReport,
): { system: string; user: string } {
  const { w, h } = doc.size;
  const background = pickCriticBackground(doc);

  const user = [
    intentBlock(doc),
    "",
    `CANVAS: ${w}×${h} cells, palette "${doc.palette.id}" (${doc.palette.colors.length} colours)`,
    // §4.5: the model is looking at a composited image, so telling it the
    // background is a background is the difference between "the sprite sits on
    // a grey field" and "the artist painted a grey field".
    `Transparent cells are written "." in the grid. For the image only, they have been ` +
      `composited onto the flat background colour ${background}; that colour is not part of ` +
      `the sprite and must never be reported as an issue.`,
    "",
    "PALETTE (index, colour)",
    paletteTable(doc),
    "",
    "DETERMINISTIC LINTER FINDINGS — already known, do not repeat them. Spend your attention on what a linter cannot see: shape, readability, proportion, colour choice.",
    lintBlock(lint),
    "",
    `INDEX GRID (${h} rows of ${w} cells, row index on the left, column ruler on top)`,
    gridBlock(doc),
    "",
    "Review this sprite. Reply with the JSON object described in your instructions and nothing else.",
  ].join("\n");

  return { system: CRITIQUE_SYSTEM, user };
}

/**
 * The single reprompt §6.4 allows — the original ask, plus what went wrong.
 *
 * `vision` is one-shot, so the whole task has to be restated: the model has no
 * transcript and cannot be told "try again". The rejected output is quoted back
 * because "your reply was not JSON" is unactionable next to the reply itself.
 *
 * The closing line asks for a *critique* and not merely for well-formed JSON,
 * which is a correctness constraint rather than a stylistic one. `{"degraded":
 * false, "issues": []}` is a valid document and §7.2 reads it as
 * `no-high-severity` — the sprite passed. An earlier draft of this line told a
 * confused model to fall back on "an empty array for issues", which invited
 * exactly that: a critique that did not happen, recorded as a critique that
 * found nothing. §6.4 does bless an empty `issues` array — but as a verdict on a
 * sprite that works, never as the cheap way out of a reprompt. Uncertainty is
 * what the two confidence numbers are for, so the line spends its last clause
 * pointing at them instead.
 */
export function buildCritiqueReprompt(user: string, previous: string, detail: string): string {
  const quoted =
    previous.length > MAX_QUOTED_RAW
      ? `${previous.slice(0, MAX_QUOTED_RAW)}… (truncated)`
      : previous;

  return [
    user,
    "",
    "---",
    "",
    "YOUR PREVIOUS REPLY COULD NOT BE USED.",
    `Reason: ${detail}`,
    "",
    "It began:",
    quoted,
    "",
    "Reply again with ONLY the JSON object described in your instructions: no prose before it, no prose after it, no markdown fence. Every field is required, and every one of them must be your actual judgement of the sprite above: look at the image and the grid again and report what you see. If you are unsure of a finding, keep it and give it a low \"confidence\" — that is what the field is for. Do not return a report you do not mean.",
  ].join("\n");
}
