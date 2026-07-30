/**
 * Editor state — spec §5.1, §8; plan Wave 11.
 *
 * A module-level store plus `useSyncExternalStore`, which is React 19's own
 * answer to exactly this shape and costs no dependency. The alternative — lifting
 * everything into `App.tsx` and threading it down — makes the filmstrip, the
 * canvas and the palette bar each take a prop for state they do not own, and puts
 * the `onEvent` subscription in the same component as the render tree it feeds.
 *
 * **This store holds no pipeline logic** (§5.1). It never mutates a document, and
 * it does not know what a `setPixel` is: it receives snapshots and histories that
 * main has already produced, and decides only which of them is on screen.
 *
 * Four decisions here are load-bearing.
 *
 * **1. `selectedRound` is the renderer's 0-based array position, and `0` is a
 * value.** It is the draft, and the default selection. `selectRound` therefore
 * tests `Number.isInteger` and a range, never truthiness — the same rule
 * `main/ipc.ts` states about `roundIndex`, on the same number, at the other end
 * of the wire. `acceptedRound` on `SessionHistory` is the *other* convention —
 * 1-based `Round.round` (§6.7) — and the two are never mixed here: this module
 * stores only the index, and `Filmstrip` compares the round number.
 *
 * **2. `activeIndex` is a row character, not a number.** `"0"` is black, the most
 * common outline colour in pixel art, and `"."` is the eraser. The schema makes
 * the same choice for `DrawOp.index` and for the same reason: a numeric `0` is
 * one falsy check away from being read as "no colour chosen".
 *
 * **3. `rounds` is the display list, and it has two sources.** During a run the
 * only source of a mid-run frame is the `round` event (§7.1 says so explicitly —
 * `run()` resolves at the gate, minutes later). After an edit or at the end of a
 * run the authority is `getSession()`, because `setPixel` may have appended a
 * round, cleared the acceptance and recomputed `diffFromPrev`. Both write the
 * same array, so the filmstrip never has to ask which one it is reading.
 *
 * **4. The selection follows the newest round only while it is already at the
 * end.** A run in progress should show what it just made; a user who has scrubbed
 * back to compare round 1 against round 3 — the entire reason Wave 11 exists —
 * must not have the canvas yanked out from under them when round 3 lands.
 *
 * **5. `activeIssueId` belongs to the selected round, and moving the selection
 * clears it** (Wave 12). `main/critique.ts` synthesizes a missing id from the
 * issue's *index* — `issue-0`, `issue-1` — so the same id exists in every round's
 * critique and names a different problem in each. Carried across a scrub it
 * highlights a region the user never clicked, which is worse than no highlight.
 *
 * **6. `pipelineState` and `stopReason` are adopted from the history** (§8), so
 * both survive a reload: `getSession()` answers with whatever main is holding and
 * the surfaces read that, rather than the transient event stream that a reload
 * has already thrown away. Events still drive the state *during* a run, because
 * `run()` does not resolve until the gate (§12) and there is no history to read
 * until it does.
 */

import { useSyncExternalStore } from "react";

import type { PipelineState, Round, SessionHistory, StopReason } from "@shared/schema";

/** What the editor renders from. Immutable — every update replaces the object. */
export interface EditorState {
  /**
   * The last session main handed over, or `null` before the first run.
   *
   * Kept beside `rounds` rather than being the only source of them because a run
   * in progress has rounds on screen before any history is readable, and because
   * `acceptedRound`, `stopReason` and `config` live only here.
   */
  readonly history: SessionHistory | null;
  /** The frames the filmstrip shows, in round order. */
  readonly rounds: readonly Round[];
  /** 0-based position in `rounds`. `0` is the draft, and the default. */
  readonly selectedRound: number;
  /** The row character a canvas click paints — `"."` or `0`-`f` (§6.1). */
  readonly activeIndex: string;
  /**
   * `Issue.id` of the issue whose region the canvas highlights, or `null`.
   *
   * Scoped to the selected round by decision 5 — the id alone does not identify
   * an issue across rounds.
   */
  readonly activeIssueId: string | null;
  readonly pipelineState: PipelineState;
  readonly stopReason: StopReason | null;
}

const INITIAL: EditorState = {
  history: null,
  rounds: [],
  // Not `-1`: the draft is the first thing a run produces and the first thing
  // the user should be looking at, and a sentinel here would need a falsy-safe
  // check at every read site.
  selectedRound: 0,
  activeIndex: "0",
  activeIssueId: null,
  pipelineState: "IDLE",
  stopReason: null,
};

let state: EditorState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<EditorState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/**
 * Clamp a selection into a round list, preserving it wherever possible.
 *
 * An empty list selects 0 rather than `-1`, so the store never holds an index
 * that would have to be special-cased on the way out; `rounds[0]` of an empty
 * array is `undefined`, which the canvas already handles as "nothing yet".
 */
function clamp(selected: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(selected, 0), length - 1);
}

export const editorStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /**
   * The current state.
   *
   * Cached rather than rebuilt: `useSyncExternalStore` calls this on every render
   * and compares by identity, so returning a fresh object would loop forever.
   */
  getSnapshot(): EditorState {
    return state;
  },

  /** Back to first-run. Used by tests and by nothing else. */
  reset(): void {
    state = INITIAL;
    for (const listener of listeners) listener();
  },

  /**
   * Adopt a whole session — the authority after an edit and at the end of a run.
   *
   * `stopReason` **and `pipelineState`** are read off the history rather than off
   * the event stream (§8, decision 6): the transient events are gone after a
   * reload, and the artifact is not. `finalState` is what `accept` moved to
   * `DONE`, what `releaseAcceptance` moved back, and what a `FAILED` run
   * recorded — so adopting it here is the one place the surfaces learn any of
   * that without being told twice.
   *
   * A `null` history is a new run or a first run: back to `IDLE` with no stop
   * reason, rather than leaving a previous run's `DONE` on screen over an empty
   * canvas.
   */
  setHistory(history: SessionHistory | null): void {
    const rounds = history === null ? [] : history.rounds;
    // Decision 4, on the other entry point. A renderer seeing a session for the
    // first time — a reload while main is still holding one — has no selection
    // worth preserving, and the round the finished run left on screen is the
    // last one. Once there *is* a selection it is preserved: `accept` and
    // `setPixel` both re-enter here, and jumping the canvas to round 3 after the
    // user scrubbed to round 1 and accepted it would undo the wave.
    const firstSight = state.rounds.length === 0 && rounds.length > 0;
    const selectedRound = firstSight ? rounds.length - 1 : clamp(state.selectedRound, rounds.length);
    set({
      history,
      rounds,
      selectedRound,
      // Decision 5: an issue id only means something inside one round.
      activeIssueId: selectedRound === state.selectedRound ? state.activeIssueId : null,
      stopReason: history === null ? null : history.stopReason,
      pipelineState: history === null ? "IDLE" : history.finalState,
    });
  },

  /**
   * Take one `round` event's snapshot — the only source of a mid-run frame.
   *
   * Upserted by `Round.round - 1`, so §6.7's two-phase write (a round is
   * snapshotted at the top of the iteration and replaced once revise completes)
   * produces one frame rather than two. An index past the end appends instead of
   * writing a hole: a sparse array would render `undefined` as a frame.
   */
  applyRound(snapshot: Round): void {
    const rounds = state.rounds.slice();
    const index = snapshot.round - 1;
    const at = index >= 0 && index <= rounds.length ? index : rounds.length;
    rounds[at] = snapshot;

    // Decision 4: follow the head, never a scrubbed-back selection.
    const wasAtEnd = state.selectedRound >= state.rounds.length - 1;
    const selectedRound = wasAtEnd ? rounds.length - 1 : state.selectedRound;
    set({
      rounds,
      selectedRound,
      // Decision 5. Following the head is a change of round like any other.
      activeIssueId: selectedRound === state.selectedRound ? state.activeIssueId : null,
    });
  },

  /**
   * Show a round. Decision 1: an integer in range, and `0` is in range.
   *
   * An out-of-range index is ignored rather than clamped — it can only come from
   * a stale click, and silently showing a *different* round than the one clicked
   * is the failure this whole component exists to prevent.
   */
  selectRound(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= state.rounds.length) return;
    // Decision 5: the highlight goes with the round it was clicked in.
    set({ selectedRound: index, activeIssueId: null });
  },

  /** Choose the colour a click paints. `"."` is the eraser. */
  setActiveIndex(ch: string): void {
    set({ activeIndex: ch });
  },

  /**
   * Highlight one issue's region on the canvas, or clear the highlight (§8).
   *
   * Takes the id rather than the `Issue`, so the store still holds no critique
   * data and the dock and the canvas cannot disagree about which issue is
   * active. `null` is the deselection, and it is a first-class argument rather
   * than a second method.
   */
  selectIssue(id: string | null): void {
    set({ activeIssueId: id });
  },

  setPipelineState(pipelineState: PipelineState): void {
    set({ pipelineState });
  },
};

/** Subscribe a component to the whole editor state. */
export function useEditor(): EditorState {
  return useSyncExternalStore(editorStore.subscribe, editorStore.getSnapshot);
}

/**
 * The round on screen, or `null` before a run has produced one.
 *
 * `?? null` rather than the bare lookup: `rounds[0]` of an empty array is
 * `undefined`, and a component testing `round === null` should not also have to
 * test for the other empty value.
 */
export function currentRound(s: EditorState): Round | null {
  return s.rounds[s.selectedRound] ?? null;
}
