/**
 * `SessionHistory` construction — spec §6.7, plan Wave 9 task 9.1.
 *
 * Written before `src/main/history.ts` existed. Four of the properties pinned
 * here are ones whose breakage is silent at the call site:
 *
 * - **`outcome` starts `"failed"`.** `persist` fires after every round, so an
 *   in-progress artifact must not claim success — §11's first acceptance bar
 *   reads that exact field, and a crash mid-run would otherwise leave a history
 *   reporting `"completed"`.
 * - **`diffFromPrev` is computed against the round's PARENT**, not the
 *   array-previous. `applyFeedback` branches, and diffing against the last
 *   element then compares the wrong baseline.
 * - **`[]` and `null` are different `diffFromPrev` values.** `null` is "this
 *   round has no predecessor"; `[]` is "the revise stage changed nothing". Any
 *   falsy check collapses them, which is the defect B03 named.
 * - **`completeRound` is phase two of the round lifecycle.** Without it
 *   `revise` and `timings.reviseMs` are permanently `null` on every round, which
 *   makes `turns`, `hitCap` and `summary` dead exactly as they were before the
 *   audit added them.
 *
 * Every test here is pure or writes to an OS temp directory; nothing needs
 * Ollama and nothing writes into the repository.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendRound, completeRound, createHistory, roundAt, saveHistory } from "@main/history";
import { lint } from "@main/lint";
import {
  HarnessConfigSchema,
  RoundSchema,
  SessionHistorySchema,
  SpriteDocSchema,
  type HarnessConfig,
  type Round,
  type SessionHistory,
  type SpriteDoc,
} from "@shared/schema";

import { GAMEBOY_REF } from "../fixtures/sprites";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function cfg(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return HarnessConfigSchema.parse(overrides);
}

/** 16 rows of 16 transparent cells. */
function blank(): string[] {
  return Array.from({ length: 16 }, () => ".".repeat(16));
}

/** `blank()` with one cell set, so two docs differ by a known number of pixels. */
function withPixel(cells: Array<[number, number, string]>): string[] {
  const rows = blank();
  for (const [x, y, ch] of cells) {
    rows[y] = rows[y].slice(0, x) + ch + rows[y].slice(x + 1);
  }
  return rows;
}

let docSeq = 0;

/**
 * A `SpriteDoc` through `SpriteDocSchema.parse` — never a bare type annotation,
 * for the reason `tests/fixtures/sprites.ts` states: the row-count, row-width
 * and off-palette checks are runtime-only.
 */
function makeDoc(
  overrides: { id?: string; rows?: string[]; round?: number; parentId?: string | null } = {},
): SpriteDoc {
  docSeq++;
  return SpriteDocSchema.parse({
    schemaVersion: 1,
    id: overrides.id ?? `doc-${docSeq}`,
    createdAt: "2026-07-29T00:00:00.000Z",
    prompt: "a sitting red fox",
    intent: { subject: "a fox" },
    size: { w: 16, h: 16 },
    palette: GAMEBOY_REF,
    rows: overrides.rows ?? blank(),
    meta: {
      generatorModel: "qwen3:8b",
      criticModel: "qwen3-vl:8b-instruct-q4_K_M",
      round: overrides.round ?? 1,
      repairs: 0,
      repairedRows: [],
      parentId: overrides.parentId ?? null,
    },
  });
}

/** A phase-one round: `revise` and `timings.reviseMs` both `null`. */
function makeRound(doc: SpriteDoc, overrides: Partial<Round> = {}): Round {
  return RoundSchema.parse({
    round: doc.meta.round,
    doc,
    lint: lint(doc),
    critique: null,
    filteredIssues: [],
    diffFromPrev: null,
    userFeedback: null,
    revise: null,
    timings: { draftMs: null, critiqueMs: null, reviseMs: null },
    ...overrides,
  });
}

const TEMP_DIRS: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sprite-maker-history-"));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(async () => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// createHistory
// ---------------------------------------------------------------------------

describe("createHistory", () => {
  it("embeds the config verbatim", () => {
    const config = cfg({ maxRounds: 2, models: { generator: "g", critic: "c" } });
    const history = createHistory("session-1", config);

    expect(history.config).toEqual(config);
    expect(history.sessionId).toBe("session-1");
    expect(history.schemaVersion).toBe(1);
  });

  it("starts with outcome 'failed' — an interrupted run is a failed run (§6.7)", () => {
    const history = createHistory("session-1", cfg());

    // §11's first acceptance bar reads this field off a persisted artifact, and
    // `persist` fires after every round. A history that claimed "completed"
    // from birth would report success for a run that crashed in round 1.
    expect(history.outcome).toBe("failed");
    expect(history.finalState).toBe("IDLE");
    expect(history.stopReason).toBeNull();
    expect(history.error).toBeNull();
    expect(history.acceptedRound).toBeNull();
  });

  it("starts with empty arrays, not undefined — the zero-length case", () => {
    const history = createHistory("session-1", cfg());

    expect(history.rounds).toEqual([]);
    expect(history.draftFailures).toEqual([]);
    expect(history.rounds).toHaveLength(0);
  });

  it("returns a history that validates against SessionHistorySchema", () => {
    expect(() => SessionHistorySchema.parse(createHistory("session-1", cfg()))).not.toThrow();
  });

  it("refuses a stale config — the strict schema is the staleness guard (§6.7)", () => {
    // A history written when the field was `criticUpscale` would otherwise
    // re-parse claiming `criticTargetPx: 512`, a limit that run never used.
    const stale = { ...cfg(), criticUpscale: 16 } as unknown as HarnessConfig;
    expect(() => createHistory("session-1", stale)).toThrow();
  });

  it("does not alias the caller's config object", () => {
    const config = cfg();
    const history = createHistory("session-1", config);

    config.models.generator = "mutated-after-the-fact";
    expect(history.config.models.generator).toBe("qwen3-vl:8b-instruct-q4_K_M");
  });
});

// ---------------------------------------------------------------------------
// appendRound
// ---------------------------------------------------------------------------

describe("appendRound", () => {
  it("leaves diffFromPrev null on a round with no parent", () => {
    const history = appendRound(createHistory("s", cfg()), makeRound(makeDoc()));

    expect(history.rounds).toHaveLength(1);
    expect(history.rounds[0].diffFromPrev).toBeNull();
  });

  it("diffs against the parent doc, cell for cell", () => {
    const parent = makeDoc({ id: "p", rows: blank() });
    const child = makeDoc({
      id: "c",
      parentId: "p",
      round: 2,
      rows: withPixel([[3, 4, "2"]]),
    });

    let history = appendRound(createHistory("s", cfg()), makeRound(parent));
    history = appendRound(history, makeRound(child));

    expect(history.rounds[1].diffFromPrev).toEqual([{ x: 3, y: 4, from: ".", to: "2" }]);
  });

  it("records an EMPTY diff as [], never as null — B03's collapsed pair", () => {
    const parent = makeDoc({ id: "p" });
    const child = makeDoc({ id: "c", parentId: "p", round: 2 });

    let history = appendRound(createHistory("s", cfg()), makeRound(parent));
    history = appendRound(history, makeRound(child));

    // `null` means "no predecessor"; `[]` means "the revise stage changed
    // nothing". Any falsy check reads both as absent, which is what pointed
    // §6.7's v1 prose at a bogus `empty-diff` for every run.
    expect(history.rounds[1].diffFromPrev).toEqual([]);
    expect(history.rounds[1].diffFromPrev).not.toBeNull();
    expect(history.rounds[1].diffFromPrev).toHaveLength(0);
  });

  it("diffs against the PARENT, not the array-previous — applyFeedback branches", () => {
    // A branch: both `b` and `c` descend from `a`. Diffing `c` against the last
    // array element (`b`) would compare the wrong baseline.
    const a = makeDoc({ id: "a", rows: blank() });
    const b = makeDoc({ id: "b", parentId: "a", round: 2, rows: withPixel([[0, 0, "1"]]) });
    const c = makeDoc({ id: "c", parentId: "a", round: 3, rows: withPixel([[5, 5, "3"]]) });

    let history = appendRound(createHistory("s", cfg()), makeRound(a));
    history = appendRound(history, makeRound(b, { round: 2 }));
    history = appendRound(history, makeRound(c, { round: 3 }));

    expect(history.rounds[2].diffFromPrev).toEqual([{ x: 5, y: 5, from: ".", to: "3" }]);
    // Against `b` the answer would have been two cells: (0,0) reverting and
    // (5,5) appearing.
    expect(history.rounds[2].diffFromPrev).toHaveLength(1);
  });

  it("recomputes diffFromPrev, ignoring whatever the caller passed", () => {
    const parent = makeDoc({ id: "p" });
    const child = makeDoc({ id: "c", parentId: "p", round: 2, rows: withPixel([[1, 1, "2"]]) });

    let history = appendRound(createHistory("s", cfg()), makeRound(parent));
    history = appendRound(
      history,
      makeRound(child, { round: 2, diffFromPrev: [{ x: 9, y: 9, from: ".", to: "0" }] }),
    );

    expect(history.rounds[1].diffFromPrev).toEqual([{ x: 1, y: 1, from: ".", to: "2" }]);
  });

  it("ignores a caller-supplied diff on a parentless round too", () => {
    const history = appendRound(
      createHistory("s", cfg()),
      makeRound(makeDoc(), { diffFromPrev: [{ x: 0, y: 0, from: ".", to: "1" }] }),
    );

    expect(history.rounds[0].diffFromPrev).toBeNull();
  });

  it("throws when parentId names a round the history does not hold", () => {
    const orphan = makeRound(makeDoc({ parentId: "missing", round: 2 }), { round: 2 });

    expect(() => appendRound(createHistory("s", cfg()), orphan)).toThrow(/missing/);
  });

  it("rejects round 0 — the draft is round 1 (§7.5)", () => {
    // The schema's guard, applied at the point of writing rather than at save
    // time: a 0-based pipeline would otherwise write a whole session before
    // anything objected, and the off-by-one would surface in the filmstrip.
    const zero = { ...makeRound(makeDoc()), round: 0 };

    expect(() => appendRound(createHistory("s", cfg()), zero)).toThrow();
  });

  it("does not mutate the history it was given", () => {
    const before = createHistory("s", cfg());
    const after = appendRound(before, makeRound(makeDoc()));

    expect(before.rounds).toHaveLength(0);
    expect(after.rounds).toHaveLength(1);
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// completeRound — phase two
// ---------------------------------------------------------------------------

describe("completeRound", () => {
  function twoRounds(): SessionHistory {
    const a = makeDoc({ id: "a" });
    const b = makeDoc({ id: "b", parentId: "a", round: 2, rows: withPixel([[2, 2, "1"]]) });
    let history = appendRound(createHistory("s", cfg()), makeRound(a));
    history = appendRound(history, makeRound(b, { round: 2 }));
    return history;
  }

  it("fills revise and timings.reviseMs on the round it names", () => {
    const history = completeRound(twoRounds(), 0, {
      revise: { turns: 7, hitCap: false, summary: "outlined the block" },
      reviseMs: 1234.5,
    });

    expect(history.rounds[0].revise).toEqual({
      turns: 7,
      hitCap: false,
      summary: "outlined the block",
    });
    expect(history.rounds[0].timings.reviseMs).toBe(1234.5);
  });

  it("works at index 0 — the falsy index, and the common case", () => {
    // Round 1's revise stage is the first one there is. An implementation
    // guarding with `if (index)` skips exactly this call.
    const history = completeRound(twoRounds(), 0, {
      revise: { turns: 1, hitCap: false, summary: "x" },
      reviseMs: 1,
    });

    expect(history.rounds[0].revise?.turns).toBe(1);
  });

  it("accepts turns: 0 and reviseMs: 0 as values, not as absent", () => {
    const history = completeRound(twoRounds(), 0, {
      revise: { turns: 0, hitCap: true, summary: "" },
      reviseMs: 0,
    });

    expect(history.rounds[0].revise).not.toBeNull();
    expect(history.rounds[0].revise?.turns).toBe(0);
    expect(history.rounds[0].revise?.hitCap).toBe(true);
    expect(history.rounds[0].timings.reviseMs).toBe(0);
    expect(history.rounds[0].timings.reviseMs).not.toBeNull();
  });

  it("leaves every other field of that round untouched", () => {
    const before = twoRounds();
    const after = completeRound(before, 0, {
      revise: { turns: 2, hitCap: false, summary: "s" },
      reviseMs: 5,
    });

    expect(after.rounds[0].round).toBe(before.rounds[0].round);
    expect(after.rounds[0].doc).toEqual(before.rounds[0].doc);
    expect(after.rounds[0].lint).toEqual(before.rounds[0].lint);
    expect(after.rounds[0].critique).toEqual(before.rounds[0].critique);
    expect(after.rounds[0].filteredIssues).toEqual(before.rounds[0].filteredIssues);
    expect(after.rounds[0].diffFromPrev).toEqual(before.rounds[0].diffFromPrev);
    expect(after.rounds[0].userFeedback).toBe(before.rounds[0].userFeedback);
    // Only `reviseMs` moves; the other two timings keep their values.
    expect(after.rounds[0].timings.draftMs).toBe(before.rounds[0].timings.draftMs);
    expect(after.rounds[0].timings.critiqueMs).toBe(before.rounds[0].timings.critiqueMs);
  });

  it("leaves every other round untouched", () => {
    const before = twoRounds();
    const after = completeRound(before, 0, {
      revise: { turns: 2, hitCap: false, summary: "s" },
      reviseMs: 5,
    });

    expect(after.rounds[1]).toEqual(before.rounds[1]);
    expect(after.rounds).toHaveLength(2);
  });

  it("leaves the surrounding history fields untouched", () => {
    const before = twoRounds();
    const after = completeRound(before, 1, {
      revise: { turns: 3, hitCap: true, summary: "capped" },
      reviseMs: 9,
    });

    expect(after.outcome).toBe(before.outcome);
    expect(after.stopReason).toBe(before.stopReason);
    expect(after.config).toEqual(before.config);
    expect(after.sessionId).toBe(before.sessionId);
  });

  it("throws for an index the history does not hold", () => {
    expect(() =>
      completeRound(createHistory("s", cfg()), 0, {
        revise: { turns: 1, hitCap: false, summary: "" },
        reviseMs: 1,
      }),
    ).toThrow(RangeError);

    expect(() =>
      completeRound(twoRounds(), 2, {
        revise: { turns: 1, hitCap: false, summary: "" },
        reviseMs: 1,
      }),
    ).toThrow(RangeError);
  });

  it("throws for a negative index rather than counting from the end", () => {
    // `Array.prototype.at(-1)` would silently complete the LAST round.
    expect(() =>
      completeRound(twoRounds(), -1, {
        revise: { turns: 1, hitCap: false, summary: "" },
        reviseMs: 1,
      }),
    ).toThrow(RangeError);
  });

  it("does not mutate the history it was given", () => {
    const before = twoRounds();
    const after = completeRound(before, 0, {
      revise: { turns: 4, hitCap: false, summary: "s" },
      reviseMs: 7,
    });

    expect(before.rounds[0].revise).toBeNull();
    expect(before.rounds[0].timings.reviseMs).toBeNull();
    expect(after.rounds[0].revise).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// roundAt
// ---------------------------------------------------------------------------

describe("roundAt", () => {
  it("returns the round at a 0-based index", () => {
    const history = appendRound(createHistory("s", cfg()), makeRound(makeDoc({ id: "a" })));
    expect(roundAt(history, 0, "test").doc.id).toBe("a");
  });

  it("throws a RangeError naming the caller for anything out of range", () => {
    const empty = createHistory("s", cfg());

    expect(() => roundAt(empty, 0, "accept")).toThrow(RangeError);
    expect(() => roundAt(empty, 0, "accept")).toThrow(/accept/);
    expect(() => roundAt(empty, -1, "accept")).toThrow(RangeError);
    expect(() => roundAt(empty, 1.5, "accept")).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// saveHistory
// ---------------------------------------------------------------------------

describe("saveHistory", () => {
  it("round-trips through SessionHistorySchema", async () => {
    const dir = await tempDir();
    const doc = makeDoc({ id: "a" });
    const history = appendRound(createHistory("session-abc", cfg()), makeRound(doc));

    const path = await saveHistory(history, dir);
    const parsed = SessionHistorySchema.parse(JSON.parse(await readFile(path, "utf8")));

    expect(parsed).toEqual(history);
  });

  it("returns the path it wrote, inside the directory it was given", async () => {
    const dir = await tempDir();
    const path = await saveHistory(createHistory("session-abc", cfg()), dir);

    expect(path).toBe(join(dir, "session-abc.json"));
  });

  it("creates the directory when it does not exist", async () => {
    const dir = join(await tempDir(), "nested", "deeper");
    const path = await saveHistory(createHistory("s", cfg()), dir);

    expect(JSON.parse(await readFile(path, "utf8")).sessionId).toBe("s");
  });

  it("preserves an empty diffFromPrev as [] and a null one as null across the file", async () => {
    const dir = await tempDir();
    const a = makeDoc({ id: "a" });
    const b = makeDoc({ id: "b", parentId: "a", round: 2 });
    let history = appendRound(createHistory("s", cfg()), makeRound(a));
    history = appendRound(history, makeRound(b, { round: 2 }));

    const path = await saveHistory(history, dir);
    const reloaded = SessionHistorySchema.parse(JSON.parse(await readFile(path, "utf8")));

    expect(reloaded.rounds[0].diffFromPrev).toBeNull();
    expect(reloaded.rounds[1].diffFromPrev).toEqual([]);
  });

  it("refuses to write a history the schema rejects", async () => {
    const dir = await tempDir();
    // `acceptedRound: 0` is the un-converted array index §6.7 forbids.
    const broken = { ...createHistory("s", cfg()), acceptedRound: 0 };

    await expect(saveHistory(broken, dir)).rejects.toThrow();
  });

  it("refuses a sessionId that would escape the directory", async () => {
    const dir = await tempDir();
    const escaping = createHistory("../../etc/passwd", cfg());

    await expect(saveHistory(escaping, dir)).rejects.toThrow(/sessionId/);
  });
});
