/**
 * The only thing the renderer can reach — spec §5.1, §8, §9; plan Wave 10.
 *
 * This file is the contract. `Api` and `Result` are declared here rather than in
 * `shared/schema.ts` (which is closed) or in `main/ipc.ts` (which the renderer
 * may never import, not even for a type, because a value import would pull
 * `node:http` and `pngjs` in behind it). `main/ipc.ts` and `renderer/` both
 * import these as **types**, which erase to nothing.
 *
 * Four facts about this file are load-bearing:
 *
 * **1. It builds as CJS.** `package.json` says `"type": "module"`, so
 * electron-vite would emit ESM here, and **Electron will not load an ESM preload
 * in a sandboxed renderer** — silently. `window.api` comes back `undefined` and
 * the symptom points at `exposeInMainWorld` below, which is correct.
 * `electron.vite.config.ts` pins `format: "cjs"` and `index.cjs`; do not "fix"
 * a missing `window.api` with `sandbox: false`.
 *
 * **2. `onEvent` is not an `invoke` channel and can never be one.** It runs the
 * other way — `webContents.send` in main, `ipcRenderer.on` here — so it is the
 * one entry in `PRELOAD_CHANNELS` that has no `ipcMain.handle` counterpart. It
 * returns its own unsubscriber, because a React effect has to be able to detach
 * and `ipcRenderer` has no scope of its own.
 *
 * **3. Errors arrive as a `Result` envelope, never as a rejection** (spec §9).
 * `ipcMain.handle` serializes a rejection into a plain `Error` and destroys the
 * error's own fields — including the `endpoint` that §9's unreachable-Ollama
 * message is entirely about. Nothing here unwraps or re-throws: the envelope is
 * handed to the renderer intact, which is the only way `endpoint` survives the
 * trip.
 *
 * **4. `PRELOAD_CHANNELS` is spelled twice — here and in `main/ipc.ts`.** That
 * is the cost of rule 3's import ban, and `tests/main/ipc.test.ts` pins the two
 * tables equal so the duplication cannot drift.
 */

import { contextBridge, ipcRenderer } from "electron";

import type {
  HarnessConfig,
  LintReport,
  PipelineEvent,
  SessionHistory,
  Size,
  SpriteDoc,
} from "@shared/schema";
import type { Palette } from "@shared/palettes";

// ---------------------------------------------------------------------------
// the contract
// ---------------------------------------------------------------------------

/**
 * How a failable call answers — spec §9.
 *
 * `endpoint` is optional and present only on the transport failures that have
 * one. It is a field of its own rather than something to parse back out of
 * `message` because §8 has the status bar name the exact endpoint, and a
 * renderer regexing an error string to find it is a renderer that breaks when
 * the message is reworded.
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; endpoint?: string };

/** The two roles §6.8's `models` object defines. */
export type ModelRole = "generator" | "critic";

/** The PNG scales §4/§13 permit. `3` is not one of them. */
export type ExportScale = 1 | 4 | 8 | 16;

/**
 * Every capability the renderer has. Nothing else crosses the boundary.
 *
 * The split between `Promise<T>` and `Promise<Result<T>>` is not cosmetic:
 * `getConfig`, `getPalettes`, `getModels` and `getSessionPath` read state that
 * is already in memory and cannot fail, so an envelope there would be ceremony
 * the renderer has to unwrap for nothing. `listModels` reaches Ollama over HTTP
 * and `bindModel` validates its arguments, so both can fail and both answer
 * with an envelope — plan Wave 10's acceptance criterion 6 names `listModels`
 * specifically, because §9's unreachable-Ollama row is the failure the whole
 * envelope exists for.
 */
export interface Api {
  /** Every model Ollama has installed. Fails when Ollama is unreachable (§9). */
  listModels(): Promise<Result<string[]>>;
  /** The current role bindings, for the pickers' selected values. */
  getModels(): Promise<{ generator: string; critic: string }>;
  /** Rebind one role, writing through to the config the next `run` receives. */
  bindModel(role: ModelRole, model: string): Promise<Result<void>>;
  /** The live `HarnessConfig` — the filmstrip needs `maxRounds` for pending frames. */
  getConfig(): Promise<HarnessConfig>;
  /** The curated palette library (§6.1a). */
  getPalettes(): Promise<Palette[]>;
  /** Draft and critique until a stop condition fires. Resolves at the gate (§12). */
  run(input: { prompt: string; size: Size; paletteId: string }): Promise<Result<SessionHistory>>;
  /** Re-enter `REVISING` with the user's own words against `roundIndex` (§7.3). */
  applyFeedback(feedback: string, roundIndex: number): Promise<Result<SessionHistory>>;
  /** Record the accepted round and transition to `DONE`. Any round, not only the last. */
  accept(roundIndex: number): Promise<Result<SessionHistory>>;
  /**
   * Paint one cell in main and get the result back — spec §8.
   *
   * The renderer does **not** mutate locally: a renderer-local edit is invisible
   * to export, history and the critic, which in v1 meant hand-editing and then
   * exporting produced a PNG without the edits and without an error.
   */
  setPixel(
    roundIndex: number,
    x: number,
    y: number,
    ch: string,
  ): Promise<Result<{ doc: SpriteDoc; lint: LintReport }>>;
  /** Write a PNG and return its path. Wave 13; answers `not-implemented` until then. */
  exportPng(roundIndex: number, scale: ExportScale): Promise<Result<string>>;
  /**
   * The session main is holding, or `null` before the first run — plan Wave 11.
   *
   * The renderer had no way to *read* a session, only to receive one from a call
   * that changed it. That works until the first hand edit: `setPixel` answers
   * `{doc, lint}`, so after a click the renderer's history is stale in three
   * places it cannot reconstruct — an edit to an earlier round **appended a whole
   * new round**, an edit to the accepted round **cleared `acceptedRound`**, and
   * `diffFromPrev` was **recomputed** (`main/ipc.ts`, rule 4). The filmstrip
   * reads all three.
   *
   * A `Result` rather than a bare value even though the read cannot fail: `null`
   * is a legitimate answer here — "no session yet" — and collapsing it with a
   * future failure would make the one state the first-run surface has to render
   * indistinguishable from a broken one.
   */
  getSession(): Promise<Result<SessionHistory | null>>;
  /** Where the current session's JSON lives, so Wave 14 can open it. */
  getSessionPath(): Promise<string>;
  /** Subscribe to the pipeline's event stream (§7.1). Returns its own unsubscriber. */
  onEvent(cb: (e: PipelineEvent) => void): () => void;
}

/**
 * Method name → channel name.
 *
 * `satisfies` rather than a bare annotation, so a missing key *and* a key that
 * is not an `Api` method are both compile errors while the values stay literal.
 */
export const PRELOAD_CHANNELS = {
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
  getSession: "get-session",
  getSessionPath: "get-session-path",
  // Fact 2: `webContents.send` → `ipcRenderer.on`, not `invoke` → `handle`.
  onEvent: "pipeline-event",
} as const satisfies Record<keyof Api, string>;

// ---------------------------------------------------------------------------
// the bridge
// ---------------------------------------------------------------------------

const api: Api = {
  listModels: () => ipcRenderer.invoke(PRELOAD_CHANNELS.listModels),
  getModels: () => ipcRenderer.invoke(PRELOAD_CHANNELS.getModels),
  bindModel: (role, model) => ipcRenderer.invoke(PRELOAD_CHANNELS.bindModel, role, model),
  getConfig: () => ipcRenderer.invoke(PRELOAD_CHANNELS.getConfig),
  getPalettes: () => ipcRenderer.invoke(PRELOAD_CHANNELS.getPalettes),
  run: (input) => ipcRenderer.invoke(PRELOAD_CHANNELS.run, input),
  applyFeedback: (feedback, roundIndex) =>
    ipcRenderer.invoke(PRELOAD_CHANNELS.applyFeedback, feedback, roundIndex),
  accept: (roundIndex) => ipcRenderer.invoke(PRELOAD_CHANNELS.accept, roundIndex),
  setPixel: (roundIndex, x, y, ch) =>
    ipcRenderer.invoke(PRELOAD_CHANNELS.setPixel, roundIndex, x, y, ch),
  exportPng: (roundIndex, scale) =>
    ipcRenderer.invoke(PRELOAD_CHANNELS.exportPng, roundIndex, scale),
  getSession: () => ipcRenderer.invoke(PRELOAD_CHANNELS.getSession),
  getSessionPath: () => ipcRenderer.invoke(PRELOAD_CHANNELS.getSessionPath),

  onEvent(cb: (e: PipelineEvent) => void): () => void {
    // The `IpcRendererEvent` is deliberately dropped: handing it to the renderer
    // would expose `sender`, and with it a path back out of the sandbox.
    const listener = (_event: unknown, payload: PipelineEvent): void => cb(payload);
    ipcRenderer.on(PRELOAD_CHANNELS.onEvent, listener);
    return () => {
      ipcRenderer.removeListener(PRELOAD_CHANNELS.onEvent, listener);
    };
  },
};

contextBridge.exposeInMainWorld("api", api);
