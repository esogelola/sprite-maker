/**
 * The state machine — spec §7.1–§7.5, §6.7, §9.
 *
 * Five rules govern this file. Each one is a defect the v1 design shipped, and
 * each one is unrecoverable later: no wave downstream can add a field, and the
 * artifact this file writes is what §11's acceptance bars and §8's status bar
 * read after a reload.
 *
 * **1. The round is snapshotted at the TOP of every iteration** (ruling R2),
 * after `CRITIQUING` and before any revision — and **written in two phases**. At
 * snapshot time `revise` and `timings.reviseMs` describe a stage that has not
 * run, so the round is pushed with both `null` and replaced in place once the
 * revise transition completes, followed by a second `persist`. v1 snapshotted
 * only on the `REVISING` exit, so a run converging on its first critique
 * returned `rounds: []` — nothing to export, accept, render or measure — and a
 * `Round` held a post-revise `doc` beside a pre-revise `lint` and `critique`, so
 * the dock highlighted issue regions against pixels that had already changed.
 * Buffering the round until after revision is foreclosed three ways: R2 requires
 * a snapshot on every iteration, so deferring reintroduces `rounds: []` when
 * `REVISING` fails; the `round` event is the only source of a mid-run filmstrip
 * frame during the longest stage; and the bench reads `reviseMs` and `hitCap`
 * off `Round`, not off wall-clocked events.
 *
 * **2. `empty-diff` is `diff(docBefore, docAfter)` on the revise transition**,
 * never a read of the stored `diffFromPrev` — which is `null` on round 1, so a
 * literal reading of §6.7's v1 prose stopped every run right after the draft
 * with a bogus reason.
 *
 * **3. Feedback re-enters at `REVISING`** (§7.3) as a synthetic high-severity
 * issue, and the resulting round's `parentId` points at the round the user was
 * looking at — which may not be the last. v1 drew the edge pointing *into*
 * `AWAITING_USER` and drew no edge at all for the transition §7.3 describes.
 *
 * **4. `diffFromPrev` is computed against the parent**, not the array-previous.
 * `history.ts` owns that; this file's job is to set `meta.parentId` correctly so
 * it can.
 *
 * **5. This file constructs every `meta` except the draft's** (§7.5): fresh
 * `id` and `createdAt`, `parentId` pointing at its source, the current `round`,
 * and `repairs: 0` / `repairedRows: []`. Inheriting `meta` was a real v1 defect —
 * every round shared one `id`, `parentId` stayed permanently `null` so the
 * lineage field was inert, and `repairedRows` propagated forward so
 * `row-repaired` re-fired on rounds where the agent had already fixed them.
 *
 * **6. A revise pass that made the sprite worse is discarded** (amendment A14).
 * `revise()` is net-negative under every tool configuration ever measured here
 * — mean Δsymmetry −0.025 shipped, −0.074 with a canvas refresh, −0.157 with
 * §6.2a's shape ops, coverage rising in all three
 * (`captures/2026-07-30-revise-tool-measurement.txt`). Since every condition
 * loses, there is no tooling fix and this file does not attempt one; it makes
 * the loop **monotonic** instead. `lint()` runs on the document the pass started
 * from and on the candidate it produced, `reviseRegression` compares the two
 * against §6.8's `reviseRegressionBar`, and a candidate that is measurably worse
 * is dropped: the *before* document stays the last round, the run stops with
 * `revise-regressed`, and there is **no retry** — the measurement says a second
 * attempt draws from the same distribution.
 *
 * Two properties of that are load-bearing and easy to lose:
 *
 * - **The comparison is before-vs-after, per round.** The baseline is
 *   `lintReport` — the lint taken at the top of *this* iteration, of the
 *   document this pass was handed — never a lint of the candidate, and never one
 *   computed once outside the loop.
 * - **A rejected pass is still recorded.** `completeRound` runs first and
 *   unconditionally, so `Round.revise` carries `turns`, `hitCap` and `summary`
 *   whichever way the guard decides. A rejected pass is data. `summary` is
 *   *known-unreliable* prose — the wave-11 round that claimed it "reduced head
 *   size" added 44 cells of coloured bands — which is a reason to keep storing
 *   it, not a reason to start trusting it.
 *
 * Two smaller decisions worth stating, because the artifact reads differently
 * depending on them:
 *
 * - **An aborted stage leaves its timing `null`.** On a `CRITIQUING` timeout the
 *   round is still snapshotted — `Round.critique` is nullable for exactly this
 *   state, and the draft that produced the document cost minutes — but
 *   `timings.critiqueMs` stays `null` rather than recording the elapsed time
 *   before the abort. `null` therefore reads as "this stage produced nothing",
 *   uniformly, and the elapsed figure lives in `error`, which
 *   `OllamaTimeoutError` already names. The same choice applies to `reviseMs`.
 * - **A failed `persist` never fails the run.** Every call site is guarded, the
 *   way `fail()` always guarded its own: the rounds are already in memory and
 *   the pipeline's verdict is already known, so a full disk on the terminal
 *   write of a converging run used to reject `run()` — a multi-minute run that
 *   *succeeded* returning nothing, and §9's envelope reporting `{ok: false}`
 *   with no session at all. The write failure is recorded on
 *   `SessionHistory.error` instead, and `outcome` keeps reporting what the
 *   *pipeline* achieved: a run that converged and could not be written out is
 *   `"completed"` with an error, not `"failed"`.
 * - **`Round.round` is the 1-based array position, so `rounds[i].round === i+1`
 *   always.** It is not lineage depth. `acceptedRound` *names* this number, so
 *   it has to be unique within a history, and `applyFeedback` can branch twice
 *   from the same round — which lineage depth would number identically. The
 *   lineage is carried by `meta.parentId`, which is where the filmstrip and
 *   `diffFromPrev` read it.
 *
 * There is no cancellation: `revise()` takes no `signal`, so a run in flight
 * cannot be interrupted from outside. Each model call still has its own
 * area-scaled `callTimeoutMs`, which bounds the run but does not answer a user
 * who wants to stop it.
 */

import { randomUUID } from "node:crypto";

import { critique, filterIssues } from "@main/critique";
import { draft } from "@main/draft";
import { appendRound, completeRound, createHistory, roundAt } from "@main/history";
import { lint } from "@main/lint";
import type { OllamaClient } from "@main/ollama";
import type { ResidencyRunner } from "@main/residency";
import { revise } from "@main/revise";
import { diff, type Grid } from "@shared/grid";
import {
  HarnessConfigSchema,
  SpriteDocSchema,
  type CritiqueReport,
  type DraftFailure,
  type HarnessConfig,
  type Issue,
  type LintReport,
  type PipelineEvent,
  type PipelineState,
  type ReviseRegressionBar,
  type ReviseSummary,
  type SessionHistory,
  type Size,
  type SpriteDoc,
  type StopReason,
} from "@shared/schema";

// ---------------------------------------------------------------------------
// the public surface
// ---------------------------------------------------------------------------

export interface PipelineDeps {
  client: OllamaClient;
  /** Every transition, every revise turn, every round snapshot — §7.1. */
  onEvent: (e: PipelineEvent) => void;
  /**
   * Called after every history write, so at most one round is lost to a crash
   * (§9). A callback rather than a directory, which is what keeps this module
   * Electron-free and the stub-driven tests disk-free.
   */
  persist?: (h: SessionHistory) => Promise<void>;
  /**
   * Who is allowed to be resident, and when the outgoing model is evicted —
   * amendment A17.
   *
   * Optional, and absent is the shipped case: both roles default to one model,
   * so there is never a second model to unload and the runner would have nothing
   * to do. `run()` calls `enter()` immediately before each stage rather than
   * after it, because the point is to free the memory *before* the call that
   * needs it — evicting afterwards pays the same cold load a beat later.
   */
  residency?: ResidencyRunner;
}

export interface PipelineInput {
  prompt: string;
  size: Size;
  paletteId: string;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * The mutable half of a run.
 *
 * `history` is replaced, never mutated — every `history.ts` function returns a
 * new value — so a `persist` callback holding an earlier one still holds what it
 * was given.
 */
interface Ctx {
  deps: PipelineDeps;
  config: HarnessConfig;
  history: SessionHistory;
}

/**
 * A flat `"<ErrorName>: <message>"`, which is what `SessionHistory.error` holds.
 *
 * §9 keeps `code` / `message` / `endpoint` separate across IPC precisely because
 * `ipcMain.handle` destroys them — but this field is a single string, and after a
 * reload it is the *only* source for §8's requirement that the status bar name
 * the exact endpoint. Both `OllamaUnreachableError` and `OllamaHttpError` embed
 * the endpoint in their message and `OllamaTimeoutError` embeds the model and
 * elapsed time, so prefixing the name is enough to keep the whole diagnosis.
 */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name.length > 0 ? error.name : "Error";
    return `${name}: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

/**
 * Enter a state: record it on the history and emit the event.
 *
 * `finalState` tracks the furthest state the run reached, so a mid-run artifact
 * says where it got to rather than claiming a terminal state it never entered.
 */
function setState(ctx: Ctx, state: PipelineState, round: number): void {
  ctx.history = { ...ctx.history, finalState: state };
  ctx.deps.onEvent({ type: "state", state, round });
}

/**
 * Write the history out — and never fail the run because it could not be
 * written.
 *
 * `fail()` guarded its own persist from the start, on the grounds that "a
 * history that cannot be written is a worse thing to report than the failure
 * already being reported". That reasoning is not special to the failure path.
 * Unguarded, an `ENOSPC` on the terminal write of a fully converged run
 * rejected `run()`, discarding every round in memory: §9's envelope then
 * reported `{ok: false}` with no session at all, so a disk problem surfaced as
 * the total loss of a multi-minute run that had in fact succeeded. Mid-run it
 * was worse — write 3 of 4 threw away the two rounds already snapshotted.
 *
 * The failure is not silent: it is recorded on `SessionHistory.error`, which is
 * the field §8 has the status bar read after a reload. Not an event —
 * `PipelineEvent` has no error variant and `schema.ts` is closed — so this is
 * the whole channel, and it is the one a reload can still see.
 *
 * Written only when `error` is still `null`, which keeps two things true: a
 * stage failure is the *cause* and a failed write is only the record of it, so
 * `fail()` has the right of way; and a disk that is full on write 3 is full on
 * write 4 too, so the first failure names the problem once instead of being
 * renumbered by every write after it.
 */
async function persist(ctx: Ctx): Promise<void> {
  try {
    await ctx.deps.persist?.(ctx.history);
  } catch (error) {
    if (ctx.history.error === null) {
      ctx.history = { ...ctx.history, error: formatError(error) };
    }
  }
}

/**
 * The run reached the gate — spec §7.1, §12.
 *
 * `outcome` flips to `"completed"` here and nowhere else: every earlier write
 * says `"failed"`, so a crash mid-run cannot leave an artifact claiming success.
 *
 * The terminal write is guarded like every other one, so this resolves even when
 * the artifact cannot be written: `outcome` reports what the pipeline achieved,
 * and the failed write reports itself through `error`. `persist` mutates
 * `ctx.history` when it swallows, which is why the return reads the field again
 * rather than the value written out.
 */
async function finish(ctx: Ctx, stopReason: StopReason, round: number): Promise<SessionHistory> {
  ctx.history = { ...ctx.history, stopReason, outcome: "completed" };
  setState(ctx, "AWAITING_USER", round);
  await persist(ctx);
  return ctx.history;
}

/**
 * The run failed in a stage — spec §7.1's `FAILED` edges, §9.
 *
 * `stopReason` stays `null`: a failure is not a stop condition, and §11 reads
 * `stopReason !== "critic-failed"` off runs that finished. The persist is
 * guarded — by `persist` itself now, for every call site — because a history
 * that cannot be written is a worse thing to report than the failure that is
 * already being reported. `error` is set here *before* that write, so the guard
 * leaves this function's diagnosis standing rather than replacing the cause with
 * the record of it.
 */
async function fail(ctx: Ctx, error: unknown, round: number): Promise<SessionHistory> {
  ctx.history = {
    ...ctx.history,
    stopReason: null,
    outcome: "failed",
    error: formatError(error),
  };
  setState(ctx, "FAILED", round);
  await persist(ctx);
  return ctx.history;
}

/**
 * Which stop condition fires, or `null` to revise — spec §7.2.
 *
 * The predicates are mutually exclusive **because they are ordered**; in v1 a
 * single medium-severity issue satisfied both "no high-sev issues" and "issues
 * remain".
 */
function decideStop(
  report: CritiqueReport,
  filtered: Issue[],
  round: number,
  config: HarnessConfig,
): StopReason | null {
  // First, and ahead of the table's own order: a degraded report has an empty
  // `issues` array, so every later predicate would read it as convergence and
  // tell the user the sprite passed a critique that never ran.
  if (report.degraded) return "critic-failed";

  // §7.2: an empty filtered list skips `REVISING` **unconditionally**, including
  // when `stopOnNoHighSeverity` is false. There is nothing for the agent to do
  // and no prompt that would make sense.
  if (filtered.length === 0) return "no-high-severity";

  const highSeverity = filtered.some((issue) => issue.severity === "high");

  // Before `round-cap`, per the table's order: a run that converged on its last
  // permitted critique converged, and §11 counts convergence off this field.
  if (!highSeverity && config.stopOnNoHighSeverity) return "no-high-severity";

  if (round >= config.maxRounds) return "round-cap";

  return null;
}

// ---------------------------------------------------------------------------
// the revise regression guard — amendment A14, spec §7.2, §6.5
// ---------------------------------------------------------------------------

/** The metrics half of a `LintReport` — all this guard reads. */
type LintMetrics = LintReport["metrics"];

/**
 * Why a revise pass was thrown away.
 *
 * Structured rather than a bare boolean or a bare sentence: the metric that
 * fired is what a bench tuning `reviseRegressionBar` needs, and `reason` is what
 * a human reading the run needs. Returned rather than thrown — a regression is
 * a verdict about the sprite, not an error in the harness, and the run that
 * produced it completes normally at `AWAITING_USER` with the good document.
 */
export interface ReviseRegression {
  metric: "symmetry" | "orphans" | "coverage";
  before: number;
  after: number;
  /** The quantity compared against `limit`: a drop, an increase, or a ratio. */
  delta: number;
  limit: number;
  reason: string;
}

/**
 * Did this revise pass make the sprite measurably worse — amendment A14.
 *
 * `null` means keep the revision. Anything else means discard it.
 *
 * Three checks, in this order, each against a **named, defaulted** threshold so
 * §13's bench can tune it without editing this file. The order is only about
 * which reason gets reported when more than one fires; symmetry leads because it
 * is the signal the measurement identified.
 *
 * Every check is deliberately conservative. A guard that fires too eagerly makes
 * revise useless and a guard that never fires is decoration, so each threshold
 * was checked against the two wave-11 captures: together they reject the
 * round 1 → round 2 transition (symmetry 0.913 → 0.493) and leave round 2 →
 * round 3 alone.
 *
 * **The comparisons are `>`, not `>=`.** Each field is a *maximum* — "at most
 * this much" — so a delta exactly equal to the bar is inside it. That matters
 * most for `maxOrphanIncrease: 0`, where `>` is what makes the shipped default
 * mean "no new orphans" rather than "any number of new orphans".
 *
 * **Nothing here reads a threshold through a falsy check.** `0` is a legal and
 * probably-correct value on all three fields — it is the strictest setting on
 * each — and `bar.maxOrphanIncrease || 1` or `if (bar.maxSymmetryDrop)` would
 * turn the shipped configuration into a silent no-op. The values are compared
 * directly, every time.
 *
 * Exported so the boundaries are testable directly rather than inferred from a
 * whole pipeline run, which is also how `syntheticFeedbackIssue` earns its
 * export.
 */
export function reviseRegression(
  before: LintMetrics,
  after: LintMetrics,
  bar: ReviseRegressionBar,
): ReviseRegression | null {
  // 1. Symmetry — a DROP, never an absolute floor. An asymmetric sprite is a
  //    legitimate sprite (every side-facing subject the app can draw scores
  //    low), so a floor would refuse to revise most of them; what the
  //    measurement found was the *fall*, 0.913 → 0.493 in one pass.
  const symmetryDrop = before.symmetryScore - after.symmetryScore;
  if (symmetryDrop > bar.maxSymmetryDrop) {
    return {
      metric: "symmetry",
      before: before.symmetryScore,
      after: after.symmetryScore,
      delta: symmetryDrop,
      limit: bar.maxSymmetryDrop,
      reason:
        `symmetry fell ${symmetryDrop.toFixed(3)} (${before.symmetryScore.toFixed(3)} → ` +
        `${after.symmetryScore.toFixed(3)}), past maxSymmetryDrop ${bar.maxSymmetryDrop}`,
    };
  }

  // 2. Orphans — cells the pass detached from the sprite. `maxOrphanIncrease: 0`
  //    is the default and means "no new orphans"; an orphan the pass *inherited*
  //    is not charged to it, and removing one is free.
  const orphanIncrease = after.orphanCount - before.orphanCount;
  if (orphanIncrease > bar.maxOrphanIncrease) {
    return {
      metric: "orphans",
      before: before.orphanCount,
      after: after.orphanCount,
      delta: orphanIncrease,
      limit: bar.maxOrphanIncrease,
      reason:
        `${orphanIncrease} new orphan ${orphanIncrease === 1 ? "pixel" : "pixels"} ` +
        `(${before.orphanCount} → ${after.orphanCount}), past maxOrphanIncrease ` +
        `${bar.maxOrphanIncrease}`,
    };
  }

  // 3. Coverage — **relative** to what was there, `(before - after) / before`.
  //    Absolute would be meaningless: a 16×16 sprite covers 0.10-0.30 of its
  //    canvas, so losing three quarters of one is an absolute drop of 0.135 and
  //    no absolute bar could separate that from ordinary work. Only *collapse*
  //    is policed — coverage growth is what the reviser actually does, and
  //    charging it would fire on every pass.
  //
  //    A blank before-canvas is spelled out rather than left to `0/0 = NaN`,
  //    which compares `false` and would pass by accident.
  const coverageDrop =
    before.coverage === 0 ? 0 : (before.coverage - after.coverage) / before.coverage;
  if (coverageDrop > bar.maxCoverageDrop) {
    return {
      metric: "coverage",
      before: before.coverage,
      after: after.coverage,
      delta: coverageDrop,
      limit: bar.maxCoverageDrop,
      reason:
        `coverage collapsed by ${(coverageDrop * 100).toFixed(1)}% relative ` +
        `(${before.coverage.toFixed(4)} → ${after.coverage.toFixed(4)}), past ` +
        `maxCoverageDrop ${bar.maxCoverageDrop}`,
    };
  }

  return null;
}

/**
 * A revised document — spec §7.5, rule 5 of this file's header.
 *
 * `prompt`, `intent`, `size` and `palette` carry forward (it is the same sprite,
 * for the same request); `meta` is rebuilt from scratch, never spread from the
 * parent. The models come from the live config rather than from the parent's
 * `meta`, so a mid-session rebind is visible on the round it took effect —
 * which is how the model-binding path is verified at all (§6.7's
 * `meta.criticModel` is recorded per round for exactly that reason).
 */
function deriveDoc(parent: SpriteDoc, grid: Grid, round: number, config: HarnessConfig): SpriteDoc {
  return SpriteDocSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    prompt: parent.prompt,
    intent: parent.intent,
    size: parent.size,
    palette: { id: parent.palette.id, colors: [...parent.palette.colors] },
    rows: grid,
    meta: {
      generatorModel: config.models.generator,
      criticModel: config.models.critic,
      round,
      parentId: parent.id,
      // Repairs belong to the draft that needed them. Propagating them would
      // re-fire §6.5's `row-repaired` on rounds where the agent already fixed
      // those rows.
      repairs: 0,
      repairedRows: [],
    },
  });
}

/**
 * The user's words as an `Issue` — spec §7.3.
 *
 * `confidence: 1.0` and `suggestConfidence: 0.0` are what make it survive its
 * own filter by construction: the confidence clears any floor, and blanking a
 * `suggest` that is already `""` is a no-op, so `filterIssues` is idempotent on
 * it. That is what lets agent feedback and user feedback travel one code path —
 * a single loop to build, test and debug.
 *
 * The region is the whole canvas: the user's sentence is not localized, and
 * inventing a narrower one would point the agent at pixels the user never
 * mentioned. Exported so the property above is testable directly rather than
 * inferred from prompt text.
 */
export function syntheticFeedbackIssue(feedback: string, size: Size): Issue {
  return {
    id: "user-feedback",
    region: [0, 0, size.w - 1, size.h - 1],
    severity: "high",
    issue: feedback,
    suggest: "",
    confidence: 1,
    suggestConfidence: 0,
  };
}

/** What a loop entry needs beyond the context: the doc, and what attaches to its snapshot. */
interface LoopEntry {
  doc: SpriteDoc;
  /** Attached to the NEXT snapshot only, then cleared — §6.7. */
  userFeedback: string | null;
  /** Only round 1 has a draft, so this is `null` on every later iteration. */
  draftMs: number | null;
}

/**
 * `LINTING → CRITIQUING → snapshot → stop or REVISE`, until a terminal state.
 *
 * Shared by `run` and `applyFeedback` so §7.3's "agent feedback and user
 * feedback travel one code path" is a fact about the code rather than a claim
 * about it.
 */
async function runLoop(ctx: Ctx, entry: LoopEntry): Promise<SessionHistory> {
  let { doc, userFeedback, draftMs } = entry;

  for (;;) {
    // Rule: `Round.round` is the array position, 1-based.
    const round = ctx.history.rounds.length + 1;

    // LINTING — pure, and cannot fail (§6.5, ruling R3: there is no
    // `LINTING → FAILED` edge and no `LintReport.errors`).
    setState(ctx, "LINTING", round);
    const lintReport = lint(doc);

    setState(ctx, "CRITIQUING", round);
    let report: CritiqueReport;
    let critiqueMs: number;
    try {
      // A17. Before the call, not after: the memory has to be free when the
      // critic loads, and it names the model being *left*, not the one entered.
      await ctx.deps.residency?.enter(ctx.config.models.critic);
      const started = performance.now();
      report = await critique(ctx.deps, doc, lintReport, ctx.config);
      critiqueMs = performance.now() - started;
    } catch (error) {
      // The round is still snapshotted: `Round.critique` is nullable for exactly
      // this state, the document cost a full draft, and R2 wants a snapshot on
      // every iteration. `critiqueMs` stays `null` — see the header.
      ctx.history = appendRound(ctx.history, {
        round,
        doc,
        lint: lintReport,
        critique: null,
        filteredIssues: [],
        diffFromPrev: null, // recomputed by `appendRound` from the parent
        userFeedback,
        revise: null,
        timings: { draftMs, critiqueMs: null, reviseMs: null },
      });
      ctx.deps.onEvent({
        type: "round",
        snapshot: ctx.history.rounds[ctx.history.rounds.length - 1],
      });
      await persist(ctx);
      return await fail(ctx, error, round);
    }

    // §6.4's two-tier filter, applied here rather than in `critique()`: §6.7
    // stores the raw report and the filtered issues side by side, because
    // storing only the filtered one destroys the data needed to tune the floors.
    const filtered = filterIssues(report, ctx.config).issues;

    // Phase one (rule 1).
    ctx.history = appendRound(ctx.history, {
      round,
      doc,
      lint: lintReport,
      critique: report,
      filteredIssues: filtered,
      diffFromPrev: null, // recomputed by `appendRound` from the parent
      userFeedback,
      revise: null,
      timings: { draftMs, critiqueMs, reviseMs: null },
    });
    const index = ctx.history.rounds.length - 1;
    ctx.deps.onEvent({ type: "round", snapshot: ctx.history.rounds[index] });
    await persist(ctx);

    const stop = decideStop(report, filtered, round, ctx.config);
    if (stop !== null) return await finish(ctx, stop, round);

    setState(ctx, "REVISING", round);
    let grid: Grid;
    let reviseMs: number;
    let summary: ReviseSummary;
    try {
      // A17. Revise runs on the generator, so this is where the critic is left.
      await ctx.deps.residency?.enter(ctx.config.models.generator);
      const started = performance.now();
      const result = await revise(
        {
          client: ctx.deps.client,
          // §7.1: the longest stage emitted nothing in v1, so a 40-turn loop
          // showed one static label for minutes.
          onTurn: (turn) =>
            ctx.deps.onEvent({
              type: "revise-turn",
              round,
              turn,
              maxTurns: ctx.config.maxReviseTurns,
            }),
        },
        doc,
        filtered,
        ctx.config,
      );
      reviseMs = performance.now() - started;
      grid = result.grid;
      summary = { turns: result.turns, hitCap: result.hitCap, summary: result.summary };
    } catch (error) {
      // The round keeps its phase-one shape: `revise` and `reviseMs` stay `null`,
      // which is what says the stage did not complete.
      return await fail(ctx, error, round);
    }

    // Phase two (rule 1), then the second `persist`.
    ctx.history = completeRound(ctx.history, index, { revise: summary, reviseMs });
    ctx.deps.onEvent({ type: "round", snapshot: ctx.history.rounds[index] });
    await persist(ctx);

    // Rule 2: computed here, from the two documents, never read from the stored
    // `diffFromPrev`.
    //
    // Ahead of the guard, because a pass that changed nothing cannot have made
    // anything worse — its metrics are identical by construction — and
    // `empty-diff` is the honest reason for it. §7.1 draws both on this one
    // transition.
    if (diff(doc.rows, grid).length === 0) return await finish(ctx, "empty-diff", round);

    // Rule 6. The candidate is assembled before it is judged, and becomes `doc`
    // only if it survives — so a rejected revision is never appended, never
    // persisted, and never reaches the filmstrip. `lintReport` is the baseline:
    // the lint taken at the top of THIS iteration, of the document this pass was
    // handed. Comparing the candidate against itself is the mutation that makes
    // the guard silently unfireable.
    const candidate = deriveDoc(doc, grid, ctx.history.rounds.length + 1, ctx.config);
    const regressed = reviseRegression(
      lintReport.metrics,
      lint(candidate).metrics,
      ctx.config.reviseRegressionBar,
    );
    if (regressed !== null) {
      // No retry: `captures/2026-07-30-revise-tool-measurement.txt` measured
      // every configuration as net-negative, so a second pass draws from the
      // same distribution. The last round still holds the good document.
      return await finish(ctx, "revise-regressed", round);
    }

    doc = candidate;
    userFeedback = null;
    draftMs = null;
  }
}

// ---------------------------------------------------------------------------
// run — spec §7.1
// ---------------------------------------------------------------------------

/**
 * Draft a sprite and critique it until a stop condition fires.
 *
 * Resolves at `AWAITING_USER` (§12: minutes later), or with a `FAILED` history
 * when a stage failed — **not** by rejecting, because `draftFailures`, `error`
 * and the rounds already snapshotted are the only record of what happened, and a
 * rejection would discard all three. The one exception is the config: it is
 * parsed before a history exists, so an invalid one has nowhere to be recorded
 * and rejects.
 */
export async function run(
  deps: PipelineDeps,
  input: PipelineInput,
  cfg: HarnessConfig,
): Promise<SessionHistory> {
  // §6.8: the schema's guards are worthless if a caller can hand-build
  // `{...DEFAULT_HARNESS_CONFIG, maxRounds: 0}` and bypass them. Before the
  // first model call, so a bad config costs no inference.
  const config = HarnessConfigSchema.parse(cfg);

  const ctx: Ctx = {
    deps,
    config,
    history: createHistory(randomUUID(), config),
  };

  const draftFailures: DraftFailure[] = [];
  const attempts = config.maxDraftRetries + 1;

  setState(ctx, "DRAFTING", 0);

  let doc: SpriteDoc;
  // A17. The run's first stage. Nothing is resident yet, so this evicts nothing
  // and only records what the generator is about to load.
  await deps.residency?.enter(config.models.generator);
  const started = performance.now();
  try {
    doc = await draft(
      {
        client: deps.client,
        // A9. Collected here because `DraftRejectedError` carries only the last
        // attempt, and §6.7's `draftFailures` is an array for a reason.
        onAttempt: (failure) => {
          draftFailures.push(failure);
          // Only when another attempt follows: a second full generation is
          // minutes of silence, and the status bar has to be able to say
          // "retrying draft" rather than appearing to hang.
          if (failure.attempt < attempts) setState(ctx, "DRAFTING", 0);
        },
      },
      input,
      config,
    );
  } catch (error) {
    // Recorded whether or not the failure was a rejection: a transport error
    // leaves the array empty, which is how §6.7 keeps the two failure modes
    // apart.
    ctx.history = { ...ctx.history, draftFailures: [...draftFailures] };
    return await fail(ctx, error, 0);
  }
  const draftMs = performance.now() - started;

  // A rejected attempt that the retry recovered from still happened, and "how
  // often does the retry save the run" is a question only this record answers.
  ctx.history = { ...ctx.history, draftFailures: [...draftFailures] };

  return runLoop(ctx, { doc, userFeedback: null, draftMs });
}

// ---------------------------------------------------------------------------
// applyFeedback — spec §7.3
// ---------------------------------------------------------------------------

/**
 * Resume a session from the user's own words — spec §7.3.
 *
 * Re-enters at `REVISING` (rule 3) against the doc of `rounds[roundIndex]`,
 * which is the round the user was looking at and **need not be the last**. The
 * resulting round is parented to it, so `history.ts` diffs against the right
 * baseline even when the history branches.
 *
 * The feedback pass's `ReviseSummary` is written onto the *source* round, which
 * is symmetric with `run()`: the round holding a summary is the round the revise
 * stage ran from. Branching twice from one round therefore overwrites the first
 * pass's summary — both records are true and only one is representable, and the
 * branch itself stays legible through `meta.parentId`.
 *
 * `outcome` returns to `"failed"` and `stopReason` to `null` for the duration:
 * the session is in flight again, and a crash here must not leave the previous
 * gate's verdict standing as if it described this pass.
 */
export async function applyFeedback(
  deps: PipelineDeps,
  history: SessionHistory,
  feedback: string,
  roundIndex: number,
  cfg: HarnessConfig,
): Promise<SessionHistory> {
  const config = HarnessConfigSchema.parse(cfg);
  const source = roundAt(history, roundIndex, "applyFeedback");

  const ctx: Ctx = {
    deps,
    config,
    history: { ...history, stopReason: null, outcome: "failed", error: null },
  };

  // The event's round is the one being revised, exactly as in `runLoop`.
  const round = source.round;
  const issues = [syntheticFeedbackIssue(feedback, source.doc.size)];

  setState(ctx, "REVISING", round);
  let grid: Grid;
  let reviseMs: number;
  let summary: ReviseSummary;
  try {
    // A17. §7.3 travels the same stages as §7.2, so it gets the same eviction.
    await deps.residency?.enter(config.models.generator);
    const started = performance.now();
    const result = await revise(
      {
        client: deps.client,
        onTurn: (turn) =>
          deps.onEvent({ type: "revise-turn", round, turn, maxTurns: config.maxReviseTurns }),
      },
      source.doc,
      issues,
      config,
    );
    reviseMs = performance.now() - started;
    grid = result.grid;
    summary = { turns: result.turns, hitCap: result.hitCap, summary: result.summary };
  } catch (error) {
    return await fail(ctx, error, round);
  }

  ctx.history = completeRound(ctx.history, roundIndex, { revise: summary, reviseMs });
  ctx.deps.onEvent({ type: "round", snapshot: ctx.history.rounds[roundIndex] });
  await persist(ctx);

  // The same computed diff as in `runLoop` — §7.1 draws one revise transition,
  // not two.
  if (diff(source.doc.rows, grid).length === 0) {
    return await finish(ctx, "empty-diff", round);
  }

  const doc = deriveDoc(source.doc, grid, ctx.history.rounds.length + 1, config);

  // And the same guard, for the same reason §7.3 gives for everything else here:
  // agent feedback and user feedback travel one code path, so there is a single
  // loop to build, test and debug. The pass the user asked for runs through the
  // *same* `revise()` that the measurement found net-negative, and a user asking
  // for a tail did not ask for the silhouette to be redrawn.
  //
  // `lint(source.doc)` is recomputed rather than read from `source.lint`: the
  // stored report is of that document by contract, but this is a pure
  // microsecond call over a document that may have been reloaded from disk or
  // hand-edited, and a guard that trusts a stale baseline is worse than no
  // guard. The cost of being sure is nil.
  const regressed = reviseRegression(
    lint(source.doc).metrics,
    lint(doc).metrics,
    config.reviseRegressionBar,
  );
  if (regressed !== null) return await finish(ctx, "revise-regressed", round);

  return runLoop(ctx, { doc, userFeedback: feedback, draftMs: null });
}

// ---------------------------------------------------------------------------
// accept — spec §6.7, §8
// ---------------------------------------------------------------------------

/**
 * Record the round the user accepted and transition to `DONE` — spec §8.
 *
 * **`roundIndex` is the renderer's 0-based array position; `acceptedRound` is
 * `Round.round`, which is 1-based.** Exactly one conversion stands between them,
 * and `accept(0)` — accepting the draft, the most common call there is — is
 * where dropping it shows up. The number is read off the round rather than
 * computed as `roundIndex + 1`, so it stays correct for a history whose rounds
 * were not appended in order.
 *
 * `outcome` is deliberately untouched. Any round may be accepted, not only the
 * last — including a round from a run that later failed — and `outcome` reports
 * the *run*, which §11's first bar reads. Accepting is a user action and must not
 * be able to launder a failure into a success.
 *
 * No `persist`: the signature takes no `PipelineDeps`, so the caller that owns
 * the session owns writing this out.
 */
export async function accept(
  history: SessionHistory,
  roundIndex: number,
): Promise<SessionHistory> {
  const round = roundAt(history, roundIndex, "accept");
  return { ...history, acceptedRound: round.round, finalState: "DONE" };
}
