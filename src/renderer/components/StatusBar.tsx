/**
 * The status line — spec §7.2, §8, §9; plan Wave 12.
 *
 * §8: *"Status bar names the current state and the stop reason that fired, both
 * read from `SessionHistory` so they survive a reload."* That sentence is the
 * whole design of this file, and §6.7 records why the fields exist at all:
 * `stopReason` "existed only on a transient event, so the status bar lost it on
 * reload, the bench could not fill its own CSV column, and there was no
 * representable value for a failed run at all."
 *
 * So this component takes the **history**, not a bag of strings assembled from
 * the event stream. `stopReason`, `error`, `acceptedRound` and the round count
 * are all read off the artifact; the live `state`, `liveRound` and `turn` come
 * from the store, which adopts `finalState` from the same artifact the moment
 * one exists (`state/store.ts`, decision 6). A renderer reload with a session
 * main is still holding therefore comes back saying the same thing it said
 * before, having received no events at all.
 *
 * **Every stop reason is named, and the mapping is exhaustive by type.** A14's
 * `revise-regressed` is the newest, and a `default:` branch is exactly how a new
 * reason ends up displayed as a raw enum — or worse, as another reason's words.
 * `assertNever` below makes a sixth reason a compile error instead.
 *
 * **A refusal is rendered, never swallowed.** Wave 10b single-flighted the
 * session: a second mutation while one is in flight answers
 * `{ok: false, code: "busy"}`, and with no cancellation that window is *minutes*
 * (§12). §8's founding defect — "hand-editing then exporting produced a PNG
 * without the edits **and without an error**" — is an action that did not happen
 * being reported as though it had. A swallowed `busy` is the same defect through
 * a different door, so the envelope's `code` is on the DOM as well as in the
 * text, and `endpoint` (the field `ipcMain.handle` would have destroyed) is
 * printed whenever the failure carries one.
 */

import type { CSSProperties } from "react";

import type { PipelineState, SessionHistory, StopReason } from "@shared/schema";

/** §9's envelope, minus the payload — what `Result` carries when `ok` is false. */
export interface StatusFailure {
  code: string;
  message: string;
  endpoint?: string;
}

export interface StatusBarProps {
  /** The live state. Adopted from `SessionHistory.finalState` once one exists. */
  state: PipelineState;
  /** The artifact. Everything durable is read from here (§8). */
  history: SessionHistory | null;
  /** The round the event stream is on — `0` before round 1 exists (§7.1). */
  liveRound: number;
  /** `REVISING` per-turn progress, or `null`. The longest stage (§7.1). */
  turn: string | null;
  /** The most recent failure envelope, or `null`. */
  failure: StatusFailure | null;
  /** What the next run will draw — size and palette. Display only. */
  trailing?: string;
}

/**
 * Spec §7.2's five reasons, in words a user can act on.
 *
 * The enum value is kept beside the sentence rather than replaced by it: it is
 * what `SessionHistory.stopReason` holds, what the bench's CSV column contains,
 * and what a bug report should quote.
 */
function explain(reason: StopReason): string {
  switch (reason) {
    case "no-high-severity":
      return "converged — the critic found no high-severity issues left after filtering";
    case "round-cap":
      return "ran out of rounds — the critique limit was reached with issues still open";
    case "empty-diff":
      return "the revise pass ran and changed no pixels, so the loop stopped rather than repeat it";
    case "revise-regressed":
      return "a revision was discarded because it made the sprite measurably worse — the round before it was kept, and the loop stopped rather than try again";
    case "critic-failed":
      return "the critic could not be read twice — this sprite was never actually reviewed";
    default:
      return assertNever(reason);
  }
}

/** A sixth stop reason is a compile error here, not a silent default branch. */
function assertNever(value: never): never {
  throw new Error(`unhandled stop reason: ${String(value)}`);
}

/** Idle, working, or settled — the design lock's three dots. */
function dotStyle(state: PipelineState): CSSProperties {
  if (state === "IDLE") return styles.dotIdle;
  if (state === "DONE" || state === "AWAITING_USER") return styles.dotDone;
  if (state === "FAILED") return styles.dotFailed;
  return styles.dotRunning;
}

export function StatusBar({
  state,
  history,
  liveRound,
  turn,
  failure,
  trailing,
}: StatusBarProps): React.JSX.Element {
  const settled = state === "IDLE" || state === "AWAITING_USER" || state === "DONE" || state === "FAILED";
  const stopReason = history === null ? null : history.stopReason;
  const accepted = history === null ? null : history.acceptedRound;
  const rounds = history === null ? 0 : history.rounds.length;

  return (
    // `data-testid="state"` sits on the whole bar rather than on the first line:
    // §8 asks for the state *and* the stop reason, and a test that reads one
    // element should see both rather than have to know they were split in two.
    <div data-testid="state" data-state={state} style={styles.wrap}>
      <p style={styles.status}>
        <span style={{ ...styles.dot, ...dotStyle(state) }} aria-hidden="true" />
        <span>{state}</span>
        {/*
         * The round the pipeline is working on, and only while it is working.
         * `liveRound` is 0 before round 1 exists — §7.1 says the event field is
         * deliberately non-negative, so this is a range check, not truthiness.
         * Once the run has settled it is retired: the round *count* below says
         * how many there were, and leaving "round 3" beside "accepted round 1"
         * invites reading it as the round on screen, which it is not.
         */}
        {liveRound > 0 && !settled ? <span>· round {liveRound}</span> : null}
        {turn === null ? null : <span>· {turn}</span>}
        {rounds > 0 ? (
          <span>
            · {rounds} round{rounds === 1 ? "" : "s"}
          </span>
        ) : null}
        {/* `acceptedRound` is 1-based `Round.round` (§6.7) and is printed as
            given — never converted, never compared against an array index. */}
        {accepted === null ? null : (
          <span data-testid="status-accepted" style={styles.kept}>
            · accepted round {accepted}
          </span>
        )}
        {trailing === undefined ? null : <span style={styles.trailing}>· {trailing}</span>}
      </p>

      {stopReason === null ? null : (
        <p data-testid="stop-reason" data-reason={stopReason} style={styles.reason}>
          <b>{stopReason}</b> — {explain(stopReason)}
        </p>
      )}

      {failure === null ? null : (
        <p data-testid="error" data-code={failure.code} style={styles.error}>
          {failure.code === "busy" ? "still working — " : ""}
          {failure.code}: {failure.message}
          {failure.endpoint === undefined ? "" : ` — ${failure.endpoint}`}
        </p>
      )}

      {/* §6.7: `error` is why a *run* failed, and after a reload it is the only
          source for §8's requirement that the status bar name the endpoint. */}
      {history === null || history.error === null ? null : (
        <p data-testid="history-error" style={styles.error}>
          {history.error}
        </p>
      )}
    </div>
  );
}

const LINE = "1px solid rgba(128,128,128,.38)";

const styles: Record<string, CSSProperties> = {
  wrap: {
    flex: "none",
    borderTop: LINE,
    background: "rgba(128,128,128,.05)",
    padding: "6px 9px",
  },
  status: {
    margin: 0,
    display: "flex",
    gap: 9,
    alignItems: "center",
    flexWrap: "wrap",
    fontSize: 11,
    color: "#9aa3b8",
    fontVariantNumeric: "tabular-nums",
  },
  reason: { margin: "3px 0 0", fontSize: 10, color: "#8b93a7", lineHeight: 1.4 },
  error: { margin: "3px 0 0", fontSize: 11, color: "#ff7a90" },
  kept: { color: "rgba(110,190,130,1)" },
  trailing: { opacity: 0.7 },
  dot: { width: 7, height: 7, borderRadius: "50%", flex: "none", display: "block" },
  dotIdle: { background: "rgba(128,128,128,.6)" },
  dotRunning: { background: "rgba(240,180,60,1)" },
  dotDone: { background: "rgba(120,190,140,1)" },
  dotFailed: { background: "rgba(240,90,110,1)" },
};
