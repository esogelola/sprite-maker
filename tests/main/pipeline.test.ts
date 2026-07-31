/**
 * The state machine — spec §7.1–§7.5, §6.7, §9; plan Wave 9.
 *
 * Written before `src/main/pipeline.ts` existed. **v1's own happy-path test
 * asserted only the event sequence and would have passed against
 * `rounds: []`** (blocker B01), so every test here inspects the returned
 * `SessionHistory` and reaches for `events` only when the event stream *is* the
 * subject.
 *
 * The five things v1 got wrong, each with a test that fails without it:
 *
 * 1. **The round is snapshotted at the top of every iteration**, after
 *    `CRITIQUING`, before any revision — and completed in a **second phase**
 *    after the revise transition. Without phase one a converging run returns
 *    nothing to export; without phase two `revise`/`reviseMs` are permanently
 *    `null`.
 * 2. **`empty-diff` is `diff(docBefore, docAfter)` on the revise transition**,
 *    never a read of the stored `diffFromPrev` — which is `null` on round 1, so
 *    reading it stops every run right after the draft.
 * 3. **Feedback re-enters at `REVISING`**, and the new round's `parentId` points
 *    at the round the user was looking at, which may not be the last.
 * 4. **`diffFromPrev` is computed against the parent**, not the array-previous.
 * 5. **The pipeline constructs every `meta`** except the draft's.
 *
 * Every test runs against `createStubClient`; the file is green with Ollama
 * stopped and with `globalThis.fetch` stubbed to throw.
 */

import { describe, expect, it, vi } from "vitest";

import { DraftRejectedError } from "@main/draft";
import { filterIssues } from "@main/critique";
import { appendRound, createHistory } from "@main/history";
import { lint } from "@main/lint";
import { OllamaTimeoutError, OllamaUnreachableError } from "@main/ollama";
import {
  accept,
  applyFeedback,
  reviseRegression,
  run,
  syntheticFeedbackIssue,
  type PipelineDeps,
} from "@main/pipeline";
import { createResidencyRunner } from "@main/residency";
import {
  DEFAULT_HARNESS_CONFIG,
  HarnessConfigSchema,
  PipelineEventSchema,
  SessionHistorySchema,
  type ChatTurn,
  type HarnessConfig,
  type LintReport,
  type PipelineEvent,
  type ReviseRegressionBar,
  type SessionHistory,
  type Size,
} from "@shared/schema";

import { createStubClient, type StubClient, type StubScript } from "../stubs/ollama";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const SIZE: Size = { w: 16, h: 16 };
const INPUT = { prompt: "a sitting red fox", size: SIZE, paletteId: "gameboy" };

function cfg(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return HarnessConfigSchema.parse(overrides);
}

/** A 4×4 block of index `1` at (6,6)–(9,9); rows 0 and 1 are fully transparent. */
const DRAFT_ROWS = Array.from({ length: 16 }, (_, y) =>
  Array.from({ length: 16 }, (_, x) => (y >= 6 && y <= 9 && x >= 6 && x <= 9 ? "1" : ".")).join(""),
);

/** The generator's reply, as `generate` hands it back — bare JSON, no fence. */
function draftReply(rows: string[] = DRAFT_ROWS): string {
  return JSON.stringify({ intent: { subject: "a fox" }, rows });
}

/** A draft so malformed it is charged `16 × 16` repairs and rejected. */
const PROSE = "I'm sorry, I can't draw pixel art.";

interface IssueSeed {
  id?: string;
  severity?: "high" | "medium" | "low";
  confidence?: number;
  suggestConfidence?: number;
  issue?: string;
  /** Distinct from `issue` so a prompt assertion can tell the two texts apart. */
  suggest?: string;
}

/** The critic's reply, as `vision` hands it back. */
function critiqueReply(seeds: IssueSeed[] = [], overall: number | null = 3): string {
  return JSON.stringify({
    readsAs: "a small green block",
    matchesIntent: true,
    overall,
    issues: seeds.map((seed, i) => ({
      id: seed.id ?? `issue-${i}`,
      region: [6, 6, 9, 9],
      severity: seed.severity ?? "high",
      issue: seed.issue ?? "the block reads as a smudge",
      suggest: seed.suggest ?? "add a darker outline",
      confidence: seed.confidence ?? 0.9,
      suggestConfidence: seed.suggestConfidence ?? 0.8,
    })),
  });
}

/** No issues at all — the intended success path. */
const CONVERGED = critiqueReply([]);
/** One high-severity issue the two-tier filter keeps. */
const HIGH = critiqueReply([{}]);

/** A revise turn that fills row `y` with index `1`, then finishes. */
function fillRowTurn(y: number, summary = `filled row ${y}`): ChatTurn {
  return {
    content: "",
    toolCalls: [
      { id: `fill-${y}`, name: "fill_row", arguments: { y, x0: 0, x1: 15, index: 1 } },
      { id: `done-${y}`, name: "done", arguments: { summary } },
    ],
  };
}

/** A revise turn that finishes without touching a pixel — the `empty-diff` edge. */
const NOOP_TURN: ChatTurn = {
  content: "",
  toolCalls: [{ id: "d", name: "done", arguments: { summary: "nothing needed changing" } }],
};

/** A turn that narrates instead of editing — burns the cap, changes nothing. */
const NARRATING_TURN: ChatTurn = { content: "I will fix the outline.", toolCalls: [] };

// -- A14 fixtures: the session the user watched -------------------------------

/**
 * A revise turn that rewrites `from` into `to` cell by cell, then finishes.
 *
 * One `place_pixel` per differing cell — the tool vocabulary the reviser
 * actually ships with, per `captures/2026-07-30-revise-tool-measurement.txt`,
 * which measured the alternatives as *worse*. `index` is passed as the row
 * character, which `coerceIndex` accepts and which makes `.` (clearing a cell)
 * expressible, so the helper is general rather than additive-only.
 */
function rewriteTurn(from: string[], to: string[], summary: string): ChatTurn {
  const toolCalls: ChatTurn["toolCalls"] = [];
  for (let y = 0; y < to.length; y++) {
    for (let x = 0; x < to[y].length; x++) {
      if (from[y][x] === to[y][x]) continue;
      toolCalls.push({
        id: `p-${x}-${y}`,
        name: "place_pixel",
        arguments: { x, y, index: to[y][x] },
      });
    }
  }
  toolCalls.push({ id: "done", name: "done", arguments: { summary } });
  return { content: "", toolCalls };
}

/**
 * Round 1 of the "a dog standing" session — the sprite the user watched being
 * wrecked. Verbatim from `captures/2026-07-30-wave-11-rounds.txt`:
 * coverage 0.180, symmetry 0.913, 4 palette entries, 0 orphans.
 */
const WAVE11_ROUND_1 = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  ".....a.aa.a.....",
  ".....aaaaaa.....",
  "....aaaaaaaa....",
  ".....aeeeee.....",
  ".....aeeeee.....",
  "......2222......",
  "......2222......",
  "......2cc2......",
  "......c22c......",
  "................",
];

/**
 * Round 2 of the same session — what the reviser handed back. Coverage 0.285,
 * symmetry **0.493**, 8 palette entries, 44 cells changed, and a summary
 * claiming it "reduced head size" while adding coloured bands across the right
 * half of the canvas.
 */
const WAVE11_ROUND_2 = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  ".....a12a.a.....",
  ".....aaaaaa.....",
  "....a222222222..",
  ".....a333333333.",
  ".....ae444444444",
  "......222222222.",
  "......22222222..",
  "......2cc2ccc...",
  "......c22c.ddd..",
  "................",
];

/** The summary round 1's revise pass actually reported, verbatim. */
const WAVE11_SUMMARY =
  "Replaced the cupcake-like region with a dog shape using appropriate palette colors.";

/** 16×16 pico-8, because the wave-11 grids reference indices up to `e`. */
const DOG_INPUT = { prompt: "a dog standing", size: SIZE, paletteId: "pico-8" };

/** A symmetric 8×4 slab: rows 6–9, columns 4–11. 32 cells, symmetry 1. */
const SLAB_ROWS = Array.from({ length: 16 }, (_, y) =>
  Array.from({ length: 16 }, (_, x) => (y >= 6 && y <= 9 && x >= 4 && x <= 11 ? "1" : ".")).join(""),
);

/** `SLAB_ROWS` with row `y` cleared, for the coverage-drop fixtures. */
function slabWithout(...cleared: number[]): string[] {
  return SLAB_ROWS.map((row, y) => (cleared.includes(y) ? ".".repeat(16) : row));
}

/** A 4×4 block at x 2–5, y 6–9. Its mirror (x 10–13) is empty, so symmetry is 0. */
const LOPSIDED_ROWS = Array.from({ length: 16 }, (_, y) =>
  Array.from({ length: 16 }, (_, x) => (y >= 6 && y <= 9 && x >= 2 && x <= 5 ? "1" : ".")).join(""),
);

/** The same block with its mirror drawn in — symmetry 1, coverage doubled. */
const MIRRORED_ROWS = Array.from({ length: 16 }, (_, y) =>
  Array.from({ length: 16 }, (_, x) =>
    y >= 6 && y <= 9 && ((x >= 2 && x <= 5) || (x >= 10 && x <= 13)) ? "1" : ".",
  ).join(""),
);

interface Harness {
  deps: PipelineDeps;
  stub: StubClient;
  events: PipelineEvent[];
  /**
   * Every history handed to `persist`, deep-copied at the moment of the call —
   * including the ones `persistThrowsOn` then failed, because "the write was
   * attempted and threw" is the thing those tests are about.
   */
  saved: SessionHistory[];
}

/** A full disk, on whichever write a test aims it at. */
const ENOSPC = new Error("ENOSPC: no space left on device, write");

/**
 * A pipeline harness over a scripted stub.
 *
 * `saved` holds `structuredClone`s rather than references: an implementation that
 * mutated one history object in place would otherwise make every recorded
 * snapshot identical to the final one, and the mid-run `outcome: "failed"`
 * assertion — plan AC 9 — would pass against exactly the defect it exists to
 * catch.
 *
 * Every emitted event is validated against `PipelineEventSchema` as it arrives,
 * so a malformed event fails in the test that produced it.
 *
 * `persistThrowsOn` receives the 1-based write number and returns whether that
 * write fails with `ENOSPC`. Defaulted, so every existing test is unaffected.
 */
function harness(
  script: StubScript,
  persistThrowsOn: (write: number) => boolean = () => false,
): Harness {
  const stub = createStubClient(script);
  const events: PipelineEvent[] = [];
  const saved: SessionHistory[] = [];

  return {
    stub,
    events,
    saved,
    deps: {
      client: stub,
      onEvent: (event) => {
        PipelineEventSchema.parse(event);
        events.push(event);
      },
      persist: async (history) => {
        SessionHistorySchema.parse(history);
        saved.push(structuredClone(history));
        if (persistThrowsOn(saved.length)) throw ENOSPC;
      },
    },
  };
}

/** `["DRAFTING:0", "LINTING:1", …]` — the state trace, in order. */
function stateTrace(events: PipelineEvent[]): string[] {
  return events
    .filter((e): e is Extract<PipelineEvent, { type: "state" }> => e.type === "state")
    .map((e) => `${e.state}:${e.round}`);
}

function countCalls(stub: StubClient, method: string): number {
  return stub.calls.filter((c) => c.method === method).length;
}

// ---------------------------------------------------------------------------
// config re-parse — spec §6.8
// ---------------------------------------------------------------------------

describe("run — config", () => {
  it("re-parses the config on entry, so a hand-built one cannot bypass the guards", async () => {
    const { deps } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    // The exact bypass §6.8 names: `{...DEFAULT_HARNESS_CONFIG, maxRounds: 0}`.
    await expect(
      run(deps, INPUT, { ...cfg(), maxRounds: 0 } as unknown as HarnessConfig),
    ).rejects.toThrow();

    await expect(
      run(deps, INPUT, { ...cfg(), maxReviseTurns: 0 } as unknown as HarnessConfig),
    ).rejects.toThrow();

    await expect(
      run(deps, INPUT, { ...cfg(), criticUpscale: 16 } as unknown as HarnessConfig),
    ).rejects.toThrow();
  });

  it("rejects before touching the model — a bad config costs no inference", async () => {
    const { deps, stub, saved, events } = harness({ generate: [draftReply()] });

    await expect(
      run(deps, INPUT, { ...cfg(), maxRounds: 0 } as unknown as HarnessConfig),
    ).rejects.toThrow();

    expect(stub.calls).toHaveLength(0);
    expect(saved).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("serializes the parsed config into the history", async () => {
    const { deps } = harness({ generate: [draftReply()], vision: [CONVERGED] });
    const config = cfg({ maxRounds: 2 });

    const history = await run(deps, INPUT, config);

    expect(history.config).toEqual(config);
  });

  it("fills the §6.8 defaults from a partial config", async () => {
    const { deps } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    const history = await run(deps, INPUT, HarnessConfigSchema.parse({}));

    expect(history.config.maxRounds).toBe(3);
    expect(history.config.maxReviseTurns).toBe(40);
  });

  it("runs off the PARSED config, not the object it was handed", async () => {
    const { deps, stub } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0)],
    });

    // A caller that hand-built a partial object. Without the re-parse, `run`
    // would carry `models: undefined` and `criticTargetPx: undefined` into the
    // stages while the history recorded a complete config — the two would
    // disagree, and the artifact would describe limits the run never used.
    const history = await run(deps, INPUT, { maxRounds: 2 } as unknown as HarnessConfig);

    expect(history.rounds).toHaveLength(2);
    expect(history.stopReason).toBe("round-cap");
    expect(history.config).toEqual(cfg({ maxRounds: 2 }));
    // Since Wave 6c both roles default to the same model, so these two lines no
    // longer tell the generator binding apart from the critic binding — what
    // they still prove is that a *binding reached the stages at all*, which is
    // what the missing re-parse destroyed (`models: undefined` → a call with no
    // model). The role-vs-role distinction is asserted below, off an explicit
    // config, where the two names differ on purpose.
    expect(stub.calls[0].model).toBe("qwen3-vl:8b-instruct-q4_K_M");
    expect(stub.calls[1].model).toBe("qwen3-vl:8b-instruct-q4_K_M");
    expect(history.rounds[1].doc.meta.generatorModel).toBe("qwen3-vl:8b-instruct-q4_K_M");
  });

  it("sends each stage its OWN role binding, not one model for both", async () => {
    // Kept as a live assertion now that the two defaults coincide: a stage
    // reading the wrong role would be invisible against the default config, and
    // this is the run's only proof that `generate` takes `models.generator` and
    // `vision` takes `models.critic`.
    const { deps, stub } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    const history = await run(
      deps,
      INPUT,
      cfg({ models: { generator: "gen-only:1b", critic: "critic-only:1b" } }),
    );

    expect(stub.calls[0].method).toBe("generate");
    expect(stub.calls[0].model).toBe("gen-only:1b");
    expect(stub.calls[1].method).toBe("vision");
    expect(stub.calls[1].model).toBe("critic-only:1b");
    expect(history.rounds[0].doc.meta.generatorModel).toBe("gen-only:1b");
    expect(history.rounds[0].doc.meta.criticModel).toBe("critic-only:1b");
  });
});

// ---------------------------------------------------------------------------
// the converging run — blocker B01
// ---------------------------------------------------------------------------

describe("run — a run that converges on its first critique", () => {
  it("yields rounds.length === 1 — B01, and NOT an assertion about events", async () => {
    const { deps } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    const history = await run(deps, INPUT, cfg());

    // v1 snapshotted only on the `REVISING` exit, so this run returned
    // `rounds: []` — nothing to export, accept, render or measure.
    expect(history.rounds).toHaveLength(1);
    expect(history.rounds.length).not.toBe(0);
    expect(history.stopReason).toBe("no-high-severity");
    expect(history.outcome).toBe("completed");
    expect(history.finalState).toBe("AWAITING_USER");
    expect(history.error).toBeNull();
  });

  it("snapshots the round with revise and reviseMs null — phase one", async () => {
    const { deps } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    const history = await run(deps, INPUT, cfg());

    // A converged round has no revise stage, so it stays at phase one.
    expect(history.rounds[0].revise).toBeNull();
    expect(history.rounds[0].timings.reviseMs).toBeNull();
    expect(history.rounds[0].timings.draftMs).not.toBeNull();
    expect(history.rounds[0].timings.critiqueMs).not.toBeNull();
  });

  it("never enters REVISING", async () => {
    const { deps, stub, events } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    await run(deps, INPUT, cfg());

    expect(stateTrace(events)).not.toContain("REVISING:1");
    expect(countCalls(stub, "chatWithTools")).toBe(0);
  });

  it("emits the §7.1 state sequence, with round 0 before round 1 exists", async () => {
    const { deps, events } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    await run(deps, INPUT, cfg());

    expect(stateTrace(events)).toEqual([
      "DRAFTING:0",
      "LINTING:1",
      "CRITIQUING:1",
      "AWAITING_USER:1",
    ]);
    // `PipelineEvent.round` is `nonnegative()` deliberately — the field is
    // present and zero, not absent.
    const drafting = events[0];
    expect(drafting.type).toBe("state");
    if (drafting.type === "state") expect(drafting.round).toBe(0);
  });

  it("emits one round event carrying the whole snapshot", async () => {
    const { deps, events } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    const history = await run(deps, INPUT, cfg());
    const rounds = events.filter((e) => e.type === "round");

    expect(rounds).toHaveLength(1);
    expect(rounds[0].type === "round" && rounds[0].snapshot).toEqual(history.rounds[0]);
  });

  it("gives two runs distinct session ids", async () => {
    const a = harness({ generate: [draftReply()], vision: [CONVERGED] });
    const b = harness({ generate: [draftReply()], vision: [CONVERGED] });

    const first = await run(a.deps, INPUT, cfg());
    const second = await run(b.deps, INPUT, cfg());

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.sessionId.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ruling R2 — lint, critique and doc describe the same sprite
// ---------------------------------------------------------------------------

describe("run — ruling R2", () => {
  it("Round.lint is the lint report of Round.doc", async () => {
    const { deps } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    const history = await run(deps, INPUT, cfg());

    expect(history.rounds[0].lint).toEqual(lint(history.rounds[0].doc));
  });

  it("holds on every round of a multi-round run, including after a revise", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0), fillRowTurn(1)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    expect(history.rounds).toHaveLength(3);
    for (const round of history.rounds) {
      // v1's snapshot on the `REVISING` exit put a POST-revise doc beside a
      // PRE-revise lint and critique, so the dock highlighted issue regions
      // against pixels that had already changed.
      expect(round.lint).toEqual(lint(round.doc));
    }
  });

  it("critiques the doc it snapshots — each round's grid reaches its own critic call", async () => {
    const { deps, stub } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));
    const visionCalls = stub.calls.filter((c) => c.method === "vision");

    expect(visionCalls).toHaveLength(2);
    // Round 1's grid has a transparent row 0; round 2's has it filled. Each
    // critic call must carry its own round's rows — v1's snapshot on the
    // `REVISING` exit paired a post-revise doc with a pre-revise critique.
    expect(visionCalls[0].prompt).toContain(`00 ${".".repeat(16)}`);
    expect(visionCalls[0].prompt).not.toContain(`00 ${"1".repeat(16)}`);
    expect(visionCalls[1].prompt).toContain(`00 ${"1".repeat(16)}`);
    expect(history.rounds[0].doc.rows[0]).toBe(".".repeat(16));
    expect(history.rounds[1].doc.rows[0]).toBe("1".repeat(16));
  });

  it("stores the RAW critique and the filtered issues side by side", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      // One issue the filter keeps whole, one it keeps but blanks the suggestion
      // of, one it drops outright.
      vision: [
        critiqueReply([
          { id: "keep", confidence: 0.9, suggestConfidence: 0.8 },
          { id: "blank", confidence: 0.9, suggestConfidence: 0.1 },
          { id: "drop", confidence: 0.1, suggestConfidence: 0.9 },
        ]),
      ],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 1 }));
    const round = history.rounds[0];

    expect(round.critique?.issues.map((i) => i.id)).toEqual(["keep", "blank", "drop"]);
    expect(round.critique?.issues[1].suggest).not.toBe("");
    expect(round.filteredIssues.map((i) => i.id)).toEqual(["keep", "blank"]);
    expect(round.filteredIssues[1].suggest).toBe("");
  });
});

// ---------------------------------------------------------------------------
// stop conditions — spec §7.2
// ---------------------------------------------------------------------------

describe("run — stop conditions", () => {
  it("filters BEFORE evaluating: one high-severity issue at confidence 0.1 converges", async () => {
    const { deps, stub } = harness({
      generate: [draftReply()],
      vision: [critiqueReply([{ severity: "high", confidence: 0.1 }])],
    });

    const history = await run(deps, INPUT, cfg());

    expect(history.stopReason).toBe("no-high-severity");
    expect(history.rounds).toHaveLength(1);
    // The raw report keeps the issue; the revise stage never saw it.
    expect(history.rounds[0].critique?.issues).toHaveLength(1);
    expect(history.rounds[0].filteredIssues).toEqual([]);
    expect(countCalls(stub, "chatWithTools")).toBe(0);
  });

  it("stops with round-cap after exactly maxRounds critiques", async () => {
    const { deps, stub } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0), fillRowTurn(1)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    // §7.5: `maxRounds: 3` yields at most 3 critiques and 2 revise passes.
    expect(history.stopReason).toBe("round-cap");
    expect(history.rounds).toHaveLength(3);
    expect(countCalls(stub, "vision")).toBe(3);
    expect(countCalls(stub, "chatWithTools")).toBe(2);
    expect(history.outcome).toBe("completed");
  });

  it("honours maxRounds: 1 — the draft is round 1, so one critique and no revise", async () => {
    const { deps, stub } = harness({ generate: [draftReply()], vision: [HIGH] });

    const history = await run(deps, INPUT, cfg({ maxRounds: 1 }));

    expect(history.stopReason).toBe("round-cap");
    expect(history.rounds).toHaveLength(1);
    expect(countCalls(stub, "chatWithTools")).toBe(0);
  });

  it("prefers no-high-severity over round-cap when both would fire", async () => {
    const { deps } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    // §7.2's table order is not decorative: §11 counts convergence off this
    // field, and `round-cap` here would score a converged run as a failure.
    const history = await run(deps, INPUT, cfg({ maxRounds: 1 }));

    expect(history.stopReason).toBe("no-high-severity");
  });

  it("prefers it on the last permitted round with a non-empty issue list too", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [critiqueReply([{ severity: "medium" }, { severity: "low" }])],
    });

    // The sharp case for §7.2's ordering: issues remain, none is high, and the
    // round cap is already reached. Evaluating `round-cap` first reports a
    // converged run as one that ran out of rounds.
    const history = await run(deps, INPUT, cfg({ maxRounds: 1 }));

    expect(history.stopReason).toBe("no-high-severity");
    expect(history.rounds[0].filteredIssues).toHaveLength(2);
  });

  it("numbers rounds 1-based, matching the array position", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0), fillRowTurn(1)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    expect(history.rounds.map((r) => r.round)).toEqual([1, 2, 3]);
    expect(history.rounds.map((r) => r.doc.meta.round)).toEqual([1, 2, 3]);
  });
});

describe("run — the empty filtered list", () => {
  it("skips REVISING unconditionally, including with stopOnNoHighSeverity false", async () => {
    const { deps, stub } = harness({
      generate: [draftReply()],
      vision: [CONVERGED],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(deps, INPUT, cfg({ stopOnNoHighSeverity: false, maxRounds: 3 }));

    // §7.2: there is nothing for the agent to do and no prompt that would make
    // sense. v1 left this undefined and reached `REVISING` with an empty list.
    expect(countCalls(stub, "chatWithTools")).toBe(0);
    expect(history.stopReason).toBe("no-high-severity");
    expect(history.rounds).toHaveLength(1);
  });

  it("keeps revising on medium-only issues when stopOnNoHighSeverity is false", async () => {
    const { deps, stub } = harness({
      generate: [draftReply()],
      vision: [critiqueReply([{ severity: "medium" }])],
      chatWithTools: [fillRowTurn(0), fillRowTurn(1)],
    });

    const history = await run(deps, INPUT, cfg({ stopOnNoHighSeverity: false, maxRounds: 2 }));

    expect(countCalls(stub, "chatWithTools")).toBe(1);
    expect(history.stopReason).toBe("round-cap");
    expect(history.rounds).toHaveLength(2);
  });

  it("stops on medium-only issues when stopOnNoHighSeverity is true", async () => {
    const { deps, stub } = harness({
      generate: [draftReply()],
      vision: [critiqueReply([{ severity: "medium" }])],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    // v1's predicates were not mutually exclusive: one medium issue satisfied
    // both "no high-sev issues" and "issues remain".
    expect(history.stopReason).toBe("no-high-severity");
    expect(countCalls(stub, "chatWithTools")).toBe(0);
    expect(history.rounds[0].filteredIssues).toHaveLength(1);
  });
});

describe("run — empty-diff", () => {
  it("is computed as diff(before, after), never read from diffFromPrev", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0), fillRowTurn(1)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    // Round 1's stored `diffFromPrev` is `null` — the value a literal reading of
    // §6.7's v1 prose treated as "changed nothing", stopping every run right
    // after the draft with a bogus reason.
    expect(history.rounds[0].diffFromPrev).toBeNull();
    expect(history.stopReason).not.toBe("empty-diff");
    expect(history.stopReason).toBe("round-cap");
  });

  it("does not fire on a converging first round either", async () => {
    const { deps } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    const history = await run(deps, INPUT, cfg());

    expect(history.rounds[0].diffFromPrev).toBeNull();
    expect(history.stopReason).toBe("no-high-severity");
  });

  it("fires before the cap when a later revise changes nothing", async () => {
    const { deps, stub } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0), NOOP_TURN],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    // Round 1 revises for real; round 2's agent calls `done` without editing.
    expect(history.stopReason).toBe("empty-diff");
    expect(history.rounds).toHaveLength(2);
    expect(countCalls(stub, "vision")).toBe(2); // stopped before the 3rd critique
    expect(history.outcome).toBe("completed");
  });

  it("fires on round 1 too when the revise stage genuinely changed nothing", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [NOOP_TURN],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    // §7.2's trigger is "the revise stage ran and changed nothing", and it
    // catches a critic reporting an issue the agent cannot fix — which would
    // otherwise burn every remaining round. The distinction plan AC 4 draws is
    // between *computing* the diff (this) and *reading* `diffFromPrev` (the
    // test above), not between round 1 and the rest.
    expect(history.stopReason).toBe("empty-diff");
    expect(history.rounds).toHaveLength(1);
    // And phase two still ran: the no-op revise is recorded, not lost.
    expect(history.rounds[0].revise?.turns).toBe(1);
    expect(history.rounds[0].revise?.hitCap).toBe(false);
  });

  it("records the diff against the parent on a round that did change", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0), NOOP_TURN],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    // Row 0 of `DRAFT_ROWS` is 16 transparent cells; `fill_row` writes 16 `1`s.
    expect(history.rounds[1].diffFromPrev).toHaveLength(16);
    expect(history.rounds[1].diffFromPrev?.[0]).toEqual({ x: 0, y: 0, from: ".", to: "1" });
    expect(history.rounds[1].doc.meta.parentId).toBe(history.rounds[0].doc.id);
  });
});

// ---------------------------------------------------------------------------
// the revise regression guard — amendment A14, spec §7.2
//
// Built on `captures/2026-07-30-revise-tool-measurement.txt`, which measured the
// revise stage as net-negative under EVERY tool configuration tried: mean
// Δsymmetry −0.025 shipped, −0.074 with a canvas refresh, −0.157 with shape ops.
// There is no tooling fix, so this wave makes the loop SAFE rather than useful:
// `lint()` before and after the pass, and a candidate that is measurably worse
// is discarded.
// ---------------------------------------------------------------------------

/** The shipped bar, with named overrides. */
function bar(over: Partial<ReviseRegressionBar> = {}): ReviseRegressionBar {
  return { ...DEFAULT_HARNESS_CONFIG.reviseRegressionBar, ...over };
}

/** Lint metrics with everything at a benign value except what a test names. */
function metrics(over: Partial<LintReport["metrics"]> = {}): LintReport["metrics"] {
  return { coverage: 0.5, paletteUsed: 4, orphanCount: 0, symmetryScore: 1, ...over };
}

describe("reviseRegression — the bar itself", () => {
  it("passes an identical pair", () => {
    expect(reviseRegression(metrics(), metrics(), bar())).toBeNull();
  });

  it("passes a strictly better pair — the guard must not block progress", () => {
    const before = metrics({ symmetryScore: 0.4, coverage: 0.1, orphanCount: 3 });
    const after = metrics({ symmetryScore: 0.9, coverage: 0.2, orphanCount: 0 });

    expect(reviseRegression(before, after, bar())).toBeNull();
  });

  // -- symmetry ------------------------------------------------------------

  it("names symmetry on the real round-1 → round-2 numbers", () => {
    const found = reviseRegression(
      metrics({ symmetryScore: 0.9130434782608695, coverage: 0.1796875 }),
      metrics({ symmetryScore: 0.4931506849315068, coverage: 0.28515625 }),
      bar(),
    );

    expect(found?.metric).toBe("symmetry");
  });

  it("leaves the capture's round-2 → round-3 transition alone — the bar is conservative", () => {
    // The other end of the calibration, from the same capture: symmetry
    // 0.493 → 0.441, coverage 0.285 → 0.230, orphans 0 → 0. A drop of 0.052 and
    // a relative coverage loss of 0.192 are both inside the bar, and they
    // should be — a guard that also refused this one would be refusing ordinary
    // work, and "reject everything" is not a monotonic loop, it is a disabled
    // stage.
    //
    // Note what this does NOT catch, because it is a real limit rather than an
    // oversight: round 3 is the frame with the floating yellow bar, and
    // `orphanCount` is **0** on it. §6.5 defines an orphan as a cell whose four
    // orthogonal neighbours are all transparent, so two stacked detached cells
    // rescue each other and a detached *bar* is invisible to the metric. The
    // orphan check catches detached pixels, not detached components.
    const found = reviseRegression(
      metrics({ symmetryScore: 0.4931506849315068, coverage: 0.28515625, orphanCount: 0 }),
      metrics({ symmetryScore: 0.4406779661016949, coverage: 0.23046875, orphanCount: 0 }),
      bar(),
    );

    expect(found).toBeNull();
  });

  it("accepts a symmetry drop exactly EQUAL to the bar", () => {
    // `maxSymmetryDrop` reads as "at most this much", so the comparison is `>`
    // and the boundary value is inside the bar. Dyadic figures, so the
    // subtraction is exact and the assertion is about the comparison rather
    // than about binary floating point: 0.75 − 0.5 is 0.25 to the last bit,
    // where 1 − 0.85 is 0.15000000000000002 and would decide the opposite way
    // for reasons that have nothing to do with sprites.
    const found = reviseRegression(
      metrics({ symmetryScore: 0.75 }),
      metrics({ symmetryScore: 0.5 }),
      bar({ maxSymmetryDrop: 0.25 }),
    );

    expect(found).toBeNull();
  });

  it("rejects a symmetry drop one step past the bar", () => {
    const found = reviseRegression(
      metrics({ symmetryScore: 0.75 }),
      metrics({ symmetryScore: 0.5 }),
      bar({ maxSymmetryDrop: 0.125 }),
    );

    expect(found?.metric).toBe("symmetry");
    expect(found?.before).toBe(0.75);
    expect(found?.after).toBe(0.5);
    expect(found?.delta).toBe(0.25);
    expect(found?.limit).toBe(0.125);
  });

  it("reads maxSymmetryDrop: 0 as 'no drop at all', not as absent", () => {
    // The falsy-zero probe on this threshold. `0` is the strictest legal
    // setting and every `bar.maxSymmetryDrop || 0.15` reads it as unset.
    expect(
      reviseRegression(
        metrics({ symmetryScore: 0.5 }),
        metrics({ symmetryScore: 0.5 }),
        bar({ maxSymmetryDrop: 0 }),
      ),
    ).toBeNull();
    expect(
      reviseRegression(
        metrics({ symmetryScore: 0.5 }),
        metrics({ symmetryScore: 0.25 }),
        bar({ maxSymmetryDrop: 0 }),
      )?.metric,
    ).toBe("symmetry");
  });

  it("tests a DROP, never an absolute floor — an asymmetric sprite is legitimate", () => {
    // A side-facing dog scores near zero and is exactly what the app is for.
    // A floor would refuse every revision of every such sprite.
    expect(
      reviseRegression(metrics({ symmetryScore: 0.1 }), metrics({ symmetryScore: 0.1 }), bar()),
    ).toBeNull();
    expect(
      reviseRegression(metrics({ symmetryScore: 0 }), metrics({ symmetryScore: 0 }), bar()),
    ).toBeNull();
  });

  // -- orphans -------------------------------------------------------------

  it("reads maxOrphanIncrease: 0 as 'no new orphans', not as 'check disabled'", () => {
    // The single most likely defect in A14, and the fifth near-miss of its kind
    // in this project. `0` is the shipped default and it is a real bound.
    expect(
      reviseRegression(
        metrics({ orphanCount: 0 }),
        metrics({ orphanCount: 1 }),
        bar({ maxOrphanIncrease: 0 }),
      )?.metric,
    ).toBe("orphans");
    // And through the default rather than an explicit override, because those
    // are two different reads of the same field.
    expect(
      reviseRegression(metrics({ orphanCount: 0 }), metrics({ orphanCount: 1 }), bar())?.metric,
    ).toBe("orphans");
  });

  it("allows orphans that were already there, and rewards removing them", () => {
    expect(
      reviseRegression(metrics({ orphanCount: 4 }), metrics({ orphanCount: 4 }), bar()),
    ).toBeNull();
    expect(
      reviseRegression(metrics({ orphanCount: 4 }), metrics({ orphanCount: 1 }), bar()),
    ).toBeNull();
  });

  it("honours a raised orphan bar — it is a threshold, not a constant", () => {
    expect(
      reviseRegression(
        metrics({ orphanCount: 0 }),
        metrics({ orphanCount: 2 }),
        bar({ maxOrphanIncrease: 2 }),
      ),
    ).toBeNull();
    expect(
      reviseRegression(
        metrics({ orphanCount: 0 }),
        metrics({ orphanCount: 3 }),
        bar({ maxOrphanIncrease: 2 }),
      )?.metric,
    ).toBe("orphans");
  });

  // -- coverage ------------------------------------------------------------

  it("compares coverage RELATIVELY, not absolutely", () => {
    // 0.12 → 0.06 loses half the sprite. The absolute difference is 0.06, well
    // inside a 0.25 bar, so an absolute comparison could not fire here — and on
    // a 16×16, where coverage runs 0.10–0.30, it could barely fire at all.
    const found = reviseRegression(
      metrics({ coverage: 0.12 }),
      metrics({ coverage: 0.06 }),
      bar({ maxCoverageDrop: 0.25 }),
    );

    expect(found?.metric).toBe("coverage");
    expect(found?.delta).toBeCloseTo(0.5, 12);
    // The absolute difference, which the mutant would have compared.
    expect(0.12 - 0.06).toBeLessThan(0.25);
  });

  it("accepts a relative coverage drop exactly EQUAL to the bar", () => {
    const found = reviseRegression(
      metrics({ coverage: 0.5 }),
      metrics({ coverage: 0.375 }),
      bar({ maxCoverageDrop: 0.25 }),
    );

    expect(found).toBeNull();
  });

  it("does not police coverage GROWTH — that is what the reviser actually does", () => {
    // Every measured condition raised coverage while dropping symmetry. Making
    // growth a regression would fire on every pass and make revise useless.
    expect(
      reviseRegression(metrics({ coverage: 0.18 }), metrics({ coverage: 0.285 }), bar()),
    ).toBeNull();
  });

  it("reads maxCoverageDrop: 0 as 'no loss at all', not as absent", () => {
    expect(
      reviseRegression(
        metrics({ coverage: 0.5 }),
        metrics({ coverage: 0.5 }),
        bar({ maxCoverageDrop: 0 }),
      ),
    ).toBeNull();
    expect(
      reviseRegression(
        metrics({ coverage: 0.5 }),
        metrics({ coverage: 0.49 }),
        bar({ maxCoverageDrop: 0 }),
      )?.metric,
    ).toBe("coverage");
  });

  it("survives a blank before-canvas rather than dividing by zero", () => {
    // `coverage: 0` is reachable — §6.5 scores an empty canvas symmetry 1, so a
    // model returning 16 rows of dots lands here. `(0 − 0) / 0` is `NaN`, and
    // `NaN > limit` is `false`, so the check would silently pass; it is spelled
    // out rather than left to that accident.
    expect(reviseRegression(metrics({ coverage: 0 }), metrics({ coverage: 0 }), bar())).toBeNull();
    expect(
      reviseRegression(metrics({ coverage: 0 }), metrics({ coverage: 0.2 }), bar()),
    ).toBeNull();
  });

  it("reports symmetry first when more than one threshold is breached", () => {
    // Not arbitrary: §6.5's symmetry is the signal the measurement identified,
    // and a stable order keeps the reason string deterministic.
    const found = reviseRegression(
      metrics({ symmetryScore: 1, coverage: 0.5, orphanCount: 0 }),
      metrics({ symmetryScore: 0, coverage: 0.1, orphanCount: 9 }),
      bar(),
    );

    expect(found?.metric).toBe("symmetry");
  });
});

describe("run — the revise regression guard", () => {
  /** The wave-11 script: draft round 1, critique it, revise it into round 2. */
  function wave11() {
    return harness({
      generate: [draftReply(WAVE11_ROUND_1)],
      vision: [HIGH],
      chatWithTools: [rewriteTurn(WAVE11_ROUND_1, WAVE11_ROUND_2, WAVE11_SUMMARY)],
    });
  }

  it("REJECTS the real round-1 → round-2 transition the user watched", async () => {
    // The headline. `captures/2026-07-30-wave-11-rounds.txt` recorded symmetry
    // 0.913 → 0.493 across this exact pair of grids. A guard that would not have
    // saved this sprite has failed, whatever else it does.
    const { deps } = wave11();

    const history = await run(deps, DOG_INPUT, cfg({ maxRounds: 3 }));

    // The capture's own numbers, recomputed by `lint()` from the stored doc —
    // so the fixture is pinned to the session rather than to my arithmetic.
    expect(history.rounds[0].lint.metrics.symmetryScore).toBeCloseTo(0.913, 3);
    expect(history.rounds[0].lint.metrics.coverage).toBeCloseTo(0.18, 3);
    expect(history.rounds[0].lint.metrics.orphanCount).toBe(0);

    expect(history.stopReason).toBe("revise-regressed");
  });

  it("keeps the BEFORE document — round 2 never enters the history", async () => {
    const { deps } = wave11();

    const history = await run(deps, DOG_INPUT, cfg({ maxRounds: 3 }));

    expect(history.rounds).toHaveLength(1);
    expect(history.rounds[0].doc.rows).toEqual(WAVE11_ROUND_1);
    // Not merely "the last round is the good one" — the wrecked grid must not
    // be anywhere, because §8's filmstrip renders every round.
    for (const round of history.rounds) {
      expect(round.doc.rows).not.toEqual(WAVE11_ROUND_2);
    }
  });

  it("still records Round.revise on the rejected pass — turns, hitCap, summary", async () => {
    const { deps } = wave11();

    const history = await run(deps, DOG_INPUT, cfg({ maxRounds: 3 }));

    // A rejected pass is data. `summary` is known-unreliable prose — this very
    // round claimed it "replaced the cupcake-like region with a dog shape"
    // while dropping symmetry by 0.42 — which is a reason to keep recording it,
    // not a reason to start trusting it.
    expect(history.rounds[0].revise).not.toBeNull();
    expect(history.rounds[0].revise?.turns).toBe(1);
    expect(history.rounds[0].revise?.hitCap).toBe(false);
    expect(history.rounds[0].revise?.summary).toBe(WAVE11_SUMMARY);
    expect(history.rounds[0].timings.reviseMs).not.toBeNull();
  });

  it("stops the loop and does NOT retry — a retry draws from the same distribution", async () => {
    const { deps, stub, events } = wave11();

    const history = await run(deps, DOG_INPUT, cfg({ maxRounds: 3 }));

    expect(countCalls(stub, "chatWithTools")).toBe(1);
    expect(countCalls(stub, "vision")).toBe(1);
    expect(stateTrace(events)).not.toContain("LINTING:2");
    expect(history.outcome).toBe("completed");
    expect(history.finalState).toBe("AWAITING_USER");
    expect(history.error).toBeNull();
  });

  it("persists the rejection, so a reload reads the same verdict", async () => {
    const { deps, saved } = wave11();

    await run(deps, DOG_INPUT, cfg({ maxRounds: 3 }));

    const last = saved[saved.length - 1];
    expect(last.stopReason).toBe("revise-regressed");
    expect(last.outcome).toBe("completed");
    for (const written of saved) {
      for (const round of written.rounds) {
        expect(round.doc.rows).not.toEqual(WAVE11_ROUND_2);
      }
    }
  });

  it("accepts the SAME pass when the bar is widened — the fixture really is round 2", async () => {
    // The other half of the headline, and the "guard always fires" mutant's
    // death: with the symmetry bar opened all the way, this identical script
    // runs to the round cap and stores the wave-11 round-2 grid verbatim. So
    // the rejection above is the guard's decision, not a broken fixture.
    const { deps } = wave11();

    const history = await run(
      deps,
      DOG_INPUT,
      cfg({ maxRounds: 2, reviseRegressionBar: bar({ maxSymmetryDrop: 1 }) }),
    );

    expect(history.rounds).toHaveLength(2);
    expect(history.rounds[1].doc.rows).toEqual(WAVE11_ROUND_2);
    expect(history.rounds[1].lint.metrics.symmetryScore).toBeCloseTo(0.493, 3);
    expect(history.rounds[0].diffFromPrev).toBeNull();
    expect(history.rounds[1].diffFromPrev).toHaveLength(44); // the capture's own figure
    expect(history.stopReason).toBe("round-cap");
  });

  // -- the guard must not block progress -----------------------------------

  it("accepts a revision that IMPROVES symmetry", async () => {
    const { deps } = harness({
      generate: [draftReply(LOPSIDED_ROWS)],
      vision: [HIGH],
      chatWithTools: [rewriteTurn(LOPSIDED_ROWS, MIRRORED_ROWS, "mirrored the body")],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));

    expect(history.rounds).toHaveLength(2);
    expect(history.rounds[0].lint.metrics.symmetryScore).toBe(0);
    expect(history.rounds[1].lint.metrics.symmetryScore).toBe(1);
    expect(history.stopReason).toBe("round-cap");
    expect(history.stopReason).not.toBe("revise-regressed");
  });

  it("accepts a revision that leaves every guarded metric UNCHANGED", async () => {
    // A recolour of a mirrored pair: coverage, orphans and symmetry are all
    // identical afterwards, and only `paletteUsed` — which the bar does not
    // police — moved. A guard that fires here fires on everything.
    const recoloured = DRAFT_ROWS.map((row, y) =>
      y === 6 ? `${row.slice(0, 6)}2${row.slice(7, 9)}2${row.slice(10)}` : row,
    );
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [rewriteTurn(DRAFT_ROWS, recoloured, "recoloured the top corners")],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));

    expect(history.rounds).toHaveLength(2);
    expect(history.rounds[1].doc.rows).toEqual(recoloured);
    expect(history.rounds[0].lint.metrics).toMatchObject({
      symmetryScore: 1,
      orphanCount: 0,
      coverage: 0.0625,
    });
    expect(history.rounds[1].lint.metrics).toMatchObject({
      symmetryScore: 1,
      orphanCount: 0,
      coverage: 0.0625,
    });
    expect(history.stopReason).toBe("round-cap");
  });

  // -- the other two thresholds, end to end --------------------------------

  it("rejects a pass that adds orphans, with maxOrphanIncrease at its default 0", async () => {
    // Two mirrored corner pixels: symmetry stays 1 and coverage rises, so the
    // orphan check is the only one that can fire. Wave 11's round 3 left a
    // floating bar attached to nothing; this is the decidable version of it.
    const orphaned = DRAFT_ROWS.map((row, y) => (y === 0 ? `1${row.slice(1, 15)}1` : row));
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [rewriteTurn(DRAFT_ROWS, orphaned, "added highlights")],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    expect(history.stopReason).toBe("revise-regressed");
    expect(history.rounds).toHaveLength(1);
    expect(history.rounds[0].doc.rows).toEqual(DRAFT_ROWS);
  });

  it("accepts the same orphan pass when the bar is raised to 2", async () => {
    const orphaned = DRAFT_ROWS.map((row, y) => (y === 0 ? `1${row.slice(1, 15)}1` : row));
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [rewriteTurn(DRAFT_ROWS, orphaned, "added highlights")],
    });

    const history = await run(
      deps,
      INPUT,
      cfg({ maxRounds: 2, reviseRegressionBar: bar({ maxOrphanIncrease: 2 }) }),
    );

    expect(history.rounds).toHaveLength(2);
    expect(history.rounds[1].lint.metrics.orphanCount).toBe(2);
    expect(history.rounds[1].lint.metrics.symmetryScore).toBe(1);
    expect(history.stopReason).toBe("round-cap");
  });

  it("rejects a pass that loses half the sprite — relatively, not absolutely", async () => {
    // 32 cells → 16. The relative drop is 0.5 and fires; the absolute drop is
    // 0.0625, which no bar in 0..1 that also permits normal work could catch.
    const halved = slabWithout(8, 9);
    const { deps } = harness({
      generate: [draftReply(SLAB_ROWS)],
      vision: [HIGH],
      chatWithTools: [rewriteTurn(SLAB_ROWS, halved, "tightened the silhouette")],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    expect(history.rounds[0].lint.metrics.coverage).toBe(0.125);
    expect(history.stopReason).toBe("revise-regressed");
    expect(history.rounds).toHaveLength(1);
    expect(history.rounds[0].doc.rows).toEqual(SLAB_ROWS);
  });

  it("accepts a pass losing exactly a quarter of the sprite — the boundary", async () => {
    // 32 cells → 24: a relative drop of exactly 0.25, which `maxCoverageDrop:
    // 0.25` admits. Symmetry stays 1 and no orphan appears, so this isolates
    // the comparison operator.
    const trimmed = slabWithout(9);
    const { deps } = harness({
      generate: [draftReply(SLAB_ROWS)],
      vision: [HIGH],
      chatWithTools: [rewriteTurn(SLAB_ROWS, trimmed, "trimmed one row")],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));

    expect(history.rounds).toHaveLength(2);
    expect(history.rounds[1].doc.rows).toEqual(trimmed);
    expect(history.rounds[1].lint.metrics.coverage).toBe(0.09375);
    expect(history.stopReason).toBe("round-cap");
  });

  // -- before-vs-after, per round -------------------------------------------

  it("compares each round against ITS OWN pre-revise document", async () => {
    // Round 1 revises cleanly and is kept; round 2's pass wrecks the result and
    // is discarded. An implementation that compared the candidate with itself —
    // or that computed the baseline once, before the loop — gets one of these
    // two rounds wrong.
    const afterFill = DRAFT_ROWS.map((row, y) => (y === 0 ? "1".repeat(16) : row));
    const wrecked = afterFill.map((row, y) => (y === 0 ? `${".".repeat(8)}11111111` : row));
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0), rewriteTurn(afterFill, wrecked, "cleared the left")],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 4 }));

    expect(history.rounds).toHaveLength(2);
    expect(history.rounds[0].doc.rows).toEqual(DRAFT_ROWS);
    expect(history.rounds[1].doc.rows).toEqual(afterFill);
    expect(history.rounds[1].lint.metrics.symmetryScore).toBe(1);
    expect(history.rounds[1].revise?.summary).toBe("cleared the left");
    expect(history.stopReason).toBe("revise-regressed");
  });

  it("lets empty-diff win when the pass changed nothing at all", async () => {
    // An unchanged grid has unchanged metrics, so the guard cannot fire on it —
    // and `empty-diff` is the honest reason. Pinned so the two verdicts do not
    // trade places if the checks are ever reordered.
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [NOOP_TURN],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    expect(history.stopReason).toBe("empty-diff");
    expect(history.stopReason).not.toBe("revise-regressed");
  });
});

describe("applyFeedback — the revise regression guard", () => {
  it("guards the user's pass too — one code path, per §7.3", async () => {
    const first = harness({
      generate: [draftReply(WAVE11_ROUND_1)],
      vision: [CONVERGED],
    });
    const history = await run(first.deps, DOG_INPUT, cfg({ maxRounds: 3 }));
    expect(history.rounds).toHaveLength(1);

    const { deps, stub } = harness({
      vision: [HIGH],
      chatWithTools: [rewriteTurn(WAVE11_ROUND_1, WAVE11_ROUND_2, WAVE11_SUMMARY)],
    });
    const next = await applyFeedback(deps, history, "make it look more like a dog", 0, cfg());

    expect(next.stopReason).toBe("revise-regressed");
    expect(next.rounds).toHaveLength(1);
    expect(next.rounds[0].doc.rows).toEqual(WAVE11_ROUND_1);
    // Phase two still ran on the source round — §7.3 writes the pass's summary
    // onto the round it revised from, rejected or not.
    expect(next.rounds[0].revise?.summary).toBe(WAVE11_SUMMARY);
    expect(next.rounds[0].timings.reviseMs).not.toBeNull();
    // The loop stopped: no critique of a document that was never kept.
    expect(countCalls(stub, "vision")).toBe(0);
    expect(next.finalState).toBe("AWAITING_USER");
    expect(next.outcome).toBe("completed");
  });

  it("does not block a user's pass that leaves the metrics alone", async () => {
    const first = harness({ generate: [draftReply()], vision: [CONVERGED] });
    const history = await run(first.deps, INPUT, cfg({ maxRounds: 3 }));

    const { deps } = harness({ vision: [CONVERGED], chatWithTools: [fillRowTurn(0)] });
    const next = await applyFeedback(deps, history, "fill the top row", 0, cfg({ maxRounds: 3 }));

    expect(next.rounds).toHaveLength(2);
    expect(next.stopReason).toBe("no-high-severity");
    expect(next.rounds[1].userFeedback).toBe("fill the top row");
  });
});

describe("run — critic-failed", () => {
  it("stops with critic-failed, never no-high-severity, on two unparseable critiques", async () => {
    // The stub reuses its last entry, so the reprompt gets the same prose and
    // `critique()` degrades.
    const { deps, stub } = harness({
      generate: [draftReply()],
      vision: ["I could not see the image clearly."],
    });

    const history = await run(deps, INPUT, cfg());

    expect(history.stopReason).toBe("critic-failed");
    expect(history.stopReason).not.toBe("no-high-severity");
    // §11 reads `outcome` for "completes without crash": a degraded critic is
    // not a crash.
    expect(history.outcome).toBe("completed");
    expect(history.finalState).toBe("AWAITING_USER");
    expect(countCalls(stub, "vision")).toBe(2); // the one reprompt §9 allows
  });

  it("records the degraded report rather than inventing a score", async () => {
    const { deps } = harness({ generate: [draftReply()], vision: ["not json"] });

    const history = await run(deps, INPUT, cfg());

    expect(history.rounds).toHaveLength(1);
    expect(history.rounds[0].critique?.degraded).toBe(true);
    expect(history.rounds[0].critique?.overall).toBeNull();
    expect(history.rounds[0].critique?.readsAs).toBeNull();
    expect(history.rounds[0].filteredIssues).toEqual([]);
  });

  it("beats round-cap and never reaches REVISING", async () => {
    const { deps, stub, events } = harness({
      generate: [draftReply()],
      vision: ["not json"],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 1 }));

    expect(history.stopReason).toBe("critic-failed");
    expect(countCalls(stub, "chatWithTools")).toBe(0);
    expect(stateTrace(events)).not.toContain("REVISING:1");
  });
});

// ---------------------------------------------------------------------------
// the two-phase round lifecycle — spec §6.7
// ---------------------------------------------------------------------------

describe("run — the two-phase round", () => {
  it("populates revise.turns and timings.reviseMs on a revised round", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));

    // Without phase two these are permanently `null` on every round, which
    // makes `turns`, `hitCap` and `summary` dead exactly as they were before
    // the audit added them, and silently empties three bench CSV columns.
    expect(history.rounds[0].revise).not.toBeNull();
    expect(history.rounds[0].revise?.turns).toBe(1);
    expect(history.rounds[0].revise?.hitCap).toBe(false);
    expect(history.rounds[0].revise?.summary).toBe("filled row 0");
    expect(history.rounds[0].timings.reviseMs).not.toBeNull();
    expect(typeof history.rounds[0].timings.reviseMs).toBe("number");
  });

  it("leaves the last round at phase one — it has no revise stage", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));

    expect(history.rounds[1].revise).toBeNull();
    expect(history.rounds[1].timings.reviseMs).toBeNull();
  });

  it("records hitCap and the harness summary when the agent never calls done", async () => {
    // A script that narrates forever: the cap is what ends the pass.
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [NARRATING_TURN],
    });
    const history = await run(deps, INPUT, cfg({ maxRounds: 2, maxReviseTurns: 3 }));

    expect(history.rounds[0].revise?.turns).toBe(3);
    expect(history.rounds[0].revise?.hitCap).toBe(true);
    expect(history.rounds[0].revise?.summary).toContain("3-turn cap");
    // Nothing was edited, so the transition takes the empty edge.
    expect(history.stopReason).toBe("empty-diff");
  });

  it("records draftMs on round 1 only", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));

    expect(history.rounds[0].timings.draftMs).not.toBeNull();
    expect(history.rounds[1].timings.draftMs).toBeNull();
  });

  it("emits a second round event carrying the completed round", async () => {
    const { deps, events } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));
    const snapshots = events
      .filter((e): e is Extract<PipelineEvent, { type: "round" }> => e.type === "round")
      .map((e) => e.snapshot);

    // Phase one for round 1, phase two for round 1, phase one for round 2. The
    // renderer has no other source for `revise`/`reviseMs` before `run()`
    // resolves at the gate, minutes later.
    expect(snapshots.map((s) => s.round)).toEqual([1, 1, 2]);
    expect(snapshots[0].revise).toBeNull();
    expect(snapshots[1].revise).not.toBeNull();
    expect(snapshots[1]).toEqual(history.rounds[0]);
  });
});

// ---------------------------------------------------------------------------
// what the revise stage is handed — spec §6.4, §7.4
// ---------------------------------------------------------------------------

describe("run — the revise prompt", () => {
  /**
   * Three issues the two-tier filter treats three different ways, each with text
   * no other fixture uses: one kept whole, one kept with its suggestion blanked
   * by `suggestConfidenceFloor`, one dropped outright by `confidenceFloor`.
   */
  const MIXED = critiqueReply([
    {
      id: "keep",
      confidence: 0.9,
      suggestConfidence: 0.8,
      issue: "KEPT-ISSUE",
      suggest: "KEPT-SUGGEST",
    },
    {
      id: "blank",
      confidence: 0.9,
      suggestConfidence: 0.1,
      issue: "BLANKED-ISSUE",
      suggest: "BLANKED-SUGGEST",
    },
    {
      id: "drop",
      confidence: 0.1,
      suggestConfidence: 0.9,
      issue: "DROPPED-ISSUE",
      suggest: "DROPPED-SUGGEST",
    },
  ]);

  /**
   * The user message of the first `chatWithTools` call — literally what the agent
   * read. Asserted on the recorded call rather than on `Round.filteredIssues`,
   * because the round is a record of what the stage was *meant* to receive and
   * this is what it received.
   */
  async function revisePrompt(): Promise<{ prompt: string; history: SessionHistory }> {
    const { deps, stub } = harness({
      generate: [draftReply()],
      vision: [MIXED],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));
    const chat = stub.calls.find((c) => c.method === "chatWithTools");
    const user = chat?.messages?.find((m) => m.role === "user");

    expect(user).toBeDefined();
    return { prompt: user?.content ?? "", history };
  }

  it("never shows the agent an issue the confidence floor dropped", async () => {
    const { prompt } = await revisePrompt();

    // A sub-floor issue in the prompt burns revise turns on a finding §6.4 has
    // already ruled untrustworthy — and there is no `maxRounds` budget to spare.
    expect(prompt).not.toContain("DROPPED-ISSUE");
    expect(prompt).not.toContain("DROPPED-SUGGEST");
    expect(prompt).toContain("KEPT-ISSUE");
    expect(prompt).toContain("2 issues to fix");
    expect(prompt).not.toContain("3 issues to fix");
  });

  it("shows a blanked issue's text WITHOUT the suggestion the floor blanked", async () => {
    const { prompt } = await revisePrompt();

    // §6.4 empties a low-confidence suggestion rather than dropping the whole
    // issue, precisely so the agent keeps the problem and loses only the guess.
    // Handing the guess over anyway destroys the one signal the two floors exist
    // to separate: high confidence in the fault, low confidence in the fix.
    expect(prompt).toContain("BLANKED-ISSUE");
    expect(prompt).not.toContain("BLANKED-SUGGEST");
    // And suggestions ARE printed, so the absence above is the filter's doing
    // and not the renderer declining to print any suggestion at all.
    expect(prompt).toContain("KEPT-SUGGEST");
  });

  it("agrees with Round.filteredIssues, which documents what the stage received", async () => {
    const { prompt, history } = await revisePrompt();
    const round = history.rounds[0];

    expect(round.filteredIssues.map((i) => i.id)).toEqual(["keep", "blank"]);
    for (const issue of round.filteredIssues) {
      expect(prompt).toContain(issue.issue);
    }
    // The raw report keeps all three; the one the filter dropped is in the
    // record and nowhere near the agent. If the prompt were built from
    // `critique.issues`, `filteredIssues` would be a false claim about what the
    // revise stage actually received.
    const dropped = round.critique?.issues.filter(
      (i) => !round.filteredIssues.some((kept) => kept.id === i.id),
    );
    expect(dropped?.map((i) => i.id)).toEqual(["drop"]);
    for (const issue of dropped ?? []) {
      expect(prompt).not.toContain(issue.issue);
      expect(prompt).not.toContain(issue.suggest);
    }
  });
});

// ---------------------------------------------------------------------------
// persistence — spec §6.7, §9
// ---------------------------------------------------------------------------

describe("run — persist", () => {
  it("persists once per round on a converging run, plus the terminal write", async () => {
    const { deps, saved } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    await run(deps, INPUT, cfg());

    expect(saved).toHaveLength(2);
    expect(saved[0].rounds).toHaveLength(1);
    expect(saved[1].stopReason).toBe("no-high-severity");
  });

  it("persists twice for a revised round — snapshot then completion", async () => {
    const { deps, saved } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0)],
    });

    await run(deps, INPUT, cfg({ maxRounds: 2 }));

    // round 1 snapshot, round 1 completion, round 2 snapshot, terminal.
    expect(saved).toHaveLength(4);
    expect(saved[0].rounds[0].revise).toBeNull();
    expect(saved[1].rounds[0].revise).not.toBeNull();
    expect(saved[2].rounds).toHaveLength(2);
  });

  it("reads outcome 'failed' on every mid-run artifact", async () => {
    const { deps, saved } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0)],
    });

    await run(deps, INPUT, cfg({ maxRounds: 2 }));

    // §6.7: an interrupted run IS a failed run, and §11's first bar reads this
    // exact field off the persisted artifact.
    for (const midRun of saved.slice(0, -1)) {
      expect(midRun.outcome).toBe("failed");
      expect(midRun.stopReason).toBeNull();
    }
    expect(saved[saved.length - 1].outcome).toBe("completed");
  });

  it("names the state it had reached on each mid-run artifact", async () => {
    const { deps, saved } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0)],
    });

    await run(deps, INPUT, cfg({ maxRounds: 2 }));

    expect(saved.map((h) => h.finalState)).toEqual([
      "CRITIQUING",
      "REVISING",
      "CRITIQUING",
      "AWAITING_USER",
    ]);
  });

  it("runs without a persist callback at all", async () => {
    const stub = createStubClient({ generate: [draftReply()], vision: [CONVERGED] });

    const history = await run({ client: stub, onEvent: () => {} }, INPUT, cfg());

    expect(history.rounds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// a persist that fails — spec §6.7, §9
//
// Every `persist` is guarded, the way `fail()` always guarded its own: "a
// history that cannot be written is a worse thing to report than the failure
// already being reported" is not a statement about the failure path. A write
// that throws must not reject `run()` and must not discard the rounds already
// in memory — a full disk is not the loss of a multi-minute run — and the
// failure is recorded on `SessionHistory.error`, which is the field §8 has the
// status bar read after a reload.
// ---------------------------------------------------------------------------

describe("run — a persist that fails", () => {
  /** A revised run writes four times: 1 snapshot, 1 completion, 2 snapshot, terminal. */
  const REVISED_RUN: StubScript = {
    generate: [draftReply()],
    vision: [HIGH],
    chatWithTools: [fillRowTurn(0, "filled row 0")],
  };

  it("resolves with the complete history when the TERMINAL write throws", async () => {
    const script = { generate: [draftReply()], vision: [CONVERGED] };
    const { deps, saved } = harness(script, (write) => write === 2);

    const history = await run(deps, INPUT, cfg());

    // The run converged. Rejecting here reported a run that succeeded as a total
    // loss: Wave 10 surfaces the rejection as `{ok: false}` with `currentSession`
    // never set, so the sprite the user waited minutes for is unreachable.
    expect(history.rounds).toHaveLength(1);
    expect(history.outcome).toBe("completed");
    expect(history.stopReason).toBe("no-high-severity");
    expect(history.finalState).toBe("AWAITING_USER");
    // `outcome` reports what the PIPELINE achieved. The disk is a separate fact.
    expect(history.error).toBe("Error: ENOSPC: no space left on device, write");
    expect(saved).toHaveLength(2);
  });

  it("does not lose already-snapshotted rounds when a MID-RUN write throws", async () => {
    // The reviewer's case: write 3 of 4, with two rounds and a revise pass
    // already in memory.
    const { deps, saved } = harness(REVISED_RUN, (w) => w === 3);

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));

    expect(history.rounds).toHaveLength(2);
    expect(history.rounds[0].revise?.summary).toBe("filled row 0");
    expect(history.rounds[0].timings.reviseMs).not.toBeNull();
    expect(history.rounds[1].doc.rows[0]).toBe("1".repeat(16));
    expect(history.outcome).toBe("completed");
    expect(history.stopReason).toBe("round-cap");
    // A failed write does not stop the writes after it: the terminal one is
    // still attempted, and it is the one that would land once the disk recovers.
    expect(saved).toHaveLength(4);
  });

  it("carries the recorded failure into the next write that DOES land", async () => {
    // The zero-th case for the guard: the very first write of the run, before
    // any round has been completed.
    const script = { generate: [draftReply()], vision: [CONVERGED] };
    const { deps, saved } = harness(script, (write) => write === 1);

    const history = await run(deps, INPUT, cfg());

    expect(history.error).toBe("Error: ENOSPC: no space left on device, write");
    expect(history.rounds).toHaveLength(1);
    expect(history.outcome).toBe("completed");
    // The write that failed is the one the artifact is missing; the next one
    // that succeeds carries the record of it, so a reload can still say so.
    expect(saved[saved.length - 1].error).toBe("Error: ENOSPC: no space left on device, write");
  });

  it("survives EVERY write failing — the run is still the run", async () => {
    const { deps, saved } = harness(REVISED_RUN, () => true);

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));

    expect(history.rounds).toHaveLength(2);
    expect(history.outcome).toBe("completed");
    expect(history.stopReason).toBe("round-cap");
    expect(history.error).toBe("Error: ENOSPC: no space left on device, write");
    expect(saved).toHaveLength(4);
  });

  it("reports the CAUSE, not the record: a stage failure outranks the failed write", async () => {
    // A draft rejection with nothing yet snapshotted — the zero-round case, and
    // the one place `error` is the only account of why the run ended.
    const { deps } = harness({ generate: [PROSE] }, () => true);

    const history = await run(deps, INPUT, cfg({ maxDraftRetries: 0 }));

    expect(history.finalState).toBe("FAILED");
    expect(history.outcome).toBe("failed");
    expect(history.rounds).toEqual([]);
    expect(history.error).toMatch(/^DraftRejectedError: /);
    expect(history.error).not.toContain("ENOSPC");
    expect(history.draftFailures).toHaveLength(1);
  });

  it("guards applyFeedback's writes too", async () => {
    const seed = harness({ generate: [draftReply()], vision: [CONVERGED] });
    const history = await run(seed.deps, INPUT, cfg({ maxRounds: 3 }));

    const { deps, saved } = harness(
      { vision: [CONVERGED], chatWithTools: [fillRowTurn(0, "added a tail")] },
      () => true,
    );
    const next = await applyFeedback(deps, history, "give it a tail", 0, cfg({ maxRounds: 3 }));

    // The feedback pass has its own `persist` call site; §7.3's pass is no less
    // expensive to lose than a run.
    expect(next.rounds).toHaveLength(2);
    expect(next.rounds[0].revise?.summary).toBe("added a tail");
    expect(next.outcome).toBe("completed");
    expect(next.stopReason).toBe("no-high-severity");
    expect(next.error).toBe("Error: ENOSPC: no space left on device, write");
    expect(saved.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// meta ownership — spec §7.5
// ---------------------------------------------------------------------------

describe("run — derived documents", () => {
  it("gives every derived doc a fresh id and the right parentId", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0), fillRowTurn(1)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));
    const ids = history.rounds.map((r) => r.doc.id);

    expect(new Set(ids).size).toBe(3);
    expect(history.rounds[0].doc.meta.parentId).toBeNull();
    expect(history.rounds[1].doc.meta.parentId).toBe(ids[0]);
    expect(history.rounds[2].doc.meta.parentId).toBe(ids[1]);
  });

  it("gives every derived doc a fresh createdAt, never the parent's", async () => {
    // Rounds are derived microseconds apart, so a real clock stamps them all
    // identically at millisecond resolution and an inherited `createdAt` would be
    // indistinguishable from a fresh one. §6.2 and §7.5 ask for both halves of
    // the identity — a fresh `id` AND a fresh `createdAt` — and the filmstrip
    // orders rounds by the second.
    const realToISOString = Date.prototype.toISOString;
    let tick = 0;
    const clock = vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => {
      // The real method, on a date one second later each call — a stub that
      // called `toISOString` itself would recurse into this one.
      return realToISOString.call(new Date(Date.UTC(2026, 0, 1) + tick++ * 1000));
    });

    try {
      const { deps } = harness({
        generate: [draftReply()],
        vision: [HIGH],
        chatWithTools: [fillRowTurn(0), fillRowTurn(1)],
      });

      const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));
      const stamps = history.rounds.map((r) => r.doc.createdAt);

      expect(new Set(stamps).size).toBe(3);
      expect(stamps[1]).not.toBe(stamps[0]);
      expect(stamps[2]).not.toBe(stamps[1]);
      // Each derived doc is stamped when it is built, so the order is the run's.
      expect([...stamps].sort()).toEqual(stamps);
    } finally {
      clock.mockRestore();
    }
  });

  it("resets repairs and repairedRows on a derived doc", async () => {
    // The draft loses two rows, so round 1 carries a repair record that must
    // NOT propagate: `row-repaired` would re-fire on rounds where the agent had
    // already fixed those rows.
    const lossy = DRAFT_ROWS.map((row, y) => (y < 2 ? row.slice(0, 10) : row));
    const { deps } = harness({
      generate: [draftReply(lossy)],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(4)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));

    expect(history.rounds[0].doc.meta.repairs).toBeGreaterThan(0);
    expect(history.rounds[0].doc.meta.repairedRows).toEqual([0, 1]);
    expect(history.rounds[1].doc.meta.repairs).toBe(0);
    expect(history.rounds[1].doc.meta.repairedRows).toEqual([]);
  });

  it("stamps the models from the live config on every round", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(
      deps,
      INPUT,
      cfg({ maxRounds: 2, models: { generator: "gen-x", critic: "crit-y" } }),
    );

    for (const round of history.rounds) {
      expect(round.doc.meta.generatorModel).toBe("gen-x");
      expect(round.doc.meta.criticModel).toBe("crit-y");
    }
  });

  it("carries the prompt, intent, size and palette forward unchanged", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));
    const [first, second] = history.rounds;

    expect(second.doc.prompt).toBe(first.doc.prompt);
    expect(second.doc.intent).toEqual(first.doc.intent);
    expect(second.doc.size).toEqual(first.doc.size);
    expect(second.doc.palette).toEqual(first.doc.palette);
    expect(second.doc.createdAt).not.toBe("");
  });

  it("applies the revise stage's edits to the derived doc", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0)],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 2 }));

    expect(history.rounds[0].doc.rows[0]).toBe(".".repeat(16));
    expect(history.rounds[1].doc.rows[0]).toBe("1".repeat(16));
  });
});

// ---------------------------------------------------------------------------
// a mid-session model rebind — spec §3, §6.7, §7.5
//
// The existing "stamps the models from the live config" test cannot tell the
// live config from `parent.meta`: `draft()` stamps round 1 from the same config,
// so the two agree on every round of a single run. Only a session that changes
// models between passes separates them — which is the exact comparison §3's
// `qwen3-vl:30b-a3b` upgrade path exists to enable, and per-round
// `meta.criticModel` is how §6.7 says it is read.
// ---------------------------------------------------------------------------

describe("derived documents — the models come from the config bound NOW", () => {
  const OLD_CRITIC = "qwen3-vl:8b-instruct-q4_K_M";
  const NEW_CRITIC = "qwen3-vl:30b-a3b";

  it("records the critic the round was actually critiqued by, not the parent's", async () => {
    const seed = harness({ generate: [draftReply()], vision: [CONVERGED] });
    const history = await run(
      seed.deps,
      INPUT,
      cfg({ maxRounds: 3, models: { generator: "qwen3:8b", critic: OLD_CRITIC } }),
    );
    expect(history.rounds[0].doc.meta.criticModel).toBe(OLD_CRITIC);

    // The user upgrades the critic — and the generator with it — and resumes.
    const { deps, stub } = harness({ vision: [CONVERGED], chatWithTools: [fillRowTurn(0)] });
    const next = await applyFeedback(
      deps,
      history,
      "sharpen the outline",
      0,
      cfg({ maxRounds: 3, models: { generator: "qwen3:14b", critic: NEW_CRITIC } }),
    );

    // The derived round records the pair that produced it...
    expect(next.rounds[1].doc.meta.criticModel).toBe(NEW_CRITIC);
    expect(next.rounds[1].doc.meta.generatorModel).toBe("qwen3:14b");
    // ...and the parent keeps its own, which is what makes the two rounds
    // comparable at all. Inheriting `parent.meta` would attribute the new
    // critic's work to the old one and silently answer "did the upgrade help?"
    // with the wrong model's name on every round after the rebind.
    expect(next.rounds[0].doc.meta.criticModel).toBe(OLD_CRITIC);
    expect(next.rounds[1].doc.meta.criticModel).not.toBe(next.rounds[0].doc.meta.criticModel);
    // And the attribution is true: those are the models the calls really used.
    expect(stub.calls.find((c) => c.method === "chatWithTools")?.model).toBe("qwen3:14b");
    expect(stub.calls.find((c) => c.method === "vision")?.model).toBe(NEW_CRITIC);
  });
});

// ---------------------------------------------------------------------------
// revise-turn events — spec §7.1
// ---------------------------------------------------------------------------

describe("run — revise-turn events", () => {
  it("emits one per turn, 1-based, carrying maxTurns", async () => {
    const { deps, events } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [NARRATING_TURN],
    });

    await run(deps, INPUT, cfg({ maxRounds: 2, maxReviseTurns: 3 }));
    const turns = events.filter(
      (e): e is Extract<PipelineEvent, { type: "revise-turn" }> => e.type === "revise-turn",
    );

    expect(turns.map((t) => t.turn)).toEqual([1, 2, 3]);
    for (const turn of turns) {
      expect(turn.maxTurns).toBe(3);
      expect(turn.round).toBe(1);
    }
  });

  it("emits none on a converging run", async () => {
    const { deps, events } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    await run(deps, INPUT, cfg());

    expect(events.filter((e) => e.type === "revise-turn")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// draft rejection — spec §6.3, §6.7, A9
// ---------------------------------------------------------------------------

describe("run — a rejected draft", () => {
  it("fails with BOTH attempts in draftFailures, each with its own raw", async () => {
    const first = JSON.stringify({ rows: ["...."] });
    const second = "still not a sprite";
    const { deps } = harness({ generate: [first, second] });

    const history = await run(deps, INPUT, cfg({ maxDraftRetries: 1 }));

    // A9: `DraftRejectedError` carries only the last attempt, so attempt 1's raw
    // output was unrecoverable. Two rejections with the same defect mean the
    // prompt is wrong; two with different defects mean the model is unstable —
    // one entry makes those indistinguishable.
    expect(history.draftFailures).toHaveLength(2);
    expect(history.draftFailures.map((f) => f.attempt)).toEqual([1, 2]);
    expect(history.draftFailures[0].raw).toBe(first);
    expect(history.draftFailures[1].raw).toBe(second);
    expect(history.draftFailures[0].raw).not.toBe(history.draftFailures[1].raw);
    expect(history.draftFailures[0].repairs).toBeGreaterThan(0);
    expect(history.draftFailures[0].reason).toMatch(/repairRejectThreshold/);
  });

  it("mirrors the reason into SessionHistory.error", async () => {
    const { deps } = harness({ generate: [PROSE] });

    const history = await run(deps, INPUT, cfg({ maxDraftRetries: 1 }));

    // §6.7 words `error` as "why a run failed, when it wasn't a draft", which
    // left a draft rejection with `stopReason: null` AND `error: null` — both of
    // Wave 13's explaining columns blank for exactly the runs that need them.
    expect(history.error).toBe(
      "DraftRejectedError: Draft rejected: 256 repaired cells exceeded " +
        `repairRejectThreshold. Raw output was ${PROSE.length} characters.`,
    );
    expect(history.error).toMatch(/^DraftRejectedError: /);
    // And it is the error's own reason, not a paraphrase that could drift.
    const raised = new DraftRejectedError(256, PROSE);
    expect(history.error).toBe(`${raised.name}: ${raised.message}`);
  });

  it("lands in FAILED with no rounds and no stop reason", async () => {
    const { deps, saved } = harness({ generate: [PROSE] });

    const history = await run(deps, INPUT, cfg({ maxDraftRetries: 1 }));

    expect(history.finalState).toBe("FAILED");
    expect(history.outcome).toBe("failed");
    expect(history.stopReason).toBeNull();
    expect(history.rounds).toEqual([]);
    expect(history.rounds).toHaveLength(0);
    // The failure is on disk, not only in the return value §9 sends over IPC.
    expect(saved).toHaveLength(1);
    expect(saved[0].draftFailures).toHaveLength(2);
  });

  it("emits a DRAFTING event per attempt so the UI can say 'retrying draft'", async () => {
    const { deps, events } = harness({ generate: [PROSE] });

    await run(deps, INPUT, cfg({ maxDraftRetries: 1 }));

    // One for entering the stage, one for the retry — and no third, because
    // nothing follows the final rejection but `FAILED`.
    expect(stateTrace(events)).toEqual(["DRAFTING:0", "DRAFTING:0", "FAILED:0"]);
  });

  it("honours maxDraftRetries: 0 — one attempt, one failure, one DRAFTING event", async () => {
    const { deps, stub, events } = harness({ generate: [PROSE] });

    const history = await run(deps, INPUT, cfg({ maxDraftRetries: 0 }));

    // The zero case on the retry budget: no retry follows, so no second
    // DRAFTING event claims one is starting.
    expect(stub.calls).toHaveLength(1);
    expect(history.draftFailures).toHaveLength(1);
    expect(history.draftFailures[0].attempt).toBe(1);
    expect(stateTrace(events)).toEqual(["DRAFTING:0", "FAILED:0"]);
  });

  it("records a rejected-then-recovered attempt on a run that completed", async () => {
    const { deps } = harness({
      generate: [PROSE, draftReply()],
      vision: [CONVERGED],
    });

    const history = await run(deps, INPUT, cfg({ maxDraftRetries: 1 }));

    // The attempt happened; the bench needs to know how often the retry saves
    // the run. `onAttempt` fires per REJECTED attempt, not per failed run.
    expect(history.draftFailures).toHaveLength(1);
    expect(history.draftFailures[0].attempt).toBe(1);
    expect(history.outcome).toBe("completed");
    expect(history.rounds).toHaveLength(1);
  });

  it("records nothing in draftFailures when the first draft is accepted", async () => {
    const { deps } = harness({ generate: [draftReply()], vision: [CONVERGED] });

    const history = await run(deps, INPUT, cfg());

    expect(history.draftFailures).toEqual([]);
  });

  it("does not retry — and records no draft failure — on a transport error", async () => {
    const endpoint = "http://127.0.0.1:11434/api/generate";
    const { deps, stub } = harness({ generate: [new OllamaUnreachableError(endpoint)] });

    const history = await run(deps, INPUT, cfg({ maxDraftRetries: 1 }));

    expect(stub.calls).toHaveLength(1);
    expect(history.draftFailures).toEqual([]);
    expect(history.finalState).toBe("FAILED");
    // §8 has the status bar name the exact endpoint, and after a reload this
    // flat string is its only source.
    expect(history.error).toBe(`OllamaUnreachableError: Ollama is unreachable at ${endpoint}`);
    expect(history.error).toContain(endpoint);
  });
});

// ---------------------------------------------------------------------------
// stage failures — spec §7.1's FAILED edges, §9
// ---------------------------------------------------------------------------

describe("run — stage failures", () => {
  it("snapshots the round with critique null when CRITIQUING fails", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [new OllamaTimeoutError("qwen3-vl:8b-instruct-q4_K_M", 480_000)],
    });

    const history = await run(deps, INPUT, cfg());

    // The draft cost minutes, so the round it produced is still worth keeping —
    // `Round.critique` is nullable for exactly this state. The aborted elapsed
    // time is deliberately NOT written into `critiqueMs`: `null` there means
    // "this stage produced no critique", and `error` carries the elapsed ms.
    expect(history.rounds).toHaveLength(1);
    expect(history.rounds[0].critique).toBeNull();
    expect(history.rounds[0].timings.critiqueMs).toBeNull();
    expect(history.rounds[0].lint).toEqual(lint(history.rounds[0].doc));
    expect(history.finalState).toBe("FAILED");
    expect(history.outcome).toBe("failed");
    expect(history.stopReason).toBeNull();
    expect(history.error).toBe(
      "OllamaTimeoutError: Ollama call to qwen3-vl:8b-instruct-q4_K_M was aborted after 480000ms",
    );
  });

  it("keeps the snapshotted round when REVISING fails", async () => {
    const { deps, events } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [new OllamaUnreachableError("http://127.0.0.1:11434/api/chat")],
    });

    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    // §6.7: deferring the snapshot until after revision reintroduces
    // `rounds: []` exactly here.
    expect(history.rounds).toHaveLength(1);
    expect(history.rounds[0].critique).not.toBeNull();
    expect(history.rounds[0].revise).toBeNull();
    expect(history.rounds[0].timings.reviseMs).toBeNull();
    expect(history.finalState).toBe("FAILED");
    expect(history.error).toContain("OllamaUnreachableError");
    expect(stateTrace(events)).toEqual([
      "DRAFTING:0",
      "LINTING:1",
      "CRITIQUING:1",
      "REVISING:1",
      "FAILED:1",
    ]);
  });

  it("fails rather than throwing when the palette id is unknown", async () => {
    const { deps } = harness({ generate: [draftReply()] });

    const history = await run(deps, { ...INPUT, paletteId: "not-a-palette" }, cfg());

    expect(history.finalState).toBe("FAILED");
    expect(history.outcome).toBe("failed");
    expect(history.error).toContain("not-a-palette");
  });

  it("persists the failed history so a reload can name the cause", async () => {
    const { deps, saved } = harness({
      generate: [draftReply()],
      vision: [new OllamaTimeoutError("crit", 1000)],
    });

    await run(deps, INPUT, cfg());

    const last = saved[saved.length - 1];
    expect(last.finalState).toBe("FAILED");
    expect(last.outcome).toBe("failed");
    expect(last.error).toContain("OllamaTimeoutError");
  });
});

// ---------------------------------------------------------------------------
// applyFeedback — spec §7.3
// ---------------------------------------------------------------------------

describe("syntheticFeedbackIssue", () => {
  it("is high severity at confidence 1.0 with no suggestion", () => {
    const issue = syntheticFeedbackIssue("make the ears pointier", SIZE);

    expect(issue.severity).toBe("high");
    expect(issue.confidence).toBe(1);
    expect(issue.suggestConfidence).toBe(0);
    expect(issue.suggest).toBe("");
    expect(issue.issue).toBe("make the ears pointier");
    expect(issue.region).toEqual([0, 0, 15, 15]);
  });

  it("survives its own filter at any floor — §7.3's idempotence claim", () => {
    const issue = syntheticFeedbackIssue("make the ears pointier", SIZE);
    const report = {
      readsAs: null,
      matchesIntent: true,
      overall: null,
      degraded: false,
      issues: [issue],
    };

    const strict = filterIssues(report, cfg({ confidenceFloor: 1, suggestConfidenceFloor: 1 }));
    expect(strict.issues).toEqual([issue]);
    expect(filterIssues(strict, cfg()).issues).toEqual([issue]);
  });
});

describe("applyFeedback", () => {
  /** A converged single-round history to give feedback on. */
  async function converged(): Promise<{ history: SessionHistory }> {
    const { deps } = harness({ generate: [draftReply()], vision: [CONVERGED] });
    return { history: await run(deps, INPUT, cfg({ maxRounds: 3 })) };
  }

  it("re-enters at REVISING and appends a round parented to the edited one", async () => {
    const { history } = await converged();
    const { deps, events, stub } = harness({
      vision: [CONVERGED],
      chatWithTools: [fillRowTurn(0)],
    });

    const next = await applyFeedback(deps, history, "give it a tail", 0, cfg({ maxRounds: 3 }));

    expect(stateTrace(events)[0]).toBe("REVISING:1");
    expect(next.rounds).toHaveLength(2);
    expect(next.rounds[1].doc.meta.parentId).toBe(history.rounds[0].doc.id);
    expect(next.rounds[1].round).toBe(2);
    expect(next.rounds[1].doc.meta.round).toBe(2);
    // No draft — the feedback path never generates a new sprite from scratch.
    expect(countCalls(stub, "generate")).toBe(0);
  });

  it("records the user's own words on the round the feedback produced", async () => {
    const { history } = await converged();
    const { deps } = harness({ vision: [CONVERGED], chatWithTools: [fillRowTurn(0)] });

    const next = await applyFeedback(deps, history, "give it a tail", 0, cfg({ maxRounds: 3 }));

    // §1 claims every revision round is preserved and comparable, but the
    // feedback text lived only in a transient synthetic `Issue`.
    expect(next.rounds[1].userFeedback).toBe("give it a tail");
    expect(next.rounds[0].userFeedback).toBeNull();
  });

  it("sends the feedback text to the agent as its issue list", async () => {
    const { history } = await converged();
    const { deps, stub } = harness({ vision: [CONVERGED], chatWithTools: [fillRowTurn(0)] });

    await applyFeedback(deps, history, "give it a bushy tail", 0, cfg({ maxRounds: 3 }));

    const chat = stub.calls.find((c) => c.method === "chatWithTools");
    const user = chat?.messages?.find((m) => m.role === "user");
    expect(user?.content).toContain("give it a bushy tail");
    expect(user?.content).toContain("[high]");
  });

  it("writes the feedback pass's revise summary onto the source round", async () => {
    const { history } = await converged();
    const { deps } = harness({ vision: [CONVERGED], chatWithTools: [fillRowTurn(0, "added a tail")] });

    const next = await applyFeedback(deps, history, "give it a tail", 0, cfg({ maxRounds: 3 }));

    // Phase two, on the round the revise stage actually ran from — symmetric
    // with `run()`, where the round that was revised holds the summary.
    expect(next.rounds[0].revise?.summary).toBe("added a tail");
    expect(next.rounds[0].timings.reviseMs).not.toBeNull();
  });

  /**
   * A 3-round history whose two agent passes carry distinguishable summaries.
   *
   * The existing phase-two test gives feedback on index 0 of a ONE-round history,
   * where the source round is also the last one — so it cannot tell
   * `rounds[roundIndex]` from `rounds[rounds.length - 1]`.
   */
  async function threeRounds(): Promise<SessionHistory> {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0, "agent pass one"), fillRowTurn(1, "agent pass two")],
    });
    const history = await run(deps, INPUT, cfg({ maxRounds: 3 }));

    expect(history.rounds.map((r) => r.revise?.summary ?? null)).toEqual([
      "agent pass one",
      "agent pass two",
      null,
    ]);
    return history;
  }

  it("writes phase two onto the SOURCE round of a 3-round history, not the last", async () => {
    const history = await threeRounds();
    const { deps, events } = harness({
      vision: [CONVERGED],
      chatWithTools: [fillRowTurn(5, "user pass")],
    });

    const next = await applyFeedback(deps, history, "give it a tail", 1, cfg({ maxRounds: 4 }));

    expect(next.rounds).toHaveLength(4);
    // The summary and the timing belong to the round the revise stage ran FROM —
    // symmetric with `run()`, and the property `applyFeedback`'s contract states.
    expect(next.rounds[1].revise?.summary).toBe("user pass");
    expect(next.rounds[1].timings.reviseMs).not.toBeNull();
    // Round 3 is the round the run stopped on and was never revised. Writing
    // there attributes the user's pass to a round they were not looking at, and
    // `reviseMs` on a round with no revise stage is a phantom bench figure.
    expect(next.rounds[2].revise).toBeNull();
    expect(next.rounds[2].timings.reviseMs).toBeNull();
    // The other rounds' own records are untouched.
    expect(next.rounds[0].revise?.summary).toBe("agent pass one");
    expect(next.rounds[3].doc.meta.parentId).toBe(history.rounds[1].doc.id);
    expect(next.rounds[3].round).toBe(4);

    // And the renderer is told the same thing: the phase-two event carries the
    // source round, which is its only source for `revise` before the gate.
    const first = events.filter(
      (e): e is Extract<PipelineEvent, { type: "round" }> => e.type === "round",
    )[0];
    expect(first.snapshot.round).toBe(2);
    expect(first.snapshot.revise?.summary).toBe("user pass");
  });

  it("writes it onto index 0 of a 3-round history too — the falsy index is an index", async () => {
    const history = await threeRounds();
    const { deps } = harness({
      vision: [CONVERGED],
      chatWithTools: [fillRowTurn(5, "user pass")],
    });

    const feedback = "start over from the draft";
    const next = await applyFeedback(deps, history, feedback, 0, cfg({ maxRounds: 4 }));

    expect(next.rounds).toHaveLength(4);
    // Branching twice from one round overwrites that round's earlier summary —
    // both records are true and only one is representable — but it overwrites the
    // SOURCE round's, never the last one's.
    expect(next.rounds[0].revise?.summary).toBe("user pass");
    expect(next.rounds[1].revise?.summary).toBe("agent pass two");
    expect(next.rounds[2].revise).toBeNull();
    expect(next.rounds[3].doc.meta.parentId).toBe(history.rounds[0].doc.id);
  });

  it("diffs the new round against the round the user was looking at, not the last", async () => {
    // Build a two-round history, then branch from round 1.
    const first = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0), fillRowTurn(1)],
    });
    const history = await run(first.deps, INPUT, cfg({ maxRounds: 2 }));
    expect(history.rounds).toHaveLength(2);

    const { deps } = harness({ vision: [CONVERGED], chatWithTools: [fillRowTurn(5)] });
    const next = await applyFeedback(deps, history, "start over from the draft", 0, cfg({ maxRounds: 3 }));

    expect(next.rounds).toHaveLength(3);
    expect(next.rounds[2].doc.meta.parentId).toBe(history.rounds[0].doc.id);
    // Row 5 of the draft is transparent, so exactly 16 cells changed against
    // round 1. Diffing against round 2 — the array-previous — would also have
    // reported row 0 reverting, i.e. 32 cells.
    expect(next.rounds[2].diffFromPrev).toHaveLength(16);
    expect(next.rounds[2].round).toBe(3);
    // `Round.round` and `doc.meta.round` must not disagree: `acceptedRound`
    // names the first and the filmstrip labels read the second.
    for (const [i, round] of next.rounds.entries()) {
      expect(round.round).toBe(i + 1);
      expect(round.doc.meta.round).toBe(round.round);
    }
  });

  it("continues the agent loop after the user's pass", async () => {
    const { history } = await converged();
    const { deps, stub } = harness({
      vision: [HIGH, CONVERGED],
      chatWithTools: [fillRowTurn(0), fillRowTurn(1)],
    });

    const next = await applyFeedback(deps, history, "more contrast", 0, cfg({ maxRounds: 3 }));

    // The user's pass makes round 2; its critique still finds a high-severity
    // issue, so the agent revises again into round 3, which converges.
    expect(next.rounds).toHaveLength(3);
    expect(next.stopReason).toBe("no-high-severity");
    expect(countCalls(stub, "chatWithTools")).toBe(2);
    expect(next.rounds[2].userFeedback).toBeNull();
  });

  it("reads outcome 'failed' while the pass is in flight", async () => {
    const { history } = await converged();
    const { deps, saved } = harness({ vision: [CONVERGED], chatWithTools: [fillRowTurn(0)] });

    const next = await applyFeedback(deps, history, "give it a tail", 0, cfg({ maxRounds: 3 }));

    expect(saved[0].outcome).toBe("failed");
    expect(saved[0].stopReason).toBeNull();
    expect(next.outcome).toBe("completed");
    expect(next.stopReason).toBe("no-high-severity");
  });

  it("stops with empty-diff when the user's pass changed nothing", async () => {
    const { history } = await converged();
    const { deps } = harness({ chatWithTools: [NOOP_TURN] });

    const next = await applyFeedback(deps, history, "make it better", 0, cfg({ maxRounds: 3 }));

    expect(next.stopReason).toBe("empty-diff");
    expect(next.rounds).toHaveLength(1);
    expect(next.rounds[0].revise?.hitCap).toBe(false);
    expect(next.finalState).toBe("AWAITING_USER");
  });

  it("fails the pass rather than the process when REVISING throws", async () => {
    const { history } = await converged();
    const { deps } = harness({ chatWithTools: [new OllamaUnreachableError("http://x/api/chat")] });

    const next = await applyFeedback(deps, history, "make it better", 0, cfg());

    expect(next.finalState).toBe("FAILED");
    expect(next.outcome).toBe("failed");
    expect(next.error).toContain("OllamaUnreachableError");
    expect(next.rounds).toHaveLength(1);
  });

  it("throws a RangeError for a round index the history does not hold", async () => {
    const { history } = await converged();
    const { deps } = harness({ chatWithTools: [NOOP_TURN] });

    await expect(applyFeedback(deps, history, "x", 1, cfg())).rejects.toThrow(RangeError);
    await expect(applyFeedback(deps, history, "x", -1, cfg())).rejects.toThrow(RangeError);
    await expect(
      applyFeedback(deps, createHistory("s", cfg()), "x", 0, cfg()),
    ).rejects.toThrow(RangeError);
  });

  it("re-parses its own config too", async () => {
    const { history } = await converged();
    const { deps } = harness({ chatWithTools: [NOOP_TURN] });

    await expect(
      applyFeedback(deps, history, "x", 0, { ...cfg(), maxRounds: 0 } as unknown as HarnessConfig),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// model residency — spec amendment A17
// ---------------------------------------------------------------------------

/**
 * Eviction between stages, and the three ways it goes wrong silently.
 *
 * §6.8's two roles alternate five times across a 3-round run —
 * draft(G) → critique(C) → revise(G) → critique(C) → revise(G) → critique(C) —
 * and on a host that cannot hold both models that is a thrash or an OOM. A17
 * makes the swap explicit, and the pipeline is where "explicit" has to mean
 * *between stages*.
 *
 * The mutants this section is written against:
 *
 * - **Evicting on every stage** rather than on a change. The call count differs;
 *   nothing else does, and a run still completes.
 * - **Evicting the model being entered** rather than the one being left. The
 *   count is identical and the run pays the cold load it was trying to avoid.
 * - **Evicting under `concurrent`**, which turns the fast path into the slow one
 *   with no visible symptom other than wall clock.
 */
describe("run — model residency", () => {
  const GEN = "generator-model";
  const CRITIC = "critic-model";

  /** The full call trace, including releases, in call order. */
  function trace(stub: StubClient): string[] {
    return stub.calls.map((c) => `${c.method}:${c.model}`);
  }

  function residencyDeps(
    h: ReturnType<typeof harness>,
    policy: "sequential" | "concurrent",
  ): PipelineDeps {
    return {
      ...h.deps,
      residency: createResidencyRunner(
        { configured: "auto", policy, reason: "pinned by the test" },
        h.stub,
      ),
    };
  }

  /** draft → critique(HIGH) → revise → critique(CONVERGED). */
  function twoRoundScript(): StubScript {
    return {
      generate: [draftReply()],
      vision: [HIGH, CONVERGED],
      chatWithTools: [fillRowTurn(0)],
    };
  }

  it("evicts the outgoing model at every stage boundary, and only there", async () => {
    const h = harness(twoRoundScript());

    await run(
      residencyDeps(h, "sequential"),
      INPUT,
      cfg({ models: { generator: GEN, critic: CRITIC } }),
    );

    // The eviction lands **before** the call that needs the memory, and names
    // the model being left behind.
    expect(trace(h.stub)).toEqual([
      `generate:${GEN}`,
      `release:${GEN}`,
      `vision:${CRITIC}`,
      `release:${CRITIC}`,
      `chatWithTools:${GEN}`,
      `release:${GEN}`,
      `vision:${CRITIC}`,
    ]);
  });

  it("evicts nothing when one model serves both roles", async () => {
    // The shipped default, and it must cost nothing even with the policy forced
    // on: the model entered is the model already resident, every time.
    const h = harness(twoRoundScript());

    await run(
      residencyDeps(h, "sequential"),
      INPUT,
      cfg({ models: { generator: GEN, critic: GEN } }),
    );

    expect(countCalls(h.stub, "release")).toBe(0);
  });

  it("evicts nothing under concurrent, however often the model changes", async () => {
    const h = harness(twoRoundScript());

    await run(
      residencyDeps(h, "concurrent"),
      INPUT,
      cfg({ models: { generator: GEN, critic: CRITIC } }),
    );

    expect(countCalls(h.stub, "release")).toBe(0);
    expect(countCalls(h.stub, "vision")).toBe(2);
  });

  it("runs unchanged when no residency is supplied at all", async () => {
    // `PipelineDeps.residency` is optional, so every existing caller — and every
    // other test in this file — keeps working without one.
    const h = harness(twoRoundScript());

    const history = await run(h.deps, INPUT, cfg({ models: { generator: GEN, critic: CRITIC } }));

    expect(history.outcome).toBe("completed");
    expect(countCalls(h.stub, "release")).toBe(0);
  });

  it("does not fail the run when an eviction fails", async () => {
    // A failed unload leaves the model resident, which is the situation the
    // policy was trying to improve — not a reason to throw away a multi-minute
    // run. Log and continue.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness({ ...twoRoundScript(), release: [new Error("connection reset by peer")] });

    const history = await run(
      residencyDeps(h, "sequential"),
      INPUT,
      cfg({ models: { generator: GEN, critic: CRITIC } }),
    );

    expect(history.outcome).toBe("completed");
    expect(history.error).toBeNull();
    expect(countCalls(h.stub, "vision")).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("evicts on the feedback path too — §7.3 travels one code path", async () => {
    const first = harness({
      generate: [draftReply()],
      vision: [CONVERGED],
    });
    const config = cfg({ models: { generator: GEN, critic: CRITIC } });
    const history = await run(residencyDeps(first, "sequential"), INPUT, config);

    const second = harness({ vision: [CONVERGED], chatWithTools: [fillRowTurn(0)] });
    await applyFeedback(residencyDeps(second, "sequential"), history, "make it rounder", 0, config);

    // The feedback pass enters at REVISING with the generator; the critique that
    // follows swaps to the critic.
    expect(trace(second.stub)).toEqual([
      `chatWithTools:${GEN}`,
      `release:${GEN}`,
      `vision:${CRITIC}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// accept — spec §6.7, §8
// ---------------------------------------------------------------------------

describe("accept", () => {
  async function threeRounds(): Promise<SessionHistory> {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [HIGH],
      chatWithTools: [fillRowTurn(0), fillRowTurn(1)],
    });
    return run(deps, INPUT, cfg({ maxRounds: 3 }));
  }

  it("converts the 0-based index to the 1-based Round.round — accept(0) is 1", async () => {
    const accepted = await accept(await threeRounds(), 0);

    // Asserted on the returned history, NOT on a `saveHistory` round-trip: the
    // schema rejects `acceptedRound: 0` at parse time, so an implementation
    // that stored the raw index would turn an off-by-one into a save error at
    // the end of a multi-minute run, far from its cause.
    expect(accepted.acceptedRound).toBe(1);
    expect(accepted.acceptedRound).not.toBe(0);
  });

  it("stores Round.round for a later round too", async () => {
    const history = await threeRounds();

    expect((await accept(history, 1)).acceptedRound).toBe(2);
    expect((await accept(history, 2)).acceptedRound).toBe(3);
  });

  it("transitions to DONE", async () => {
    const accepted = await accept(await threeRounds(), 0);

    expect(accepted.finalState).toBe("DONE");
    expect(accepted.stopReason).toBe("round-cap"); // the run's reason survives
  });

  it("returns a history that still validates — the 0 → 1 conversion happened", async () => {
    const accepted = await accept(await threeRounds(), 0);

    expect(() => SessionHistorySchema.parse(accepted)).not.toThrow();
  });

  it("does not launder a failed run into a completed one", async () => {
    const { deps } = harness({
      generate: [draftReply()],
      vision: [new OllamaTimeoutError("crit", 1)],
    });
    const failed = await run(deps, INPUT, cfg());

    const accepted = await accept(failed, 0);

    // Any round may be accepted, not only the last — including a round from a
    // run that later failed. `outcome` is the run's, not the user's.
    expect(accepted.acceptedRound).toBe(1);
    expect(accepted.finalState).toBe("DONE");
    expect(accepted.outcome).toBe("failed");
    expect(accepted.error).toContain("OllamaTimeoutError");
  });

  it("does not mutate the history it was given", async () => {
    const history = await threeRounds();
    const accepted = await accept(history, 1);

    expect(history.acceptedRound).toBeNull();
    expect(accepted.acceptedRound).toBe(2);
  });

  it("throws a RangeError for an index the history does not hold", async () => {
    const history = await threeRounds();

    await expect(accept(history, 3)).rejects.toThrow(RangeError);
    await expect(accept(history, -1)).rejects.toThrow(RangeError);
    await expect(accept(createHistory("s", cfg()), 0)).rejects.toThrow(RangeError);
  });

  it("accepts a branched round by its own Round.round", async () => {
    // A hand-built branched history: round 3 descends from round 1.
    const base = await threeRounds();
    const branched = appendRound(base, {
      ...base.rounds[2],
      round: 4,
      doc: {
        ...base.rounds[2].doc,
        id: "branch-doc",
        meta: { ...base.rounds[2].doc.meta, round: 4, parentId: base.rounds[0].doc.id },
      },
    });

    expect((await accept(branched, 3)).acceptedRound).toBe(4);
  });
});
