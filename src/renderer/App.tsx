/**
 * The editor — spec §5.1, §8; plan Wave 11.
 *
 * Wave 10's shell rendered `SpriteDoc.rows` into a `<pre>`. That was the right
 * stand-in for proving the wiring and the wrong artifact for judging a sprite:
 * the failure this app has actually been measured to have — the revise stage
 * degrading the draft, symmetry 0.955 → 0.410, and in one recorded run the best
 * sprite being round 1 — cannot be seen in a grid of digits. The `<pre>` is
 * replaced here by the three surfaces that make it visible: a `Canvas`, a
 * `PaletteBar` built from the *document's* palette, and a `Filmstrip` whose
 * selected frame is what the canvas draws.
 *
 * What this file owns, and nothing more:
 *
 * - **The `onEvent` subscription.** `run()` resolves at the gate, which §12
 *   measures in minutes; the `round` event carries the whole snapshot precisely
 *   so a mid-run surface has a source (§7.1). Rendering only from `run`'s result
 *   would leave the window empty for the entire draft-and-critique cycle.
 * - **Routing a click to main.** A canvas click becomes `Api.setPixel`, and the
 *   answer is *re-read* with `Api.getSession` rather than merged locally. §8:
 *   "a renderer-local edit would be invisible to export, history and the critic,
 *   which in v1 meant hand-editing then exporting produced a PNG without the
 *   edits and without an error." `setPixel` answers `{doc, lint}`, so the round
 *   it may have **appended**, the acceptance it may have **cleared** and the
 *   `diffFromPrev` it **recomputed** are only knowable by asking.
 * - **Following the edit.** An edit to an earlier round appends a new round
 *   (§8), so the document the user just painted is not the one they were looking
 *   at. The selection moves to whichever round now holds `result.value.doc.id`,
 *   which is the same line in both branches and is why the id is matched rather
 *   than the index guessed.
 *
 * The renderer holds no pipeline logic (§5.1). Every `@shared` import is
 * type-only or pure data, and there is no import from `@main` at all — a value
 * import of `main/pipeline` would pull `node:http` into this bundle.
 *
 * **Still deliberately absent**, and Wave 12's: the critique dock, the size and
 * palette pickers, the model pickers, and the gate bar (feedback / Accept /
 * Export). `getSession` also makes a renderer reload able to restore the session
 * main is still holding; that belongs with the status bar and the gate, not here.
 */

import { useCallback, useEffect, useState, type CSSProperties } from "react";

import type { PipelineEvent, SessionHistory } from "@shared/schema";

import { Canvas } from "./components/Canvas";
import { Filmstrip } from "./components/Filmstrip";
import { PaletteBar } from "./components/PaletteBar";
import { currentRound, editorStore, useEditor } from "./state/store";

import type { Api } from "../preload/index";

declare global {
  interface Window {
    /** Exposed by `src/preload/index.ts` through `contextBridge`. */
    api: Api;
  }
}

/**
 * Wave 12 builds the size and palette pickers; §8's layout sketch shows
 * `[32▾] [pico-8▾]` where these stand.
 *
 * 16×16 rather than §8's 32 for the reason Wave 10 recorded and Wave 6c did not
 * overturn: the smaller canvas is the one a live run completes reliably, and
 * §6.8's `callTimeoutFloorMs` (amendment A12) exists because the area-scaled
 * budget made it the *tightest* deadline. This is a stand-in, not a ruling.
 */
const SIZE = { w: 16, h: 16 } as const;
const PALETTE_ID = "pico-8";

interface Failure {
  code: string;
  message: string;
  endpoint?: string;
}

export function App(): React.JSX.Element {
  const editor = useEditor();
  const round = currentRound(editor);

  const [prompt, setPrompt] = useState("a dog standing");
  const [busy, setBusy] = useState(false);
  const [liveRound, setLiveRound] = useState(0);
  const [turn, setTurn] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    // The unsubscriber is the preload's own, so the listener is removed from
    // `ipcRenderer` rather than merely forgotten here.
    return window.api.onEvent((event: PipelineEvent) => {
      switch (event.type) {
        case "state":
          editorStore.setPipelineState(event.state);
          setLiveRound(event.round);
          setTurn(null);
          break;
        case "round":
          // The only source of a mid-run frame (§7.1).
          setLiveRound(event.snapshot.round);
          editorStore.applyRound(event.snapshot);
          break;
        case "revise-turn":
          setTurn(`turn ${event.turn} of ${event.maxTurns}`);
          break;
      }
    });
  }, []);

  /** Adopt whatever main is holding. The authority after any mutation. */
  const refresh = useCallback(async (): Promise<SessionHistory | null> => {
    const result = await window.api.getSession();
    if (!result.ok) {
      setFailure({ code: result.code, message: result.message, endpoint: result.endpoint });
      return null;
    }
    editorStore.setHistory(result.value);
    return result.value;
  }, []);

  const generate = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    setHistoryError(null);
    setTurn(null);
    // A new run is a new session: the old frames describe a sprite that no longer
    // exists. `setHistory(null)` rather than a full reset, so the colour the user
    // picked survives the run they picked it for.
    editorStore.setHistory(null);
    try {
      const result = await window.api.run({ prompt, size: SIZE, paletteId: PALETTE_ID });
      if (!result.ok) {
        // §9's envelope, whole: `endpoint` is the field `ipcMain.handle` would
        // have destroyed on a rejection.
        setFailure({ code: result.code, message: result.message, endpoint: result.endpoint });
        return;
      }
      // §8: state, stop reason and error are read off the history so they survive
      // a reload, not off the transient event stream.
      editorStore.setHistory(result.value);
      editorStore.setPipelineState(result.value.finalState);
      setHistoryError(result.value.error);
    } finally {
      setBusy(false);
    }
  }, [prompt]);

  const paint = useCallback(
    async (x: number, y: number, ch: string) => {
      // Read through the store rather than through the closure: `paint` is handed
      // to `Canvas` once, and the selected round changes underneath it every time
      // the filmstrip is clicked.
      const roundIndex = editorStore.getSnapshot().selectedRound;
      setFailure(null);

      const result = await window.api.setPixel(roundIndex, x, y, ch);
      if (!result.ok) {
        setFailure({ code: result.code, message: result.message, endpoint: result.endpoint });
        return;
      }

      const history = await refresh();
      if (history === null) return;
      // Rule 4 of `main/ipc.ts`: editing the last round mutated it, editing an
      // earlier one appended. Matching the document id follows the edit in both
      // cases; guessing the index is right in one of them.
      const index = history.rounds.findIndex((r) => r.doc.id === result.value.doc.id);
      if (index >= 0) editorStore.selectRound(index);
    },
    [refresh],
  );

  const accepted = editor.history === null ? null : editor.history.acceptedRound;

  return (
    <main style={styles.page}>
      <h1 style={styles.title}>Sprite Maker</h1>

      <div style={styles.shell}>
        <div style={styles.bar}>
          <input
            data-testid="prompt"
            style={styles.input}
            value={prompt}
            placeholder="describe a sprite"
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button
            data-testid="generate"
            style={styles.button}
            disabled={busy || prompt.trim().length === 0}
            onClick={() => void generate()}
          >
            {busy ? "Generating…" : "Generate"}
          </button>
        </div>

        <div style={styles.stage}>
          {round === null ? (
            <p data-testid="empty" style={styles.hint}>
              no sprite yet — describe one and press Generate
            </p>
          ) : (
            <>
              <Canvas
                doc={round.doc}
                activeIndex={editor.activeIndex}
                onPaint={(x, y, ch) => void paint(x, y, ch)}
              />
              <PaletteBar
                palette={round.doc.palette}
                activeIndex={editor.activeIndex}
                onSelect={(ch) => editorStore.setActiveIndex(ch)}
              />
            </>
          )}
        </div>

        <Filmstrip
          rounds={editor.rounds}
          selectedRound={editor.selectedRound}
          acceptedRound={accepted}
          onSelect={(index) => editorStore.selectRound(index)}
        />

        <p data-testid="state" style={styles.state}>
          {editor.pipelineState}
          {liveRound > 0 ? ` · round ${liveRound}` : ""}
          {turn === null ? "" : ` · ${turn}`}
          {editor.stopReason === null ? "" : ` · ${editor.stopReason}`}
          {accepted === null ? "" : ` · accepted round ${accepted}`}
          {` · ${SIZE.w}×${SIZE.h} · ${PALETTE_ID}`}
        </p>
      </div>

      {failure === null ? null : (
        <p data-testid="error" style={styles.error}>
          {failure.code}: {failure.message}
          {failure.endpoint === undefined ? "" : ` — ${failure.endpoint}`}
        </p>
      )}

      {historyError === null ? null : (
        <p data-testid="history-error" style={styles.error}>
          {historyError}
        </p>
      )}
    </main>
  );
}

const LINE = "1px solid rgba(128,128,128,.38)";

/**
 * The whole editor is one viewport-height flex column, and the **stage** is the
 * only thing that flexes.
 *
 * A fixed `minHeight` on the stage was the first thing tried and it pushed the
 * status bar off the bottom of a 1280×840 window — §8 requires that bar to name
 * the state and the stop reason, and a bar below the fold names them to nobody.
 * Sizing from the viewport down rather than from the content up means the prompt
 * bar, the filmstrip and the status bar are always on screen and the canvas takes
 * whatever is left, which is also §8's "canvas dominates" in the only form that
 * survives a resize.
 */
const styles: Record<string, CSSProperties> = {
  page: {
    margin: 0,
    height: "100vh",
    boxSizing: "border-box",
    padding: "16px 20px",
    display: "flex",
    flexDirection: "column",
    background: "#14161c",
    color: "#e6e8ef",
    font: '13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  title: { flex: "none", margin: "0 0 10px", fontSize: 16, fontWeight: 600, letterSpacing: 0.2 },
  shell: {
    flex: 1,
    // Without this a flex child refuses to shrink below its content, which is how
    // the status bar ended up under the bottom edge in the first place.
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    border: LINE,
    borderRadius: 8,
    overflow: "hidden",
  },
  bar: {
    flex: "none",
    display: "flex",
    gap: 7,
    alignItems: "center",
    padding: 8,
    background: "rgba(128,128,128,.10)",
    borderBottom: LINE,
    flexWrap: "wrap",
  },
  input: {
    flex: 1,
    minWidth: 190,
    padding: "6px 9px",
    borderRadius: 4,
    border: LINE,
    background: "rgba(128,128,128,.05)",
    color: "inherit",
    font: "inherit",
  },
  button: {
    padding: "6px 14px",
    borderRadius: 4,
    border: "1px solid rgba(100,160,240,.6)",
    background: "rgba(100,160,240,.28)",
    color: "inherit",
    font: "inherit",
    fontWeight: 700,
    cursor: "pointer",
  },
  /** The canvas dominates (§8): the stage is the one row that grows. */
  stage: {
    flex: 1,
    minHeight: 0,
    // A 64×64 canvas is 512px plus the palette bar; on a short window that is
    // taller than the row, and scrolling it beats clipping it.
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: 16,
  },
  hint: { margin: 0, opacity: 0.55 },
  state: {
    flex: "none",
    margin: 0,
    padding: "7px 10px",
    borderTop: LINE,
    background: "rgba(128,128,128,.05)",
    color: "#9aa3b8",
    fontSize: 11,
    fontVariantNumeric: "tabular-nums",
  },
  error: { flex: "none", margin: "10px 0 0", color: "#ff7a90" },
};
