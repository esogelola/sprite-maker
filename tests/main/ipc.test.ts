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

import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Trap 5. Hoisted by Vitest above the imports below, which is what lets
// `@main/ipc` import `ipcMain` at module scope.
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

import { contextBridge, ipcMain } from "electron";

import { OllamaUnreachableError, type OllamaClient } from "@main/ollama";
import { CHANNELS, registerIpc, type IpcDeps, type RendererTarget } from "@main/ipc";
import {
  HarnessConfigSchema,
  PipelineEventSchema,
  SessionHistorySchema,
  type ChatTurn,
  type HarnessConfig,
  type LintReport,
  type PixelDiff,
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

/** Register the surface against any client, and hand back the config it shares. */
function registerClient(client: OllamaClient, overrides: Partial<HarnessConfig> = {}): IpcDeps {
  config = HarnessConfigSchema.parse(overrides);
  const deps: IpcDeps = { client, config, sessionDir, renderer: () => target };
  registerIpc(deps);
  return deps;
}

/** Register the surface against a scripted client, and hand back the config it shares. */
function register(script: StubScript, overrides: Partial<HarnessConfig> = {}): IpcDeps {
  return registerClient(createStubClient(script), overrides);
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

/**
 * A client that suspends inside `chatWithTools` until the test lets it go.
 *
 * This is how the reviewer's race is reproduced deterministically. `REVISING` is
 * the pause point rather than `CRITIQUING` because round 1 has already been
 * appended *and* persisted by the time the revise stage starts — so the surface
 * is observed at the exact moment the defect described: rounds on screen, rounds
 * on disk, and a `run()` that has not resolved.
 *
 * Real runs sit here for minutes (§12), which is why this is not a contrived
 * window: it is the window Waves 11–12 hand the user a button in.
 */
interface GatedClient {
  client: OllamaClient;
  /** Resolves once the pipeline has entered the gated call. */
  reached: Promise<void>;
  /** Let the pipeline continue. */
  release(): void;
}

function gateAtRevise(script: StubScript): GatedClient {
  const inner = createStubClient(script);
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });

  return {
    reached,
    release: () => open(),
    client: {
      listModels: () => inner.listModels(),
      generate: (req) => inner.generate(req),
      vision: (req) => inner.vision(req),
      async chatWithTools(req) {
        // Idempotent: resolving a settled promise again is a no-op, so a script
        // with several revise turns still gates on the first one.
        arrive();
        await opened;
        return inner.chatWithTools(req);
      },
    },
  };
}

/** The session JSON on disk, parsed — the artifact §11's bars and Wave 14 read. */
async function artifact(sessionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(sessionDir, `${sessionId}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

/** A path inside the repo, resolved from this file rather than from `process.cwd()`. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fromRepo = (p: string): string => join(REPO, p);

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

// ---------------------------------------------------------------------------
// the write race — Wave 10b, audit blocker B12 by a second route
// ---------------------------------------------------------------------------

/**
 * `currentSession` is a read-modify-write across an `await`, and a run holds that
 * `await` open for minutes (§12). Wave 10's reviewer reproduced all three of the
 * losses below against a surface whose every individual test passed.
 *
 * The rule these pin is one sentence: **never `ok: true` followed by a silent
 * discard.** A refusal the user can see is a worse product and a correct one; an
 * acceptance that evaporates is the defect §8 names — "hand-editing then
 * exporting produced a PNG without the edits and without an error" — arriving
 * through concurrency instead of renderer state.
 */
describe("the write race", () => {
  it("does not lose an Accept made during an in-flight run", async () => {
    const gate = gateAtRevise(TWO_ROUNDS);
    registerClient(gate.client);

    const running = invoke(CHANNELS.run, INPUT);
    await gate.reached;

    // Round 1 is already on disk and already on screen — this is the window.
    const midRun = (await invoke(CHANNELS.getSessionPath)) as unknown as string;
    const sessionId = basename(midRun, ".json");
    expect(((await artifact(sessionId)).rounds as unknown[]).length).toBe(1);

    const accepted = await invoke(CHANNELS.accept, 0);

    // Before the fix this was `{ok: true, acceptedRound: 1, finalState: "DONE"}`
    // and the run then overwrote it — the user's Accept gone, reported as done.
    expect(accepted).toMatchObject({ ok: false, code: "busy" });
    // Falsy zero: index 0 is the first round and the most common accept target.
    // The refusal must be about the lock, not about the argument.
    expect(accepted.code).not.toBe("bad-index");
    expect(accepted.code).not.toBe("no-session");

    gate.release();
    const history = unwrap<SessionHistory>(await running);

    // The artifact — not the return value — is what §11's bars and Wave 14 read.
    expect((await artifact(history.sessionId)).acceptedRound).toBeNull();

    // And the invariant stated positively: an accept that reports `ok` is on disk.
    const after = unwrap<SessionHistory>(await invoke(CHANNELS.accept, 0));
    expect(after.acceptedRound).toBe(1);
    const written = await artifact(history.sessionId);
    expect(written.acceptedRound).toBe(1);
    expect(written.finalState).toBe("DONE");
  });

  it("refuses every mutation while one is in flight, and leaves no trace of the refusals", async () => {
    const gate = gateAtRevise(TWO_ROUNDS);
    registerClient(gate.client);

    const running = invoke(CHANNELS.run, INPUT);
    await gate.reached;

    const refused = [
      await invoke(CHANNELS.run, INPUT),
      await invoke(CHANNELS.applyFeedback, "make the ears pointier", 0),
      await invoke(CHANNELS.accept, 0),
      await invoke(CHANNELS.setPixel, 0, 0, 0, "1"),
    ];
    for (const result of refused) expect(result).toMatchObject({ ok: false, code: "busy" });

    gate.release();
    const history = unwrap<SessionHistory>(await running);

    // The run is exactly what it would have been alone.
    expect(history.rounds).toHaveLength(2);
    expect(history.acceptedRound).toBeNull();
    // Round 1 is the untouched draft — the refused `setPixel(0, 0, 0, "1")` did
    // not land — while round 2's row 0 is the revise stage's own `fill_row`.
    expect(history.rounds[0].doc.rows[0][0]).toBe(".");
    expect(history.rounds[1].doc.rows[0]).toBe("1".repeat(16));
  });

  it("loses neither of two concurrent feedback passes — it refuses one", async () => {
    const gate = gateAtRevise({
      generate: [DRAFT_REPLY],
      vision: [CONVERGED],
      chatWithTools: [FILL_ROW_0],
    });
    registerClient(gate.client);

    const before = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));
    expect(before.rounds).toHaveLength(1);

    const first = invoke(CHANNELS.applyFeedback, "make the ears pointier", 0);
    await gate.reached;
    const second = await invoke(CHANNELS.applyFeedback, "and a longer tail", 0);

    expect(second).toMatchObject({ ok: false, code: "busy" });

    gate.release();
    const after = unwrap<SessionHistory>(await first);

    // Before the fix both calls returned a three-round history and one pass was
    // thrown away. One pass ran, and it is the one that was not refused.
    expect(after.rounds).toHaveLength(2);
    expect(after.rounds[1].userFeedback).toBe("make the ears pointier");
  });

  it("releases the lock when a mutation fails, so the surface is not wedged", async () => {
    register(ONE_ROUND);

    const bad = await invoke(CHANNELS.run, null);
    expect(bad).toMatchObject({ ok: false, code: "bad-input" });

    const ok = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));
    expect(ok.rounds).toHaveLength(1);
  });

  it("names the session file once round 1 is snapshotted, not only when run() resolves", async () => {
    const gate = gateAtRevise(TWO_ROUNDS);
    registerClient(gate.client);

    const running = invoke(CHANNELS.run, INPUT);
    await gate.reached;

    const midRun = (await invoke(CHANNELS.getSessionPath)) as unknown as string;

    // Wave 10's committed boot capture recorded the *directory* here: main did
    // not believe a session existed while rounds were already on screen and on
    // disk, so every round-indexed method answered `no-session` for the whole
    // run.
    expect(midRun).not.toBe(sessionDir);
    expect(midRun.endsWith(".json")).toBe(true);

    gate.release();
    const history = unwrap<SessionHistory>(await running);
    expect(midRun).toBe(join(sessionDir, `${history.sessionId}.json`));
  });
});

// ---------------------------------------------------------------------------
// what reaches disk — spec §9's "at most one round is lost", §11's first bar
// ---------------------------------------------------------------------------

/** Apply a `diffFromPrev` to its parent's rows — what §8's filmstrip does. */
function replay(rows: string[], edits: PixelDiff[]): string[] {
  const grid = rows.map((row) => row.split(""));
  for (const { x, y, to } of edits) grid[y][x] = to;
  return grid.map((row) => row.join(""));
}

describe("persistence", () => {
  it("writes an accepted round to disk", async () => {
    register(TWO_ROUNDS);
    const history = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));

    unwrap<SessionHistory>(await invoke(CHANNELS.accept, 0));

    // §11's first bar and Wave 14's feature 10 read `acceptedRound` off the
    // artifact, so an accept that never reached disk is invisible after a reload.
    const written = await artifact(history.sessionId);
    expect(written.acceptedRound).toBe(1);
    expect(written.finalState).toBe("DONE");
  });

  it("writes a hand edit to disk", async () => {
    register(ONE_ROUND);
    const history = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));

    await invoke(CHANNELS.setPixel, 0, 0, 0, "1");

    // §8's own sentence: a hand edit that does not reach the artifact is a PNG
    // exported without the edits and without an error.
    const written = (await artifact(history.sessionId)) as unknown as SessionHistory;
    expect(written.rounds[0].doc.rows[0][0]).toBe("1");
  });

  it("writes an appended edit round to disk", async () => {
    register(TWO_ROUNDS);
    const history = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));

    await invoke(CHANNELS.setPixel, 0, 5, 5, "1");

    const written = (await artifact(history.sessionId)) as unknown as SessionHistory;
    expect(written.rounds).toHaveLength(3);
    expect(written.rounds[2].doc.rows[5][5]).toBe("1");
  });

  it("recomputes diffFromPrev, so replaying it reproduces the edited round", async () => {
    register(TWO_ROUNDS);
    const before = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));
    expect(before.rounds).toHaveLength(2);

    // The last round, so this mutates in place (rule 4). (5,5) is outside the
    // drafted block, so the edit really changes a pixel.
    await invoke(CHANNELS.setPixel, 1, 5, 5, "1");
    const history = unwrap<SessionHistory>(await invoke(CHANNELS.accept, 1));

    const edited = history.rounds[1];
    expect(edited.diffFromPrev).not.toBeNull();
    // §8 defines the filmstrip as replaying `diffFromPrev`. A carried-over diff
    // reproduces the *pre-edit* frame, which is a wrong answer, not a missing one.
    expect(replay(history.rounds[0].doc.rows, edited.diffFromPrev as PixelDiff[])).toEqual(
      edited.doc.rows,
    );
    expect((edited.diffFromPrev as PixelDiff[]).some((d) => d.x === 5 && d.y === 5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setPixel after accept — Wave 10b, decision recorded in `ipc.ts`
// ---------------------------------------------------------------------------

describe("setPixel after accept", () => {
  it("clears the acceptance when the edit changes the accepted document", async () => {
    register(ONE_ROUND);
    const history = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));
    expect(unwrap<SessionHistory>(await invoke(CHANNELS.accept, 0)).acceptedRound).toBe(1);

    await invoke(CHANNELS.setPixel, 0, 0, 0, "1");

    // The document the user accepted no longer exists, so the record of the
    // acceptance would be a false statement about the artifact. Wave 14's gate
    // runs accept (feature 10) *before* hand editing (11) and export (12), so
    // refusing the edit would fail the gate script.
    const written = (await artifact(history.sessionId)) as unknown as SessionHistory;
    expect(written.acceptedRound).toBeNull();
    expect(written.finalState).toBe("AWAITING_USER");
    expect(written.rounds[0].doc.rows[0][0]).toBe("1");
  });

  it("keeps an acceptance the edit did not touch", async () => {
    register(TWO_ROUNDS);
    const before = unwrap<SessionHistory>(await invoke(CHANNELS.run, INPUT));
    expect(unwrap<SessionHistory>(await invoke(CHANNELS.accept, 1)).acceptedRound).toBe(2);

    // Editing round 0 appends a new round; round 2 — the accepted one — is
    // untouched, so `acceptedRound: 2` is still true of the artifact.
    await invoke(CHANNELS.setPixel, 0, 5, 5, "1");

    const written = (await artifact(before.sessionId)) as unknown as SessionHistory;
    expect(written.acceptedRound).toBe(2);
    expect(written.finalState).toBe("DONE");
    expect(written.rounds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// error codes — §8 has the renderer branch on `code`
// ---------------------------------------------------------------------------

describe("error codes", () => {
  it("distinguishes an unknown role, an empty model name and a bad round index", async () => {
    register(ONE_ROUND);
    await invoke(CHANNELS.run, INPUT);

    const role = await invoke(CHANNELS.bindModel, "painter", "llava:13b");
    const model = await invoke(CHANNELS.bindModel, "critic", "   ");
    const index = await invoke(CHANNELS.accept, 7);

    // All three collapsed to `bad-index` before: each is a `RangeError`, and a
    // single code for three unrelated causes is not something a renderer can
    // branch on.
    expect(role.code).toBe("bad-role");
    expect(model.code).toBe("bad-model");
    expect(index.code).toBe("bad-index");
    expect(new Set([role.code, model.code, index.code]).size).toBe(3);
  });

  it("reports a schema failure as bad-input with a message a status bar can render", async () => {
    register(ONE_ROUND);

    // 17 is not one of §6.2's three squares.
    const result = await invoke(CHANNELS.run, { ...INPUT, size: { w: 17, h: 17 } });

    expect(result.ok).toBe(false);
    // Not `code: "error"` with a raw Zod issue array as the message.
    expect(result.code).toBe("bad-input");
    expect(result.message?.startsWith("[")).toBe(false);
    expect(result.message).toContain("w");
    expect(result.message?.length).toBeLessThan(300);
  });
});

// ---------------------------------------------------------------------------
// the preload path — Wave 10's headline blocker, invisible to `npm test`
// ---------------------------------------------------------------------------

/**
 * `webPreferences.preload` pointing at `index.mjs` is the one mutation that
 * breaks the app completely — `window.api` is `undefined`, silently — and no
 * unit test can observe it, because the file that names the path is only read by
 * a running Electron. Asserting on the source is the cheap guard the plan asks
 * for; `npx playwright test` remains the expensive one.
 */
describe("the preload path", () => {
  it("points webPreferences.preload at a .cjs file", async () => {
    const source = await readFile(fromRepo("src/main/index.ts"), "utf8");

    const match = /const PRELOAD\s*=\s*fromOut\(\s*"([^"]+)"\s*\)/.exec(source);
    expect(match, 'src/main/index.ts no longer declares `const PRELOAD = fromOut("…")`').not.toBe(
      null,
    );
    expect((match as RegExpExecArray)[1].endsWith(".cjs")).toBe(true);
    expect(source).toContain("preload: PRELOAD");
    expect(source).not.toContain("preload/index.mjs");
  });

  it("pins the preload bundle to CJS in the build", async () => {
    const source = await readFile(fromRepo("electron.vite.config.ts"), "utf8");

    // `format` is what Electron requires; the extension is what makes the
    // requirement legible at the `webPreferences.preload` path.
    expect(source).toMatch(/format:\s*"cjs"/);
    expect(source).toMatch(/entryFileNames:\s*"\[name]\.cjs"/);
  });

  it("has built the file that path names, when a build exists", () => {
    // Vacuous before `npm run build`, which is correct: this asserts the build's
    // output, and `npm test` does not run one.
    if (!existsSync(fromRepo("out/preload"))) return;
    expect(existsSync(fromRepo("out/preload/index.cjs"))).toBe(true);
  });
});
