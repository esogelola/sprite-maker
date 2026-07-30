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
 * Six rules govern this file:
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
 * **5. One mutation at a time, and a refusal is never dressed as a success.**
 * `currentSession` is a read-modify-write across an `await`, and §12 measures a
 * run in minutes — so `accept` during an in-flight `run` used to return
 * `{ok: true, acceptedRound: 1}` and then have the resolving run overwrite it
 * with `acceptedRound: null`. The user's Accept was gone and they had been told
 * it worked, which is audit blocker B12 — §8's "hand-editing then exporting
 * produced a PNG without the edits **and without an error**" — arriving through
 * concurrency instead of renderer state. `App.tsx`'s `busy` flag cannot fix it:
 * it is renderer state, and rule 0 of this whole file is that the renderer is not
 * an authority. Every session-mutating handler therefore goes through
 * `exclusive`, and a second one answers `{ok: false, code: "busy"}`.
 *
 * **6. `currentSession` is live for the duration of a run**, not written once at
 * the end. It used to be assigned only after `run()` resolved, so for a run's
 * entire multi-minute duration every round-indexed method answered `no-session`
 * while rounds were already on screen via `onEvent` and already on disk via
 * `persist` — Wave 10's own boot capture recorded `getSessionPath` returning the
 * session *directory* for exactly this reason. The `persist` callback below
 * therefore adopts each history as it is written.
 *
 * `pipeline.ts` stays Electron-free: `persist` is handed in as a callback that
 * closes over `saveHistory` and a directory this module receives, rather than
 * `pipeline.ts` reaching for `app.getPath`.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { ipcMain } from "electron";
import { ZodError } from "zod";

import { appendRound, roundAt, saveHistory } from "@main/history";
import { lint } from "@main/lint";
import {
  OllamaHttpError,
  OllamaTimeoutError,
  OllamaUnreachableError,
  type OllamaClient,
} from "@main/ollama";
import { MODEL_ROLES, createModelRegistry, type ModelRole } from "@main/models";
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

/**
 * The name of the mutation currently in flight, or `null` — rule 5.
 *
 * A string rather than a boolean so the refusal can name what it is waiting on:
 * §12 puts a run at several minutes, and "busy" alone is not something a status
 * bar can explain. Compared against `null` explicitly, never for truthiness —
 * this file's rule 3 about falsy `0` is a habit, not a special case.
 */
let inFlight: string | null = null;

/**
 * Bumped by every `registerIpc`.
 *
 * A registration is what starting a main process means, so anything still in
 * flight from a previous one belongs to a session this process no longer has.
 * Without the token such a straggler would resolve later and write its history
 * into the new `currentSession`, or clear a lock it does not hold — the same
 * class of write race rule 5 exists to close, one level up.
 */
let generation = 0;

/**
 * Hold the session for the duration of `body` — rule 5.
 *
 * The check-and-set is deliberately synchronous, before any `await`: an IPC
 * handler is invoked synchronously by `ipcMain`, so a second call that arrives
 * while the first is suspended sees the flag only if it was set in the first
 * call's synchronous prologue.
 *
 * There is no queue. A queued Accept would run against a session it was never
 * shown — the user chose round 1 of what was on screen, and by the time the run
 * resolves there may be three rounds and a different last one. Refusing tells
 * the truth; queueing guesses.
 */
async function exclusive<T>(caller: string, body: () => Promise<T>): Promise<T> {
  if (inFlight !== null) {
    throw new IpcError(
      "busy",
      `${caller}: ${inFlight} is still in flight — one session mutation at a time`,
    );
  }
  const gen = generation;
  inFlight = caller;
  try {
    return await body();
  } finally {
    // Not `inFlight = null` unconditionally: a straggler from a superseded
    // registration must not clear the lock the current one is holding.
    if (gen === generation) inFlight = null;
  }
}

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
 *
 * **There is deliberately no `RangeError → "bad-index"` rule.** `roundAt` and
 * `models.bind` both throw `RangeError`, so that one line reported an unknown
 * model role, an empty model name and a genuinely bad round index with the same
 * code — three unrelated causes the renderer cannot tell apart, on the field §8
 * says it branches on. Each cause is now classified where it is raised
 * (`requireRound`, `parseRole`, `parseModelName`), and an unclassified
 * `RangeError` falls through to `"error"` rather than borrowing a code that is
 * about something else.
 */
function errorCode(error: unknown): string {
  if (error instanceof IpcError) return error.code;
  if (error instanceof OllamaUnreachableError) return "ollama-unreachable";
  if (error instanceof OllamaTimeoutError) return "ollama-timeout";
  if (error instanceof OllamaHttpError) return "ollama-http";
  // `out-of-bounds` / `off-palette` / `bad-char` — already the vocabulary the
  // revise loop branches on, so the renderer gets the same three.
  if (error instanceof GridError) return error.code;
  // A schema rejection is a bad argument, which is what `bad-input` already
  // means for the hand-written checks one section down.
  if (error instanceof ZodError) return "bad-input";
  return "error";
}

/**
 * The human half of the envelope — the string §8 puts in the status bar.
 *
 * A `ZodError`'s own `message` is `JSON.stringify(issues)`: a multi-hundred
 * character array of `{code, path, expected, received}` objects, which is
 * unrenderable in a one-line status bar and tells the user nothing they can act
 * on. Flattened here to `path: message` pairs, at the boundary, so every schema
 * in the system gets it without each one restating its own errors.
 */
function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
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
    message: errorMessage(error),
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

/**
 * `roundAt`, with its `RangeError` carrying a code the renderer can branch on.
 *
 * Rule 3: `Number.isInteger`, never truthiness — `roundIndex: 0` is the first
 * round and the most common accept target. Called at the top of every
 * round-indexed handler so a bad index costs no inference, and so the code says
 * `bad-index` rather than whatever the *next* `RangeError` in the stack happens
 * to be about.
 */
function requireRound(
  session: SessionHistory,
  index: unknown,
  caller: string,
): { index: number; round: Round } {
  if (typeof index !== "number" || !Number.isInteger(index)) {
    throw new IpcError(
      "bad-index",
      `${caller}: roundIndex must be a whole number, got ${JSON.stringify(index)}`,
    );
  }
  try {
    // The narrowed index is handed back rather than recovered by the caller with
    // a cast, and never derived from `Round.round` — that is the 1-based *round
    // number*, and re-deriving a position from it would quietly depend on an
    // invariant `pipeline.ts` documents but nothing here enforces.
    return { index, round: roundAt(session, index, caller) };
  } catch (error) {
    throw new IpcError("bad-index", errorMessage(error));
  }
}

/**
 * One of §6.8's two roles, or a `bad-role` failure.
 *
 * Checked here as well as inside `registry.bind` — which is right to keep its own
 * guard — because only this layer knows what the renderer needs to hear. `bind`
 * throws a `RangeError`, and a `RangeError` is also what a bad round index
 * throws, so the two arrived at the renderer indistinguishable.
 */
function parseRole(raw: unknown): ModelRole {
  if (typeof raw !== "string" || !(MODEL_ROLES as readonly string[]).includes(raw)) {
    throw new IpcError(
      "bad-role",
      `bindModel: unknown model role ${JSON.stringify(raw)} — expected one of ` +
        `${MODEL_ROLES.map((role) => `'${role}'`).join(", ")}`,
    );
  }
  return raw as ModelRole;
}

/** A non-empty model name, or a `bad-model` failure. Whitespace 404s at Ollama. */
function parseModelName(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new IpcError(
      "bad-model",
      `bindModel: model must be a non-empty name, got ${JSON.stringify(raw)}`,
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
  currentSession = releaseAcceptance({ ...session, rounds }, existing.round);
  return updated;
}

/**
 * A hand edit to the accepted round's own document clears the acceptance.
 *
 * The choice was between refusing the edit and clearing the acceptance, and it is
 * settled by Wave 14's gate script, which runs Accept (feature 10) *before* hand
 * editing (11) and PNG export (12) — where feature 12 is explicitly "including
 * hand edits from #11". Refusing would make the ratified gate unrunnable and
 * leave a session with no way back to editing, since there is no un-accept.
 *
 * Clearing is also the only honest record: §11's first bar and Wave 14's feature
 * 10 read `acceptedRound` off the artifact, and after this edit that number would
 * name a document the user has since repainted. `finalState` returns to exactly
 * what `accept` replaced — `finish()` leaves a completed run at `AWAITING_USER`
 * and `fail()` leaves a failed one at `FAILED` — so a failed run is not laundered
 * into one that reached the gate. `outcome`, `stopReason` and `error` are
 * untouched: they describe the *run*, which this edit did not change.
 *
 * **Only when the accepted document itself changed.** Editing an earlier round
 * appends a new one and leaves the accepted round exactly as accepted, so
 * `acceptedRound` is still a true statement about the artifact and nulling it
 * would destroy a measurement §11 depends on.
 */
function releaseAcceptance(session: SessionHistory, editedRound: number): SessionHistory {
  if (session.acceptedRound === null || session.acceptedRound !== editedRound) return session;
  return {
    ...session,
    acceptedRound: null,
    finalState: session.outcome === "completed" ? "AWAITING_USER" : "FAILED",
  };
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
  inFlight = null;
  const gen = ++generation;

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
      // Rule 6. Adopted *before* the write, not after: `getSessionPath` and every
      // round-indexed method should answer about the round the user is already
      // looking at, and whether the disk accepted it is a separate question.
      if (gen === generation) currentSession = history;
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
      // Validated at runtime for exactly this reason: the pickers reach it
      // through IPC, where TypeScript's guarantee is already spent. Done here
      // rather than left to `bind`'s own guard so the two failures carry
      // different codes — `bind` throws `RangeError` for both, which is what made
      // an unknown role and an empty name indistinguishable from a bad round
      // index. `bind` keeps its guard; this one chooses the words.
      registry.bind(parseRole(role), parseModelName(model));
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
    envelope(() =>
      exclusive("run", async () => {
        const history = await run(pipelineDeps, parseRunInput(input), deps.config);
        // `persist` has been adopting each round as it landed (rule 6); this is
        // the terminal write, and the only one that carries a `persist` failure
        // recorded on `error`.
        currentSession = history;
        return history;
      }),
    ),
  );

  ipcMain.handle(
    CHANNELS.applyFeedback,
    async (_event, feedback: unknown, roundIndex: unknown) =>
      envelope(() =>
        exclusive("applyFeedback", async () => {
          const session = requireSession("applyFeedback");
          // Rule 3: `requireRound` rejects a non-integer or out-of-range index
          // and accepts `0`. Called here as well as inside `applyFeedback` so a
          // bad index costs no inference and reports `bad-index`.
          const { index } = requireRound(session, roundIndex, "applyFeedback");
          const history = await applyFeedback(
            pipelineDeps,
            session,
            parseFeedback(feedback),
            index,
            deps.config,
          );
          currentSession = history;
          return history;
        }),
      ),
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
    envelope(() =>
      exclusive("accept", async () => {
        const session = requireSession("accept");
        const { index } = requireRound(session, roundIndex, "accept");
        const history = await accept(session, index);
        currentSession = history;
        // Rule 5's other half: the envelope below reports `ok` only after this
        // write, so an `ok: true` accept is one a reload can still see.
        await persistQuietly(history, deps.sessionDir);
        return history;
      }),
    ),
  );

  ipcMain.handle(
    CHANNELS.setPixel,
    async (_event, roundIndex: unknown, x: unknown, y: unknown, ch: unknown) =>
      envelope<{ doc: SpriteDoc; lint: LintReport }>(() =>
        exclusive("setPixel", async () => {
          const session = requireSession("setPixel");
          const { index, round: source } = requireRound(session, roundIndex, "setPixel");

          // Every pixel mutation in the system routes through `shared/grid.ts`,
          // so a mouse click hits the identical bounds and palette checks the
          // agent's `place_pixel` does.
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

          // §8's own sentence is about this line: an edit that does not reach the
          // artifact is a PNG exported without the edits and without an error.
          if (currentSession !== null) await persistQuietly(currentSession, deps.sessionDir);
          return { doc: round.doc, lint: round.lint };
        }),
      ),
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
