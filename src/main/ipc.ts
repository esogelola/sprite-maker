/**
 * The typed IPC surface — spec §5.1, §5.2, §8, §9; plan Wave 10.
 *
 * **Main owns the session.** `currentSession` below is the single authority, and
 * every round-indexed method resolves against it. The renderer is pure
 * presentation (§5.1): it holds no pipeline logic, mutates no document, and
 * cannot get out of step with what export, history and the critic will see. v1
 * put hand edits in renderer state, so painting and then exporting produced a
 * PNG without the edits **and without an error** — the defect §8 now names
 * explicitly.
 *
 * Four rules govern this file:
 *
 * **1. Errors cross as a `Result` envelope, never as a rejection** (§9).
 * `ipcMain.handle` serializes a rejection into a plain `Error` and destroys the
 * error's own properties, discarding the very `endpoint` that §9's
 * unreachable-Ollama row is about while §8 has the status bar name it exactly.
 * `envelope()` below is therefore the only way a handler answers.
 *
 * **2. `onEvent` is not — and cannot be — an `ipcMain.handle` channel.** It runs
 * the other direction: `webContents.send` here, `ipcRenderer.on` in the preload.
 * It is the one entry in `CHANNELS` with no handler, and a test asserting
 * otherwise fails against a correct implementation.
 *
 * **3. `roundIndex` is the renderer's 0-based array position, and `0` is a
 * value.** It is the first round and the most common accept target, so every
 * index check goes through `roundAt`, which tests `Number.isInteger` rather than
 * truthiness. A falsy check reads `accept(0)` as "no argument".
 *
 * **4. An edit to the last round mutates it; an edit to an earlier round appends
 * a new round parented to the one edited** (§8). Mutating an earlier round in
 * place would invalidate every later round's `diffFromPrev`, and the filmstrip
 * is *defined* as replaying those diffs.
 *
 * `pipeline.ts` stays Electron-free: `persist` is handed in as a callback that
 * closes over `saveHistory` and a directory this module receives, rather than
 * `pipeline.ts` reaching for `app.getPath`.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { ipcMain } from "electron";

import { appendRound, roundAt, saveHistory } from "@main/history";
import { lint } from "@main/lint";
import {
  OllamaHttpError,
  OllamaTimeoutError,
  OllamaUnreachableError,
  type OllamaClient,
} from "@main/ollama";
import { createModelRegistry, type ModelRole } from "@main/models";
import { accept, applyFeedback, run, type PipelineDeps, type PipelineInput } from "@main/pipeline";
import { GridError, diff, setPixel as setGridPixel } from "@shared/grid";
import { listPalettes } from "@shared/palettes";
import {
  RoundSchema,
  SizeSchema,
  SpriteDocSchema,
  type HarnessConfig,
  type LintReport,
  type PipelineEvent,
  type Round,
  type SessionHistory,
  type SpriteDoc,
} from "@shared/schema";

import type { Api, ExportScale, Result } from "../preload/index";

// ---------------------------------------------------------------------------
// the channel table
// ---------------------------------------------------------------------------

/**
 * Method name → channel name. **Must stay identical to `PRELOAD_CHANNELS`.**
 *
 * Spelled twice rather than shared, because the preload may not import this
 * module: doing so would drag `node:http`, `pngjs` and the whole harness into
 * the preload bundle. `tests/main/ipc.test.ts` pins the two tables equal, which
 * is the guard that duplication is worth.
 *
 * `satisfies` keeps the values literal while making both a missing key and a key
 * that is not an `Api` method compile errors.
 */
export const CHANNELS = {
  listModels: "list-models",
  getModels: "get-models",
  bindModel: "bind-model",
  getConfig: "get-config",
  getPalettes: "get-palettes",
  run: "run",
  applyFeedback: "apply-feedback",
  accept: "accept",
  setPixel: "set-pixel",
  exportPng: "export-png",
  getSessionPath: "get-session-path",
  // Rule 2. No `ipcMain.handle` for this one, ever.
  onEvent: "pipeline-event",
} as const satisfies Record<keyof Api, string>;

// ---------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------

/**
 * The half of `Electron.WebContents` this module uses.
 *
 * Structural, so `tests/main/ipc.test.ts` can supply a double and assert on the
 * `send` channel without an Electron runtime. A real `WebContents` satisfies it
 * unchanged.
 */
export interface RendererTarget {
  send(channel: string, payload: PipelineEvent): void;
  isDestroyed(): boolean;
}

export interface IpcDeps {
  /** The sole HTTP boundary (§5.2). Injected, so the surface is stub-testable. */
  client: OllamaClient;
  /**
   * The live config. **Mutated in place by `bindModel`**, via the registry's
   * write-through (`models.ts`): a run must call the model the picker chose, and
   * the config serialized into `SessionHistory` must name the model the run
   * actually used.
   */
  config: HarnessConfig;
  /** Where `saveHistory` writes. Passed in so `pipeline.ts` stays Electron-free. */
  sessionDir: string;
  /**
   * The live renderer, or `null` before the window exists / after it is gone.
   *
   * A getter rather than the object, because handlers are registered before the
   * window is created and an event may fire after it is destroyed.
   */
  renderer: () => RendererTarget | null;
}

// ---------------------------------------------------------------------------
// the session — main owns it
// ---------------------------------------------------------------------------

/**
 * The one session this process holds. `null` until the first `run`.
 *
 * Module-level rather than per-window: §2 scopes the MVP to one editor, and the
 * alternative — a session per `webContents` — would make "which sprite does
 * `exportPng(0)` mean" a question with two answers.
 */
let currentSession: SessionHistory | null = null;

function requireSession(caller: string): SessionHistory {
  if (currentSession === null) {
    throw new IpcError(
      "no-session",
      `${caller}: no session yet — generate a sprite before addressing a round`,
    );
  }
  return currentSession;
}

// ---------------------------------------------------------------------------
// the Result envelope — rule 1, spec §9
// ---------------------------------------------------------------------------

/** A failure whose `code` this module chose deliberately, rather than inferred. */
class IpcError extends Error {
  override readonly name = "IpcError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A stable machine-readable code for a thrown value.
 *
 * The renderer branches on this — §8 disables Generate on
 * `ollama-unreachable` — so it must not be the error's class name, which a
 * refactor renames.
 */
function errorCode(error: unknown): string {
  if (error instanceof IpcError) return error.code;
  if (error instanceof OllamaUnreachableError) return "ollama-unreachable";
  if (error instanceof OllamaTimeoutError) return "ollama-timeout";
  if (error instanceof OllamaHttpError) return "ollama-http";
  // `out-of-bounds` / `off-palette` / `bad-char` — already the vocabulary the
  // revise loop branches on, so the renderer gets the same three.
  if (error instanceof GridError) return error.code;
  if (error instanceof RangeError) return "bad-index";
  return "error";
}

/**
 * Whatever `endpoint` the error carries, or nothing.
 *
 * Read off the value rather than switched on the class, so
 * `OllamaUnreachableError` and `OllamaHttpError` are both covered and a future
 * error that carries one is covered for free. **This is the field
 * `ipcMain.handle` destroys**, and §8's status-bar requirement is entirely about
 * it.
 */
function errorEndpoint(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const endpoint = (error as { endpoint?: unknown }).endpoint;
  return typeof endpoint === "string" && endpoint.length > 0 ? endpoint : undefined;
}

function failure(error: unknown): Extract<Result<never>, { ok: false }> {
  const base = {
    ok: false as const,
    code: errorCode(error),
    message: error instanceof Error ? error.message : String(error),
  };
  const endpoint = errorEndpoint(error);
  return endpoint === undefined ? base : { ...base, endpoint };
}

/**
 * Run `body` and answer with an envelope either way — rule 1.
 *
 * Every failable handler is wrapped in this, so no handler can reject and there
 * is exactly one place a rejection could leak from.
 */
async function envelope<T>(body: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, value: await body() };
  } catch (error) {
    return failure(error);
  }
}

// ---------------------------------------------------------------------------
// argument validation — the renderer's word is not trusted
// ---------------------------------------------------------------------------

/**
 * `run`'s input, validated.
 *
 * TypeScript's guarantee is spent by the time an argument arrives over IPC, and
 * `size` in particular has to be one of §6.2's three squares — the schema is a
 * discriminated union precisely so a non-square names the offending field.
 */
function parseRunInput(raw: unknown): PipelineInput {
  if (raw === null || typeof raw !== "object") {
    throw new IpcError("bad-input", `run: expected an input object, got ${String(raw)}`);
  }
  const { prompt, size, paletteId } = raw as Record<string, unknown>;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new IpcError("bad-input", "run: prompt must be a non-empty string");
  }
  if (typeof paletteId !== "string" || paletteId.length === 0) {
    throw new IpcError("bad-input", "run: paletteId must be a non-empty string");
  }
  return { prompt, size: SizeSchema.parse(size), paletteId };
}

function parseFeedback(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new IpcError("bad-input", "applyFeedback: feedback must be a non-empty string");
  }
  return raw;
}

function parseChar(raw: unknown): string {
  if (typeof raw !== "string" || raw.length !== 1) {
    throw new IpcError(
      "bad-char",
      `setPixel: expected a single character, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function parseCoord(raw: unknown, name: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    // Not a truthiness check: `0` is the first column and the first row.
    throw new IpcError(
      "out-of-bounds",
      `setPixel: ${name} must be a whole non-negative number, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// setPixel — spec §8, rule 4
// ---------------------------------------------------------------------------

/** The round whose document `parentId` names, or `undefined` for a root round. */
function findParent(session: SessionHistory, doc: SpriteDoc): Round | undefined {
  const parentId = doc.meta.parentId;
  if (parentId === null) return undefined;
  const parent = session.rounds.find((existing) => existing.doc.id === parentId);
  if (parent === undefined) {
    throw new Error(
      `setPixel: round names parent '${parentId}', which is not a document in this session`,
    );
  }
  return parent;
}

/**
 * Replace `rounds[index]` with the same round over new pixels — rule 4, last
 * round only.
 *
 * `diffFromPrev` is **recomputed**, not carried: it is measured against the
 * parent's pixels, and the pixels just changed. `null` and `[]` stay different
 * values (a root round has no predecessor; `[]` means nothing changed), so this
 * mirrors `appendRound` rather than guessing.
 *
 * `lint` is recomputed for the same reason — §8 renders it beside the critique,
 * and a stale orphan count is a wrong answer rather than a missing one. The
 * `critique` is deliberately *kept*: it is the critic's account of a document
 * this edit only nudged, §8 has the dock render whenever a critique exists, and
 * discarding it would make the dock vanish the moment the user paints a pixel.
 */
function replaceRound(session: SessionHistory, index: number, rows: string[]): Round {
  const existing = roundAt(session, index, "setPixel");
  const doc = SpriteDocSchema.parse({ ...existing.doc, rows });
  const parent = findParent(session, doc);

  const updated = RoundSchema.parse({
    ...existing,
    doc,
    lint: lint(doc),
    diffFromPrev: parent === undefined ? null : diff(parent.doc.rows, doc.rows),
  });

  const rounds = session.rounds.slice();
  rounds[index] = updated;
  currentSession = { ...session, rounds };
  return updated;
}

/**
 * Append a new round over new pixels, parented to `rounds[index]` — rule 4,
 * earlier rounds.
 *
 * `meta` is rebuilt rather than spread, exactly as `pipeline.ts` does it (§7.5):
 * a fresh `id` and `createdAt`, `parentId` naming the round the user edited, and
 * `repairs: 0` / `repairedRows: []`, because the repairs belonged to the draft
 * and re-firing `row-repaired` on a hand edit would be a warning about nothing.
 *
 * `critique` is `null` and `timings` are all `null`: no model has seen this
 * document. `appendRound` recomputes `diffFromPrev` from the lineage, which is
 * why `null` is passed rather than a computed diff.
 */
function appendEditedRound(
  session: SessionHistory,
  index: number,
  rows: string[],
  config: HarnessConfig,
): Round {
  const source = roundAt(session, index, "setPixel");
  const round = session.rounds.length + 1;

  const doc = SpriteDocSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    prompt: source.doc.prompt,
    intent: source.doc.intent,
    size: source.doc.size,
    palette: { id: source.doc.palette.id, colors: [...source.doc.palette.colors] },
    rows,
    meta: {
      generatorModel: config.models.generator,
      criticModel: config.models.critic,
      round,
      parentId: source.doc.id,
      repairs: 0,
      repairedRows: [],
    },
  });

  const next = appendRound(session, {
    round,
    doc,
    lint: lint(doc),
    critique: null,
    filteredIssues: [],
    diffFromPrev: null,
    userFeedback: null,
    revise: null,
    timings: { draftMs: null, critiqueMs: null, reviseMs: null },
  });

  currentSession = next;
  return next.rounds[next.rounds.length - 1];
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/**
 * Register every channel in `CHANNELS` except `onEvent` — rule 2.
 *
 * Called once, from `main/index.ts`, before the window is created. Resets
 * `currentSession`: registering the surface is what starting a main process
 * means, and a stale session surviving it would be a bug with no other symptom.
 */
export function registerIpc(deps: IpcDeps): void {
  currentSession = null;

  const registry = createModelRegistry(deps.client, deps.config);

  /** Where pipeline events go — rule 2. The only `webContents.send` in the app. */
  function emit(event: PipelineEvent): void {
    const target = deps.renderer();
    if (target === null || target.isDestroyed()) return;
    target.send(CHANNELS.onEvent, event);
  }

  const pipelineDeps: PipelineDeps = {
    client: deps.client,
    onEvent: emit,
    // §9: history is written after every round, so at most one round is lost to
    // a crash. `pipeline.ts` guards every call, so a full disk is recorded on
    // `SessionHistory.error` rather than failing a run that succeeded.
    persist: async (history) => {
      await saveHistory(history, deps.sessionDir);
    },
  };

  /** The path `saveHistory` writes a given session to. */
  function sessionPath(history: SessionHistory): string {
    return join(deps.sessionDir, `${history.sessionId}.json`);
  }

  // -- models, config, palettes ---------------------------------------------

  ipcMain.handle(CHANNELS.listModels, async () => envelope(() => registry.list()));

  ipcMain.handle(CHANNELS.getModels, async () => registry.roles());

  ipcMain.handle(CHANNELS.bindModel, async (_event, role: unknown, model: unknown) =>
    envelope<void>(() => {
      // `bind` validates the role at runtime for exactly this reason: the pickers
      // reach it through IPC, where TypeScript's guarantee is already spent.
      registry.bind(role as ModelRole, model as string);
    }),
  );

  // Cannot fail, so no envelope: a `Result` here would be ceremony the renderer
  // unwraps for nothing. Copied one level deep so a renderer that mutates the
  // object it received cannot edit the live config from behind.
  ipcMain.handle(CHANNELS.getConfig, async () => ({
    ...deps.config,
    models: { ...deps.config.models },
  }));

  ipcMain.handle(CHANNELS.getPalettes, async () => listPalettes());

  // -- the pipeline ---------------------------------------------------------

  /**
   * `run` **resolves with a FAILED history rather than rejecting**, so a partial
   * failure still becomes `currentSession`: the rounds already snapshotted are
   * the only record of a multi-minute run, and §8 reads state, stop reason and
   * `error` off the history. Only a bad config rejects, and that is `ok: false`.
   */
  ipcMain.handle(CHANNELS.run, async (_event, input: unknown) =>
    envelope(async () => {
      const history = await run(pipelineDeps, parseRunInput(input), deps.config);
      currentSession = history;
      return history;
    }),
  );

  ipcMain.handle(
    CHANNELS.applyFeedback,
    async (_event, feedback: unknown, roundIndex: unknown) =>
      envelope(async () => {
        const session = requireSession("applyFeedback");
        // Rule 3: `roundAt` rejects a non-integer or out-of-range index and
        // accepts `0`. Called here as well as inside `applyFeedback` so a bad
        // index costs no inference.
        roundAt(session, roundIndex as number, "applyFeedback");
        const history = await applyFeedback(
          pipelineDeps,
          session,
          parseFeedback(feedback),
          roundIndex as number,
          deps.config,
        );
        currentSession = history;
        return history;
      }),
  );

  /**
   * Accept any round — §8, §6.7. `pipeline.accept` converts the 0-based index to
   * the 1-based `Round.round` that `acceptedRound` holds.
   *
   * It takes no `PipelineDeps`, so writing the accepted session out is this
   * layer's job: `acceptedRound` is what §11's bars read off the artifact, and
   * an accept that never reached disk would be invisible after a reload.
   */
  ipcMain.handle(CHANNELS.accept, async (_event, roundIndex: unknown) =>
    envelope(async () => {
      const session = requireSession("accept");
      const history = await accept(session, roundIndex as number);
      currentSession = history;
      await persistQuietly(history, deps.sessionDir);
      return history;
    }),
  );

  ipcMain.handle(
    CHANNELS.setPixel,
    async (_event, roundIndex: unknown, x: unknown, y: unknown, ch: unknown) =>
      envelope<{ doc: SpriteDoc; lint: LintReport }>(async () => {
        const session = requireSession("setPixel");
        const index = roundIndex as number;
        const source = roundAt(session, index, "setPixel");

        // Every pixel mutation in the system routes through `shared/grid.ts`, so
        // a mouse click hits the identical bounds and palette checks the agent's
        // `place_pixel` does.
        const rows = setGridPixel(
          source.doc.rows,
          parseCoord(x, "x"),
          parseCoord(y, "y"),
          parseChar(ch),
          source.doc.palette.colors.length,
        );

        // Rule 4.
        const isLast = index === session.rounds.length - 1;
        const round = isLast
          ? replaceRound(session, index, rows)
          : appendEditedRound(session, index, rows, deps.config);

        if (currentSession !== null) await persistQuietly(currentSession, deps.sessionDir);
        return { doc: round.doc, lint: round.lint };
      }),
  );

  // Blocker 5: `src/main/export.ts` is a Wave 13 file, and Wave 10's own test
  // requires every `Api` key to be a registered channel. A registered handler
  // that names its own absence is the honest placeholder; an unregistered
  // channel rejects with "No handler registered", which reads as a wiring bug.
  ipcMain.handle(CHANNELS.exportPng, async (_event, roundIndex: unknown, scale: unknown) =>
    envelope<string>(() => {
      throw new IpcError(
        "not-implemented",
        `exportPng(${String(roundIndex)}, ${String(scale as ExportScale)}) is not implemented ` +
          "until Wave 13 builds src/main/export.ts",
      );
    }),
  );

  // Cannot fail: with no session there is still an answer, and it is the one
  // Wave 14 wants — the directory the sessions live in. `""` would be a falsy
  // path that every caller has to special-case.
  ipcMain.handle(CHANNELS.getSessionPath, async () =>
    currentSession === null ? deps.sessionDir : sessionPath(currentSession),
  );
}

/**
 * Write a session out without letting the write fail the call.
 *
 * The same reasoning `pipeline.ts` applies to its own `persist`: the session is
 * already in memory and the operation the user asked for already succeeded, so a
 * full disk must not turn an accepted round or a painted pixel into an error.
 * Recorded on the history's `error` field would be wrong here — that field is the
 * pipeline's account of why a *run* failed — so this reports to the log, which
 * is the channel a main process has.
 */
async function persistQuietly(history: SessionHistory, dir: string): Promise<void> {
  try {
    await saveHistory(history, dir);
  } catch (error) {
    console.error("failed to persist the session:", error);
  }
}
