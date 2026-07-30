/**
 * The typed IPC surface — spec §5.1, §8, §9; plan Wave 10.
 *
 * Written before `src/main/ipc.ts` and `src/preload/index.ts` existed. Five
 * things this file is deliberately built around, each a defect the audit named
 * or a trap Wave 10 walks into:
 *
 * **1. `onEvent` can never be an `ipcMain.handle` channel.** It runs the other
 * direction — `webContents.send` → `ipcRenderer.on`. v1's test asserted every
 * `Api` method mapped to a `handle` channel, so it failed against a *correct*
 * implementation and passed only against one that had broken the event stream.
 * The assertion here is three-part: every method **except** `onEvent` is a
 * registered `handle` channel, `onEvent` is the one `webContents.send` channel,
 * and the union of the two is exactly the `Api` keys.
 *
 * **2. The `Api` keys are read off the object the preload actually exposed**,
 * not off a list written here. A list would drift; `contextBridge`'s recorded
 * argument cannot.
 *
 * **3. Errors cross as a `Result` envelope, never as a rejection.**
 * `ipcMain.handle` serializes a rejection into a plain `Error` and destroys its
 * own fields — including the `endpoint` that §9's unreachable-Ollama message is
 * entirely about. Every failure test therefore asserts both that the call
 * *resolved* and that the envelope kept its fields.
 *
 * **4. `roundIndex: 0` is the first round and the most common accept target.**
 * A falsy check reads it as "no argument". `accept(0)`, `setPixel(0, …)`,
 * `exportPng(0, …)` and `applyFeedback(fb, 0)` are each probed at 0 explicitly.
 *
 * **5. `vi.mock("electron")`.** Outside Electron, `require("electron")`
 * resolves to a *path string*, so `ipcMain` is `undefined` and every test fails
 * on import with a message about nothing.
 *
 * The pipeline runs against `createStubClient` throughout: this file is green
 * with Ollama stopped.
 */

import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Trap 5. Hoisted by Vitest above the imports below, which is what lets
// `@main/ipc` import `ipcMain` at module scope.
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

import { contextBridge, ipcMain } from "electron";

import { OllamaUnreachableError } from "@main/ollama";
import { CHANNELS, registerIpc, type IpcDeps, type RendererTarget } from "@main/ipc";
import {
  HarnessConfigSchema,
  PipelineEventSchema,
  SessionHistorySchema,
  type ChatTurn,
  type HarnessConfig,
  type LintReport,
  type SessionHistory,
  type Size,
  type SpriteDoc,
} from "@shared/schema";
import { listPalettes } from "@shared/palettes";

import { PRELOAD_CHANNELS } from "../../src/preload/index";
import { createStubClient, type StubScript } from "../stubs/ollama";

// ---------------------------------------------------------------------------
// fixtures — the same scripting vocabulary `tests/main/pipeline.test.ts` uses
// ---------------------------------------------------------------------------

const SIZE: Size = { w: 16, h: 16 };
const INPUT = { prompt: "a sitting red fox", size: SIZE, paletteId: "gameboy" };

/** A 4×4 block of index `1` at (6,6)–(9,9); rows 0 and 1 are fully transparent. */
const DRAFT_ROWS = Array.from({ length: 16 }, (_, y) =>
  Array.from({ length: 16 }, (_, x) => (y >= 6 && y <= 9 && x >= 6 && x <= 9 ? "1" : ".")).join(""),
);

const DRAFT_REPLY = JSON.stringify({ intent: { subject: "a fox" }, rows: DRAFT_ROWS });

function critiqueReply(issues: unknown[] = []): string {
  return JSON.stringify({
    readsAs: "a small block",
    matchesIntent: true,
    overall: 3,
    issues,
  });
}

const CONVERGED = critiqueReply();
const HIGH = critiqueReply([
  {
    id: "issue-0",
    region: [6, 6, 9, 9],
    severity: "high",
    issue: "the block reads as a smudge",
    suggest: "add a darker outline",
    confidence: 0.9,
    suggestConfidence: 0.8,
  },
]);

/** A revise turn that fills row 0 with index 1, then finishes. */
const FILL_ROW_0: ChatTurn = {
  content: "",
  toolCalls: [
    { id: "fill", name: "fill_row", arguments: { y: 0, x0: 0, x1: 15, index: 1 } },
    { id: "done", name: "done", arguments: { summary: "filled row 0" } },
  ],
};

/** One round: draft, then a critique with nothing left to fix. */
const ONE_ROUND: StubScript = { generate: [DRAFT_REPLY], vision: [CONVERGED] };
/** Two rounds: draft, a high-severity critique, one revise turn, then convergence. */
const TWO_ROUNDS: StubScript = {
  generate: [DRAFT_REPLY],
  vision: [HIGH, CONVERGED],
  chatWithTools: [FILL_ROW_0],
};

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ...args: unknown[]) => unknown;

interface Result {
  ok: boolean;
  value?: unknown;
  code?: string;
  message?: string;
  endpoint?: string;
}

const handleMock = vi.mocked(ipcMain.handle);
const exposeMock = vi.mocked(contextBridge.exposeInMainWorld);

let sessionDir: string;
let target: RendererTarget & { send: ReturnType<typeof vi.fn> };
let config: HarnessConfig;

/** Register the surface against a scripted client, and hand back the config it shares. */
function register(script: StubScript, overrides: Partial<HarnessConfig> = {}): IpcDeps {
  config = HarnessConfigSchema.parse(overrides);
  const deps: IpcDeps = {
    client: createStubClient(script),
    config,
    sessionDir,
    renderer: () => target,
  };
  registerIpc(deps);
  return deps;
}

/** The handler registered for `channel`, or a failure naming the channel. */
function handler(channel: string): Handler {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) {
    throw new Error(
      `no ipcMain.handle registered for '${channel}' — registered: ` +
        `${handleMock.mock.calls.map((c) => c[0]).join(", ")}`,
    );
  }
  return call[1] as Handler;
}

/** Invoke a channel the way `ipcRenderer.invoke` would. */
async function invoke(channel: string, ...args: unknown[]): Promise<Result> {
  return (await handler(channel)({}, ...args)) as Result;
}

/**
 * The object the preload handed `contextBridge`.
 *
 * Captured at module scope, not inside a test: `exposeInMainWorld` is called
 * once, at *import* time — the preload has no `register` function, because the
 * real one runs top-to-bottom in a renderer that has just been created — so the
 * first `clearAllMocks` would otherwise erase the only recording of it.
 */
const EXPOSED_API: Record<string, unknown> = (() => {
  const call = exposeMock.mock.calls.find((c) => c[0] === "api");
  if (call === undefined) throw new Error("the preload never exposed 'api'");
  return call[1] as Record<string, unknown>;
})();

function exposedApi(): Record<string, unknown> {
  return EXPOSED_API;
}

/** Every channel `ipcMain.handle` was registered for, deduplicated and sorted. */
function handleChannels(): string[] {
  return [...new Set(handleMock.mock.calls.map((c) => String(c[0])))].sort();
}

/** Every channel `webContents.send` was called with, deduplicated and sorted. */
function sendChannels(): string[] {
  return [...new Set(target.send.mock.calls.map((c) => String(c[0])))].sort();
}

/** A `Result` that must have succeeded, unwrapped — with the envelope in the message if not. */
function unwrap<T>(result: Result): T {
  expect(result).toMatchObject({ ok: true });
  return result.value as T;
}

beforeEach(async () => {
  handleMock.mockClear();
  sessionDir = await mkdtemp(join(tmpdir(), "sprite-maker-ipc-"));
  target = Object.assign({ isDestroyed: () => false }, { send: vi.fn() });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// the surface itself — blocker 3
// ---------------------------------------------------------------------------

describe("the Api surface", () => {
  it("registers an ipcMain.handle channel for every Api method except onEvent", () => {
    register(ONE_ROUND);

    const expected = Object.entries(CHANNELS)
      .filter(([method]) => method !== "onEvent")
      .map(([, channel]) => channel)
      .sort();

    expect(handleChannels()).toEqual(expected);
  });

  it("never registers onEvent as a handle channel — it is a webContents.send channel", async () => {
    register(ONE_ROUND);

    expect(handleChannels()).not.toContain(CHANNELS.onEvent);

    await invoke(CHANNELS.run, INPUT);

    expect(sendChannels()).toEqual([CHANNELS.onEvent]);
    expect(target.send.mock.calls.length).toBeGreaterThan(0);
    for (const [, payload] of target.send.mock.calls) {
      // Every payload on that channel is a real `PipelineEvent`, so the renderer
      // can discriminate on `type` without defensive parsing.
      expect(() => PipelineEventSchema.parse(payload)).not.toThrow();
    }
  });

  it("covers exactly the Api keys with the handle channels plus the send channel", async () => {
    register(ONE_ROUND);
    await invoke(CHANNELS.run, INPUT);

    expect(Object.keys(CHANNELS).sort()).toEqual(Object.keys(exposedApi()).sort());
    expect([...handleChannels(), ...sendChannels()].sort()).toEqual(
      Object.values(CHANNELS).sort(),
    );
  });

  it("exposes exactly the Api keys on window.api", () => {
    const api = exposedApi();
    expect(Object.keys(api).sort()).toEqual(Object.keys(PRELOAD_CHANNELS).sort());
    for (const value of Object.values(api)) expect(typeof value).toBe("function");
  });

  it("keeps the preload's channel table identical to main's", () => {
    // The two tables are spelled twice on purpose: importing `@main/ipc` from
    // the preload would drag `node:http`, `pngjs` and the whole harness into the
    // preload bundle. This is the drift guard that duplication costs.
    expect(PRELOAD_CHANNELS).toEqual(CHANNELS);
  });
});

// ---------------------------------------------------------------------------
// the Result envelope — blocker 4, spec §9
// ---------------------------------------------------------------------------

describe("the Result envelope", () => {
  it("returns { ok: false, endpoint } from a failed listModels rather than rejecting", async () => {
    const endpoint = "http://127.0.0.1:11434/api/tags";
    register({ models: new OllamaUnreachableError(endpoint) });

    const result = await invoke(CHANNELS.listModels);

    expect(result.ok).toBe(false);
    // The whole point: `ipcMain.handle` would have destroyed this field.
    expect(result.endpoint).toBe(endpoint);
    expect(result.code).toBe("ollama-unreachable");
    expect(result.message).toContain(endpoint);
  });

  it("carries only structured-clone-safe fields — never an Error instance", async () => {
    register({ models: new OllamaUnreachableError("http://127.0.0.1:11434/api/tags") });

    const result = await invoke(CHANNELS.listModels);

    expect(result).toBeInstanceOf(Object);
    expect(result).not.toBeInstanceOf(Error);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("registers export-png and answers it with not-implemented until Wave 13", async () => {
    register(ONE_ROUND);
    await invoke(CHANNELS.run, INPUT);

    // Probed at round 0 — the falsy-zero class.
    const result = await invoke(CHANNELS.exportPng, 0, 8);

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not-implemented");
  });

  it("reports a bad round index as a failure envelope, not a rejection", async () => {
    register(ONE_ROUND);
    await invoke(CHANNELS.run, INPUT);

    const result = await invoke(CHANNELS.accept, 7);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("7");
  });
});

// ---------------------------------------------------------------------------
// main owns the session
// ---------------------------------------------------------------------------

describe("the session", () => {
  it("runs the pipeline and returns the history in an ok envelope", async () => {
    register(ONE_ROUND);

    const history = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));

    expect(() => SessionHistorySchema.parse(history)).not.toThrow();
    expect(history.rounds).toHaveLength(1);
    expect(history.outcome).toBe("completed");
    expect(history.stopReason).toBe("no-high-severity");
  });

  it("keeps a partially failed run's session, so the renderer can still render it", async () => {
    // `run` resolves with a FAILED history rather than rejecting — the round the
    // draft produced is the only record of a multi-minute run, and a rejection
    // would discard it.
    register({
      generate: [DRAFT_REPLY],
      vision: [new OllamaUnreachableError("http://127.0.0.1:11434/api/generate")],
    });

    const history = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));

    expect(history.outcome).toBe("failed");
    expect(history.rounds).toHaveLength(1);
    expect(history.error).toContain("127.0.0.1:11434");

    // And it is the *current* session, so round 0 is still reachable.
    const accepted = unwrap<SessionHistory>(await invoke(CHANNELS.accept, 0));
    expect(accepted.acceptedRound).toBe(1);
  });

  it("accepts round index 0 and records the 1-based round number", async () => {
    register(TWO_ROUNDS);
    await invoke(CHANNELS.run, INPUT);

    const history = unwrap<SessionHistory>(await invoke(CHANNELS.accept, 0));

    // Falsy zero: `accept(0)` is accepting the draft, the most common call there
    // is. `acceptedRound` is `Round.round`, which is 1-based — not the index.
    expect(history.acceptedRound).toBe(1);
    expect(history.finalState).toBe("DONE");
  });

  it("accepts a round that is not the last", async () => {
    register(TWO_ROUNDS);
    await invoke(CHANNELS.run, INPUT);

    const history = unwrap<SessionHistory>(await invoke(CHANNELS.accept, 1));
    expect(history.acceptedRound).toBe(2);
  });

  it("applies feedback against round index 0", async () => {
    register(TWO_ROUNDS);
    const before = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));

    const after = unwrap<SessionHistory>(
      await invoke(CHANNELS.applyFeedback, "make the ears pointier", 0),
    );

    expect(after.rounds.length).toBeGreaterThan(before.rounds.length);
    expect(after.rounds[0].revise).not.toBeNull();
    // The new round is parented to the round the user was looking at.
    const appended = after.rounds[after.rounds.length - 1];
    expect(appended.doc.meta.parentId).toBe(before.rounds[0].doc.id);
  });

  it("refuses a round-indexed call before a session exists", async () => {
    register(ONE_ROUND);

    const result = await invoke(CHANNELS.accept, 0);

    expect(result.ok).toBe(false);
    expect(result.code).toBe("no-session");
  });

  it("writes the history to disk through PipelineDeps.persist", async () => {
    register(ONE_ROUND);
    const history = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));

    const files = await readdir(sessionDir);
    expect(files).toContain(`${history.sessionId}.json`);

    const written = JSON.parse(await readFile(join(sessionDir, files[0]), "utf8"));
    expect(() => SessionHistorySchema.parse(written)).not.toThrow();
    expect(written.rounds).toHaveLength(1);
  });

  it("reports the session file path", async () => {
    register(ONE_ROUND);
    const history = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));

    const path = await invoke(CHANNELS.getSessionPath);

    expect(path).toBe(join(sessionDir, `${history.sessionId}.json`));
  });
});

// ---------------------------------------------------------------------------
// setPixel — spec §8, the silent-divergence defect
// ---------------------------------------------------------------------------

describe("setPixel", () => {
  it("returns the updated doc and a fresh lint report", async () => {
    register(ONE_ROUND);
    await invoke(CHANNELS.run, INPUT);

    const edited = unwrap<{ doc: SpriteDoc; lint: LintReport }>(
      await invoke(CHANNELS.setPixel, 0, 0, 0, "1"),
    );

    expect(edited.doc.rows[0][0]).toBe("1");
    // Not the report from before the edit: (0,0) is now an orphan.
    expect(edited.lint.metrics.coverage).toBeGreaterThan(0);
    expect(edited.lint.warnings.some((w) => w.code === "orphan-pixel")).toBe(true);
  });

  it("writes the edit into the session, so a second edit sees the first", async () => {
    register(ONE_ROUND);
    await invoke(CHANNELS.run, INPUT);

    await invoke(CHANNELS.setPixel, 0, 0, 0, "1");
    const second = unwrap<{ doc: { rows: string[] } }>(
      await invoke(CHANNELS.setPixel, 0, 1, 0, "1"),
    );

    // Both edits present: the first one was not thrown away with the response.
    expect(second.doc.rows[0].slice(0, 2)).toBe("11");
  });

  it("mutates the last round in place rather than appending", async () => {
    register(ONE_ROUND);
    await invoke(CHANNELS.run, INPUT);

    await invoke(CHANNELS.setPixel, 0, 0, 0, "1");
    const history = unwrap<SessionHistory>(await invoke(CHANNELS.accept, 0));

    expect(history.rounds).toHaveLength(1);
    expect(history.rounds[0].doc.rows[0][0]).toBe("1");
    expect(() => SessionHistorySchema.parse(history)).not.toThrow();
  });

  it("appends a new round parented to the edited one when the round is not the last", async () => {
    register(TWO_ROUNDS);
    const before = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));
    expect(before.rounds).toHaveLength(2);

    // Round index 0 of a two-round history: an earlier round. Mutating it in
    // place would invalidate round 2's `diffFromPrev`, and the filmstrip is
    // defined as replaying those diffs.
    const edited = unwrap<{ doc: { id: string; meta: { parentId: string; round: number } } }>(
      await invoke(CHANNELS.setPixel, 0, 5, 5, "1"),
    );

    expect(edited.doc.meta.parentId).toBe(before.rounds[0].doc.id);
    expect(edited.doc.id).not.toBe(before.rounds[0].doc.id);

    const history = unwrap<SessionHistory>(await invoke(CHANNELS.accept, 0));
    expect(history.rounds).toHaveLength(3);
    // The edited round itself is untouched.
    expect(history.rounds[0].doc.rows[5][5]).toBe(before.rounds[0].doc.rows[5][5]);
    expect(history.rounds[2].doc.rows[5][5]).toBe("1");
    expect(() => SessionHistorySchema.parse(history)).not.toThrow();
  });

  it("reports an off-palette character as a failure envelope", async () => {
    // `gameboy` carries four colours, so index 9 does not exist in it.
    register(ONE_ROUND);
    await invoke(CHANNELS.run, INPUT);

    const result = await invoke(CHANNELS.setPixel, 0, 0, 0, "9");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("off-palette");
  });
});

// ---------------------------------------------------------------------------
// models, config, palettes
// ---------------------------------------------------------------------------

describe("models and config", () => {
  it("lists installed models in an ok envelope", async () => {
    register({ models: ["qwen3:8b", "qwen3-vl:8b-instruct-q4_K_M"] });

    const models = unwrap<string[]>(await invoke(CHANNELS.listModels));

    expect(models).toEqual(["qwen3:8b", "qwen3-vl:8b-instruct-q4_K_M"]);
  });

  it("reports the current role bindings", async () => {
    register(ONE_ROUND);

    const roles = (await invoke(CHANNELS.getModels)) as unknown as {
      generator: string;
      critic: string;
    };

    expect(roles).toEqual({
      generator: "qwen3:8b",
      critic: "qwen3-vl:8b-instruct-q4_K_M",
    });
  });

  it("binds a role and writes through to the config the next run receives", async () => {
    register(ONE_ROUND);

    const bound = await invoke(CHANNELS.bindModel, "critic", "llava:13b");
    expect(bound.ok).toBe(true);

    const roles = (await invoke(CHANNELS.getModels)) as unknown as { critic: string };
    expect(roles.critic).toBe("llava:13b");

    const config = (await invoke(CHANNELS.getConfig)) as unknown as HarnessConfig;
    expect(config.models.critic).toBe("llava:13b");

    // And the binding reaches the pipeline, not just the picker.
    const history = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));
    expect(history.config.models.critic).toBe("llava:13b");
    expect(history.rounds[0].doc.meta.criticModel).toBe("llava:13b");
  });

  it("reports an unknown role as a failure envelope", async () => {
    register(ONE_ROUND);

    const result = await invoke(CHANNELS.bindModel, "painter", "llava:13b");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("painter");
  });

  it("hands the renderer the config the filmstrip needs", async () => {
    register(ONE_ROUND, { maxRounds: 5 });

    const config = (await invoke(CHANNELS.getConfig)) as unknown as HarnessConfig;

    expect(config.maxRounds).toBe(5);
    expect(() => HarnessConfigSchema.parse(config)).not.toThrow();
  });

  it("hands the renderer the palette library", async () => {
    register(ONE_ROUND);

    const palettes = (await invoke(CHANNELS.getPalettes)) as unknown as Array<{ id: string }>;

    expect(palettes.map((p) => p.id)).toEqual(listPalettes().map((p) => p.id));
  });
});
