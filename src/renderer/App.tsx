/**
 * The Wave 10 shell — a prompt, a Generate button, the rows, and the state.
 *
 * **Deliberately not the editor.** Wave 11 builds the canvas and the palette bar,
 * Wave 12 the full layout from the ratified prototype. This file exists to prove
 * the wiring: that the renderer reaches the pipeline through `window.api`, that
 * a real generation comes back, and that `onEvent` delivers live state during
 * the minutes a run takes. A canvas built here would be thrown away twice.
 *
 * Two things it does that are not scaffolding:
 *
 * - **Rows render from the `round` event, not only from `run`'s result.** `run`
 *   resolves at the gate, which §12 measures in minutes; the `round` event
 *   carries the whole snapshot precisely so a mid-run surface has a source
 *   (§7.1). Waiting for the promise would leave the window empty for the entire
 *   draft-and-critique cycle and make a screenshot of a real generation
 *   impossible to take.
 * - **A failure envelope is rendered as `code`, `message` and `endpoint`.** §8
 *   requires the status bar to name the exact endpoint when Ollama is
 *   unreachable, and §9 is why the envelope keeps a field a rejection would have
 *   destroyed.
 *
 * The renderer holds no pipeline logic (§5.1). Every import from `@shared` is
 * type-only, and there is no import from `@main` at all — a value import of
 * `main/pipeline` would pull `node:http` into this bundle.
 */

import { useCallback, useEffect, useState, type CSSProperties } from "react";

import type { PipelineEvent, PipelineState, SessionHistory } from "@shared/schema";

import type { Api } from "../preload/index";

declare global {
  interface Window {
    /** Exposed by `src/preload/index.ts` through `contextBridge`. */
    api: Api;
  }
}

/**
 * Wave 10 has no size or palette picker — Wave 12 builds both, and §8's layout
 * sketch shows `[32▾] [pico-8▾]` as the defaults these stand in for.
 *
 * 16×16 rather than §8's 32, on measured evidence: at 32×32 `qwen3:8b` returns a
 * fully transparent grid most of the time (5 of 6 sampled drafts), while at
 * 16×16 it paints roughly three times in five. Wave 10's evidence requirement is
 * a screenshot of real generated pixels, and the smaller canvas is the one this
 * generator can actually fill. **This is a stand-in, not a ruling** — Wave 12's
 * picker restores the user's choice, and the underlying draft-quality problem
 * belongs to Wave 6's prompt, not here.
 *
 * The trade-off is stated rather than hidden: §6.8 quotes `callTimeoutMs`
 * against a 32×32 canvas and **scales it by area**, so 16×16 divides every
 * per-call budget by four — 30s, which a `qwen3:8b` revise turn exceeds, so the
 * revise stage times out and the run ends `FAILED` after round 1. The draft,
 * lint, critique, round snapshot and event stream all complete first. That the
 * smallest canvas carries the *tightest* deadline rather than the fastest run is
 * a property of §6.8 worth resolving before the bench is read.
 */
const SIZE = { w: 16, h: 16 } as const;
const PALETTE_ID = "pico-8";

interface Failure {
  code: string;
  message: string;
  endpoint?: string;
}

export function App(): React.JSX.Element {
  const [prompt, setPrompt] = useState("a sitting red fox");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<PipelineState>("IDLE");
  const [round, setRound] = useState(0);
  const [turn, setTurn] = useState<string | null>(null);
  const [rows, setRows] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    // The unsubscriber is the preload's own, so the listener is removed from
    // `ipcRenderer` rather than merely forgotten here.
    return window.api.onEvent((event: PipelineEvent) => {
      switch (event.type) {
        case "state":
          setState(event.state);
          setRound(event.round);
          setTurn(null);
          break;
        case "round":
          setRound(event.snapshot.round);
          setRows(event.snapshot.doc.rows);
          break;
        case "revise-turn":
          setTurn(`turn ${event.turn} of ${event.maxTurns}`);
          break;
      }
    });
  }, []);

  const generate = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    setHistoryError(null);
    try {
      const result = await window.api.run({ prompt, size: SIZE, paletteId: PALETTE_ID });
      if (!result.ok) {
        // §9's envelope, whole: `endpoint` is the field `ipcMain.handle` would
        // have destroyed on a rejection.
        setFailure({ code: result.code, message: result.message, endpoint: result.endpoint });
        return;
      }
      const history: SessionHistory = result.value;
      const last = history.rounds[history.rounds.length - 1];
      if (last !== undefined) setRows(last.doc.rows);
      // §8: state and stop reason are read off the history so they survive a
      // reload, not off the transient event stream.
      setState(history.finalState);
      setHistoryError(history.error);
    } finally {
      setBusy(false);
    }
  }, [prompt]);

  return (
    <main style={styles.page}>
      <h1 style={styles.title}>Sprite Maker</h1>

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

      <p data-testid="state" style={styles.state}>
        {state}
        {round > 0 ? ` · round ${round}` : ""}
        {turn === null ? "" : ` · ${turn}`}
        {` · ${SIZE.w}×${SIZE.h} · ${PALETTE_ID}`}
      </p>

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

      <pre data-testid="rows" style={styles.rows}>
        {rows === null ? "no sprite yet" : rows.join("\n")}
      </pre>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    margin: 0,
    minHeight: "100vh",
    padding: "24px 28px",
    background: "#14161c",
    color: "#e6e8ef",
    font: '14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  title: { margin: "0 0 16px", fontSize: 18, fontWeight: 600, letterSpacing: 0.2 },
  bar: { display: "flex", gap: 8, marginBottom: 12 },
  input: {
    flex: 1,
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid #2c3140",
    background: "#0f1117",
    color: "inherit",
    font: "inherit",
  },
  button: {
    padding: "8px 16px",
    borderRadius: 6,
    border: "1px solid #3a4152",
    background: "#2b323f",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
  },
  state: { margin: "0 0 8px", color: "#9aa3b8", fontVariantNumeric: "tabular-nums" },
  error: { margin: "0 0 8px", color: "#ff7a90" },
  rows: {
    margin: 0,
    padding: 12,
    borderRadius: 6,
    background: "#0f1117",
    border: "1px solid #2c3140",
    color: "#cfd6e6",
    font: '13px/1.15 ui-monospace, SFMono-Regular, Menlo, monospace',
    letterSpacing: "0.32em",
    overflowX: "auto",
  },
};
