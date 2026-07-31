/**
 * The editor — spec §5.1, §8; plan Waves 11 and 12.
 *
 * Wave 11 made the sprite visible. **Wave 12 makes it keepable.** Until this
 * revision the app could show a user that round 1 was the best sprite in the
 * session — which this project has measured to be the common case
 * (`captures/2026-07-30-wave-11-rounds.txt`: symmetry 0.913 → 0.493 → 0.441) —
 * and offered them no button to keep it. §9's whole mitigation for "revise makes
 * the sprite worse" is *any round may be accepted*, and `acceptedRound` was a
 * field no surface could write.
 *
 * This file owns the wiring and nothing else (§5.1). Every component below is
 * presentational; every mutation is an IPC round trip whose answer is re-read
 * rather than assumed.
 *
 * What is load-bearing here:
 *
 * - **Every round-indexed call reads `selectedRound` out of the store at call
 *   time**, never from a closure. The handlers are created once and the
 *   selection changes underneath them on every filmstrip click, so a captured
 *   index is a stale index — and the one this app would capture is the last
 *   round, which is exactly the round the filmstrip exists to let the user
 *   reject.
 * - **A failure envelope is rendered, including `busy`.** `main/ipc.ts` rule 5
 *   single-flights session mutations, and §12 puts a run at minutes — so the
 *   refusal window is long and the refusal is real. `setPending` greys the
 *   controls as a courtesy; the authority is main's answer, and `StatusBar`
 *   prints it.
 * - **`getSession()` on mount.** The renderer can be reloaded while main still
 *   holds a session; §8 requires the state and the stop reason to survive that,
 *   and the store adopts both from the history it is handed.
 * - **The canvas highlight is resolved from the *selected round's* critique.**
 *   `Issue.id` is synthesized from the issue's index (`main/critique.ts`), so the
 *   same id exists in every round; the store clears it on a scrub and the lookup
 *   here is scoped to one round, which are two guards against highlighting a
 *   region the user never clicked.
 *
 * The renderer holds no pipeline logic. Every `@shared` import is type-only or
 * pure data, and there is no import from `@main` at all — a value import of
 * `main/pipeline` would pull `node:http` into this bundle.
 *
 * **Still deliberately absent:** PNG export's implementation (Wave 13 — the
 * handler is registered and answers `not-implemented`, which the gate surfaces
 * verbatim rather than pretending it worked) and the filmstrip's pending-round
 * placeholders, which need `getConfig().maxRounds` and a change to
 * `Filmstrip.tsx` that this wave's whitelist does not open.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import type { PipelineEvent, SessionHistory, Size } from "@shared/schema";
import type { Palette } from "@shared/palettes";

import { Canvas, type Region } from "./components/Canvas";
import { CritiqueDock } from "./components/CritiqueDock";
import { Filmstrip } from "./components/Filmstrip";
import { GateBar } from "./components/GateBar";
import { ModelPickers } from "./components/ModelPickers";
import { PaletteBar } from "./components/PaletteBar";
import { PromptBar, type CanvasSize } from "./components/PromptBar";
import { ProviderRow } from "./components/ProviderRow";
import { StatusBar, type StatusFailure } from "./components/StatusBar";
import { currentRound, editorStore, useEditor } from "./state/store";

import type { Api, ModelRole, ProviderName, ProviderView, Result } from "../preload/index";

declare global {
  interface Window {
    /** Exposed by `src/preload/index.ts` through `contextBridge`. */
    api: Api;
  }
}

/**
 * The canvas the app opens on.
 *
 * 16×16 rather than §8's 32 for the reason Wave 10 recorded and Wave 6c did not
 * overturn: the smaller canvas is the one a live run completes reliably, and
 * §6.8's `callTimeoutFloorMs` (amendment A12) exists because the area-scaled
 * budget made it the *tightest* deadline. The picker now offers all three.
 */
const DEFAULT_SIZE: CanvasSize = 16;
const DEFAULT_PALETTE = "pico-8";

/** The scale the gate exports at, mirrored from `GateBar` for the IPC call. */
const EXPORT_SCALE = 8;

/**
 * One picked number, as §6.2's discriminated union.
 *
 * `{w: size, h: size}` where `size: 16 | 32 | 64` widens to `{w: 16|32|64, …}`,
 * which is not a member of `SizeSchema`'s union — the type system saying what
 * the schema also says: the two fields are not independently chosen. Spelled out
 * rather than cast, so a fourth canvas size would be a compile error here.
 */
function canvas(n: CanvasSize): Size {
  if (n === 16) return { w: 16, h: 16 };
  if (n === 32) return { w: 32, h: 32 };
  return { w: 64, h: 64 };
}

export function App(): React.JSX.Element {
  const editor = useEditor();
  const round = currentRound(editor);

  const [prompt, setPrompt] = useState("a dog standing");
  const [size, setSize] = useState<CanvasSize>(DEFAULT_SIZE);
  const [paletteId, setPaletteId] = useState(DEFAULT_PALETTE);
  const [palettes, setPalettes] = useState<readonly Palette[]>([]);
  const [installed, setInstalled] = useState<readonly string[]>([]);
  const [bound, setBound] = useState<{ generator: string; critic: string } | null>(null);
  /** Which server the app resolved, or `null` before `getProvider` answers (A16). */
  const [provider, setProvider] = useState<ProviderView | null>(null);
  /** The mutation main is holding the session for, or `null`. */
  const [pending, setPending] = useState<string | null>(null);
  const [liveRound, setLiveRound] = useState(0);
  const [turn, setTurn] = useState<string | null>(null);
  const [failure, setFailure] = useState<StatusFailure | null>(null);
  /** The model list's own failure — one of `blocked`'s three causes below. */
  const [modelsError, setModelsError] = useState<string | null>(null);

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

  /**
   * The model list and the current bindings — §9's explicit retry runs this.
   *
   * `listModels` is the call that reaches Ollama, so it is also the app's
   * readiness check: its failure is what disables Generate and puts the exact
   * endpoint in the status bar.
   */
  const loadModels = useCallback(async () => {
    setBound(await window.api.getModels());
    const list = await window.api.listModels();
    if (!list.ok) {
      setInstalled([]);
      setModelsError(
        list.endpoint === undefined
          ? `${list.code}: ${list.message}`
          : `${list.code}: ${list.message} — ${list.endpoint}`,
      );
      setFailure({ code: list.code, message: list.message, endpoint: list.endpoint });
      return;
    }
    setInstalled(list.value);
    setModelsError(null);
  }, []);

  /**
   * Which server the app is on, and whether it is answering — A16.
   *
   * Re-read rather than remembered, and read from main rather than derived here:
   * `connected` is a claim about a socket and `unavailable` is a comparison
   * against the *server's* model list, and §5.1 leaves both to main.
   */
  const refreshProvider = useCallback(async () => {
    const result = await window.api.getProvider();
    if (!result.ok) {
      setFailure({ code: result.code, message: result.message, endpoint: result.endpoint });
      return;
    }
    setProvider(result.value);
  }, []);

  /** §9's explicit retry, widened by A16 to re-ask whether the server is there. */
  const reconnect = useCallback(async () => {
    await refreshProvider();
    await loadModels();
  }, [refreshProvider, loadModels]);

  useEffect(() => {
    // A reload finds main still holding the session, and §8 requires the state
    // and stop reason to survive that. Nothing here starts a run.
    void refresh();
    void reconnect();
    void window.api.getPalettes().then(setPalettes);
  }, [refresh, reconnect]);

  /**
   * Why Generate is unavailable — §8's "no silent fallback", with A16's causes.
   *
   * Three of them, and they are ordered by how early they stop a run. A model
   * list that could not be fetched is the oldest (§9's unreachable-Ollama row); a
   * provider that is not answering is the same failure named at the server
   * rather than at the call; and a binding the current server does not have is
   * the one A16 adds — the failure that would otherwise land on the *first model
   * call of a run*, as a 404 attributed to the pipeline.
   *
   * Derived rather than stored, so it cannot go stale behind a switch: every
   * input is re-read after every mutation that could change it.
   */
  const blocked = useMemo((): string | null => {
    if (modelsError !== null) return modelsError;
    if (provider === null) return null;
    if (!provider.connected) {
      return provider.error ?? `${provider.baseUrl} is not answering`;
    }
    if (provider.unavailable.length > 0) {
      const bindings = provider.unavailable
        .map((m) => `${m.role} is bound to ${m.model}`)
        .join("; ");
      return `${bindings} — ${provider.provider} does not have it, so pick a model this server has`;
    }
    return null;
  }, [modelsError, provider]);

  /**
   * Run one mutation at a time, rendering whatever main answers.
   *
   * `pending` is a label, not a lock: `main/ipc.ts`'s `exclusive` is the lock,
   * and it answers a second mutation `{ok: false, code: "busy"}`. Both halves
   * matter — the label explains the greyed-out button, and the envelope is the
   * only thing that can tell the user their Accept did not happen.
   */
  const mutate = useCallback(
    async (label: string, call: () => Promise<Result<SessionHistory>>): Promise<void> => {
      setPending(label);
      setFailure(null);
      try {
        const result = await call();
        if (!result.ok) {
          setFailure({ code: result.code, message: result.message, endpoint: result.endpoint });
          if (result.code === "ollama-unreachable") {
            setModelsError(
              `${result.message}${result.endpoint === undefined ? "" : ` — ${result.endpoint}`}`,
            );
          }
          return;
        }
        // §8: state, stop reason and error are read off the history so they
        // survive a reload, not off the transient event stream.
        editorStore.setHistory(result.value);
      } finally {
        setPending(null);
      }
    },
    [],
  );

  const generate = useCallback(async () => {
    setTurn(null);
    setLiveRound(0);
    // A new run is a new session: the old frames describe a sprite that no
    // longer exists. `setHistory(null)` rather than a full reset, so the colour
    // the user picked survives the run they picked it for.
    editorStore.setHistory(null);
    await mutate("run", () => window.api.run({ prompt, size: canvas(size), paletteId }));
  }, [mutate, prompt, size, paletteId]);

  /**
   * Accept the round the filmstrip has selected — §8, §6.7.
   *
   * The index comes from the argument, which `GateBar` reads off the selection
   * it was rendered with. `Api.accept` speaks the 0-based array position and
   * `pipeline.accept` converts it to the 1-based `Round.round` that
   * `acceptedRound` holds; neither number is derived from the other here.
   */
  const accept = useCallback(
    (roundIndex: number) => void mutate("accept", () => window.api.accept(roundIndex)),
    [mutate],
  );

  const sendFeedback = useCallback(
    (feedback: string, roundIndex: number) =>
      void mutate("feedback", () => window.api.applyFeedback(feedback, roundIndex)),
    [mutate],
  );

  /**
   * Wave 13 builds `main/export.ts`; until then the registered handler answers
   * `not-implemented` and that answer is shown. Reporting a save that did not
   * happen is §8's founding defect in its original form.
   */
  const exportPng = useCallback(async (roundIndex: number) => {
    setPending("export");
    setFailure(null);
    try {
      const result = await window.api.exportPng(roundIndex, EXPORT_SCALE);
      if (!result.ok) {
        setFailure({ code: result.code, message: result.message, endpoint: result.endpoint });
      }
    } finally {
      setPending(null);
    }
  }, []);

  const bindModel = useCallback(
    async (role: ModelRole, model: string) => {
      const result = await window.api.bindModel(role, model);
      if (!result.ok) {
        setFailure({ code: result.code, message: result.message, endpoint: result.endpoint });
      }
      // Re-read rather than assume: `bindModel` writes through to the live
      // config, and the picker should show what the next run will actually call.
      setBound(await window.api.getModels());
      // A16: the binding the row was warning about may be the one just fixed, and
      // `unavailable` is main's answer rather than something to recompute here.
      await refreshProvider();
    },
    [refreshProvider],
  );

  /**
   * Point the app at a provider and base URL — A16.
   *
   * An empty `baseUrl` is `ProviderRow` saying "that provider's own default",
   * which main resolves; the renderer does not know a port number.
   *
   * **A refusal is rendered.** `setProvider` is a session mutation, so
   * `main/ipc.ts` rule 5 answers `{ok: false, code: "busy"}` while a run holds
   * the session — and §12 puts that window at minutes. Showing the new provider
   * anyway would be §8's founding defect through a different door: an action
   * that did not happen, reported as though it had.
   */
  const chooseProvider = useCallback(
    async (name: ProviderName, baseUrl: string) => {
      setPending("provider");
      setFailure(null);
      try {
        const result = await window.api.setProvider(name, baseUrl);
        if (!result.ok) {
          setFailure({ code: result.code, message: result.message, endpoint: result.endpoint });
          return;
        }
        setProvider(result.value);
        // §9: "pickers list only installed models" — and installed is a property
        // of the server, so the list must be re-read rather than kept.
        await loadModels();
      } finally {
        setPending(null);
      }
    },
    [loadModels],
  );

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

  /**
   * The active issue's region, resolved inside the selected round.
   *
   * `null` when the id names nothing here, which is what happens the instant the
   * user scrubs — belt and braces with the store's own clear, because an id that
   * exists in two rounds and means two different things is the shape of defect
   * that survives one guard.
   */
  const highlight: Region | null = useMemo(() => {
    if (round === null || editor.activeIssueId === null) return null;
    const issue = round.critique?.issues.find((i) => i.id === editor.activeIssueId);
    return issue === undefined ? null : issue.region;
  }, [round, editor.activeIssueId]);

  const accepted = editor.history === null ? null : editor.history.acceptedRound;

  return (
    <main style={styles.page}>
      {/*
       * No in-page title. The design lock is a single bordered frame that starts
       * at the prompt bar, `main/index.ts` already gives the window its name, and
       * a 36px heading inside the frame is 36px the stage does not get — enough,
       * measured, to push the palette bar below the fold once the gate appears.
       */}
      <div style={styles.shell}>
        <PromptBar
          prompt={prompt}
          onPromptChange={setPrompt}
          size={size}
          onSizeChange={setSize}
          paletteId={paletteId}
          onPaletteChange={setPaletteId}
          palettes={palettes}
          pending={pending}
          blocked={blocked}
          onGenerate={() => void generate()}
        >
          <ProviderRow
            view={provider}
            disabled={pending !== null}
            onSelect={(name, baseUrl) => void chooseProvider(name, baseUrl)}
          />
          <ModelPickers
            installed={installed}
            bound={bound}
            disabled={pending !== null}
            onBind={(role, model) => void bindModel(role, model)}
          />
          {blocked === null ? null : (
            // §9: "explicit retry". A disabled Generate with no way back would
            // make a transient server restart terminal for the session — and
            // after A16 the retry re-asks whether the server is there at all,
            // not only what it has installed.
            <button
              type="button"
              data-testid="retry"
              style={styles.retry}
              onClick={() => void reconnect()}
            >
              Retry
            </button>
          )}
        </PromptBar>

        <div style={styles.main}>
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
                  highlight={highlight}
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

          <CritiqueDock
            round={round}
            activeIssueId={editor.activeIssueId}
            // Clicking the active issue again clears it — the prototype's
            // behaviour, and the only way to get the canvas back unmarked.
            onSelectIssue={(id) =>
              editorStore.selectIssue(editor.activeIssueId === id ? null : id)
            }
          />
        </div>

        <Filmstrip
          rounds={editor.rounds}
          selectedRound={editor.selectedRound}
          acceptedRound={accepted}
          onSelect={(index) => editorStore.selectRound(index)}
        />

        <GateBar
          state={editor.pipelineState}
          selectedRound={editor.selectedRound}
          roundNumber={round === null ? null : round.round}
          acceptedRound={accepted}
          pending={pending}
          onAccept={accept}
          onFeedback={sendFeedback}
          onExport={(index) => void exportPng(index)}
        />

        <StatusBar
          state={editor.pipelineState}
          history={editor.history}
          liveRound={liveRound}
          turn={turn}
          failure={failure}
          trailing={`${size}×${size} · ${paletteId}`}
        />
      </div>
    </main>
  );
}

const LINE = "1px solid rgba(128,128,128,.38)";

/**
 * The whole editor is one viewport-height flex column, and the **main row** is
 * the only thing that flexes.
 *
 * A fixed `minHeight` on the stage was the first thing tried and it pushed the
 * status bar off the bottom of a 1280×840 window — §8 requires that bar to name
 * the state and the stop reason, and a bar below the fold names them to nobody.
 * Sizing from the viewport down rather than from the content up means the prompt
 * bar, the filmstrip, the gate and the status bar are always on screen and the
 * canvas takes whatever is left, which is also §8's "canvas dominates" in the
 * only form that survives a resize.
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
  /** Canvas beside dock — the design lock's `.main` row. */
  main: { flex: 1, minHeight: 0, display: "flex", alignItems: "stretch" },
  /** The canvas dominates (§8): the stage is the one column that grows. */
  stage: {
    flex: 1,
    minWidth: 0,
    // A 64×64 canvas is 512px plus the palette bar; on a short window that is
    // taller than the row, and scrolling it beats clipping it.
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 12,
  },
  hint: { margin: 0, opacity: 0.55 },
  retry: {
    padding: "6px 10px",
    borderRadius: 4,
    border: "1px solid rgba(240,180,60,.6)",
    background: "rgba(240,180,60,.18)",
    color: "inherit",
    font: "inherit",
    fontSize: 12,
    cursor: "pointer",
  },
};
