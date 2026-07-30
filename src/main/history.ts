/**
 * `SessionHistory` construction and persistence — spec §6.7.
 *
 * Four rules govern this file, and each one is a defect the audit named:
 *
 * **1. `outcome` starts `"failed"`.** `persist` fires after every round, so an
 * in-progress artifact must not claim success: a crash mid-run would otherwise
 * leave a history reporting `"completed"`, and §11's first acceptance bar reads
 * that exact field. An interrupted run *is* a failed run, and only
 * `pipeline.ts`'s terminal write flips it.
 *
 * **2. `appendRound` computes `diffFromPrev` against the round's PARENT**, never
 * against the array-previous. `applyFeedback(roundIndex)` may branch from any
 * round, so the last array element is not necessarily the baseline. The value
 * the caller supplied is *ignored* and recomputed here, because this is the only
 * place that can see both documents and the lineage that connects them.
 *
 * **3. `null` and `[]` are different `diffFromPrev` values** (blocker B03).
 * `null` is "this round has no predecessor"; `[]` is "the revise stage changed
 * nothing". Collapsing them is what pointed §6.7's v1 prose at a bogus
 * `empty-diff` for every run, and any falsy check reintroduces it.
 *
 * **4. `completeRound` is phase two of the round lifecycle**, and it is not
 * optional. Ruling R2 snapshots a round at the top of each iteration, where
 * `revise` and `timings.reviseMs` describe a stage that has not run — so the
 * round is pushed with both `null` and *replaced in place* once the revise
 * transition completes. Without it, `turns`, `hitCap` and `summary` are
 * permanently `null` on every round: dead exactly as they were before the audit
 * added them, and three of the bench's CSV columns silently empty.
 *
 * Every function is pure and returns a new history — nothing here mutates its
 * argument, so a `persist` callback that snapshotted an earlier value still
 * holds what it was given. `saveHistory` is the one exception in kind: it
 * touches disk, and it is the only reason this module is not in `shared/`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { diff } from "@shared/grid";
import {
  RoundSchema,
  SessionHistorySchema,
  type HarnessConfig,
  type PixelDiff,
  type ReviseSummary,
  type Round,
  type SessionHistory,
} from "@shared/schema";

/**
 * A fresh history for a run that has not started — spec §6.7.
 *
 * Parsed rather than merely typed, which does three jobs at once: it deep-copies
 * the config so a later mutation of the caller's object cannot rewrite the
 * record, it applies §6.8's **strict** parse so a stale key (`criticUpscale`)
 * fails here rather than re-parsing later as a limit the run never used, and it
 * proves the starting shape is one `saveHistory` will accept.
 */
export function createHistory(sessionId: string, cfg: HarnessConfig): SessionHistory {
  return SessionHistorySchema.parse({
    schemaVersion: 1,
    sessionId,
    config: cfg,
    rounds: [],
    draftFailures: [],
    stopReason: null,
    // No terminal state has been reached. `pipeline.ts` advances this to the
    // state it most recently entered, so a mid-run artifact says how far the run
    // got rather than claiming a terminal state it never reached.
    finalState: "IDLE",
    // Rule 1.
    outcome: "failed",
    error: null,
    acceptedRound: null,
  });
}

/**
 * The round at a 0-based array index, or a `RangeError` naming `caller`.
 *
 * Exported because `pipeline.ts`'s `accept` and `applyFeedback` both speak the
 * renderer's 0-based index and both need the same guard. `Array.prototype.at`
 * is deliberately not used: it reads a negative index from the end, so
 * `accept(-1)` would silently accept the last round instead of reporting the
 * caller's mistake.
 */
export function roundAt(h: SessionHistory, index: number, caller: string): Round {
  if (!Number.isInteger(index) || index < 0 || index >= h.rounds.length) {
    throw new RangeError(
      `${caller}: no round at index ${index} — this history holds ${h.rounds.length}`,
    );
  }
  return h.rounds[index];
}

/**
 * Phase one: append a snapshot, computing `diffFromPrev` from the lineage.
 *
 * `r.diffFromPrev` is **ignored**; see rule 2. A round whose `meta.parentId`
 * names a document this history does not hold throws rather than recording a
 * `null` diff — a broken lineage is a bug in the pipeline, and the filmstrip is
 * defined as replaying these diffs, so a silently null one would surface as a
 * missing frame a long way from its cause.
 *
 * The result is parsed, so a 0-based round number is refused at the point of
 * writing rather than at save time, minutes later.
 */
export function appendRound(h: SessionHistory, r: Round): SessionHistory {
  const parentId = r.doc.meta.parentId;
  let diffFromPrev: PixelDiff[] | null = null;

  if (parentId !== null) {
    const parent = h.rounds.find((existing) => existing.doc.id === parentId);
    if (parent === undefined) {
      throw new Error(
        `appendRound: round ${r.round} names parent '${parentId}', which is not a ` +
          `document in this history (${h.rounds.length} rounds)`,
      );
    }
    diffFromPrev = diff(parent.doc.rows, r.doc.rows);
  }

  const round = RoundSchema.parse({ ...r, diffFromPrev });
  return { ...h, rounds: [...h.rounds, round] };
}

/**
 * Phase two: fill in what the revise stage did — spec §6.7.
 *
 * Replaces `rounds[index]` in place. `reviseMs: 0` and `turns: 0` are values,
 * not absences: the patch is applied unconditionally rather than field by field
 * behind truthiness checks.
 */
export function completeRound(
  h: SessionHistory,
  index: number,
  patch: { revise: ReviseSummary; reviseMs: number },
): SessionHistory {
  const existing = roundAt(h, index, "completeRound");

  const completed = RoundSchema.parse({
    ...existing,
    revise: patch.revise,
    // Spread rather than replaced: `draftMs` and `critiqueMs` were measured in
    // phase one and this stage knows nothing about them.
    timings: { ...existing.timings, reviseMs: patch.reviseMs },
  });

  const rounds = h.rounds.slice();
  rounds[index] = completed;
  return { ...h, rounds };
}

/**
 * Write the history to `<dir>/<sessionId>.json` and return the path.
 *
 * Validated before writing, not after: §11's bars and §8's status bar read a
 * *reloaded* artifact, so a history that cannot round-trip must fail while the
 * run that produced it is still on the stack. That is also what catches an
 * `acceptedRound` holding the un-converted 0-based index.
 *
 * `sessionId` becomes a filename, so it is refused if it could name anything
 * outside `dir`.
 */
export async function saveHistory(h: SessionHistory, dir: string): Promise<string> {
  const validated = SessionHistorySchema.parse(h);

  if (/[/\\]/.test(validated.sessionId) || validated.sessionId === "..") {
    throw new Error(
      `saveHistory: sessionId '${validated.sessionId}' is not a legal filename — ` +
        "it must not contain a path separator",
    );
  }

  await mkdir(dir, { recursive: true });
  const path = join(dir, `${validated.sessionId}.json`);
  // Pretty-printed and newline-terminated: these are committed as bench evidence
  // and read by hand when a run is being explained.
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return path;
}
