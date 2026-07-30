/**
 * The gate — spec §7.3, §8, §9; plan Wave 12.
 *
 * **This is the component the wave exists for.** Before it, the app could show
 * the user which round was best and gave them no way to keep it: §9's entire
 * mitigation for "revise makes the sprite worse" is *any round may be accepted,
 * not only the last*, and `acceptedRound` was a field no surface could write.
 *
 * Three rules govern it.
 *
 * **1. Every action addresses the round the filmstrip has selected**, and the
 * index it sends is the renderer's **0-based array position** (§6.7, and
 * `main/ipc.ts` rule 3). `selectedRound: 0` is the draft — measured to be the
 * best sprite in this project's own run (`captures/2026-07-30-wave-11-rounds.txt`)
 * and therefore the most common accept target. It is passed through as a number
 * and never tested for truthiness; a gate that accepts `rounds.length - 1`
 * instead compiles, passes a single-round test, and silently discards the choice
 * the filmstrip exists to offer. The 1-based `Round.round` appears in the label
 * and nowhere else.
 *
 * **2. The gate survives the accept it just recorded.** `accept` moves
 * `finalState` to `DONE`, and the ratified prototype hides the gate there — but
 * Wave 14's script runs Accept (feature 10) *before* hand editing (11) and PNG
 * export (12), and a gate that vanishes leaves the user no way to export the
 * sprite they just kept. So `DONE` keeps the bar, says which round is held, and
 * still offers Accept (to move it) and Export.
 *
 * **3. A mutation in flight disables the buttons, and that is a courtesy, not a
 * guarantee.** The authority is `main/ipc.ts`'s `exclusive`, which answers a
 * second mutation with `{ok: false, code: "busy"}` — rule 5 of that file says in
 * as many words that the renderer's own flag cannot fix the race. `StatusBar`
 * renders the refusal when it comes.
 */

import { useState, type CSSProperties } from "react";

import type { PipelineState } from "@shared/schema";

/** The scale §13 will export at. Fixed here; the picker is Wave 13's. */
const EXPORT_SCALE = 8;

export interface GateBarProps {
  state: PipelineState;
  /** 0-based array position — what `Api.accept` / `applyFeedback` / `exportPng` take. */
  selectedRound: number;
  /** `Round.round` of that round, 1-based, for the label only. `null` if empty. */
  roundNumber: number | null;
  /** `SessionHistory.acceptedRound` — 1-based, or `null`. */
  acceptedRound: number | null;
  /** The mutation main is holding the session for, or `null`. */
  pending: string | null;
  onAccept(roundIndex: number): void;
  onFeedback(feedback: string, roundIndex: number): void;
  onExport(roundIndex: number): void;
}

export function GateBar({
  state,
  selectedRound,
  roundNumber,
  acceptedRound,
  pending,
  onAccept,
  onFeedback,
  onExport,
}: GateBarProps): React.JSX.Element | null {
  const [feedback, setFeedback] = useState("");

  // Rule 2: `AWAITING_USER` is the gate §7.1 draws; `DONE` is after Accept.
  if (state !== "AWAITING_USER" && state !== "DONE") return null;
  if (roundNumber === null) return null;

  const busy = pending !== null;

  function send(): void {
    // §7.3 injects this as a synthetic high-severity issue; an empty one would
    // be an issue with no text, and `main/ipc.ts` rejects it as `bad-input`.
    // Refusing here keeps the round-trip out of it.
    const text = feedback.trim();
    if (text.length === 0) return;
    setFeedback("");
    onFeedback(text, selectedRound);
  }

  return (
    <div data-testid="gate" style={styles.gate}>
      <span data-testid="gate-tag" style={styles.tag}>
        {state}
      </span>

      {acceptedRound === null ? (
        <span style={styles.hint}>round {roundNumber} is on screen</span>
      ) : (
        <span data-testid="gate-accepted" style={styles.kept}>
          keeping round {acceptedRound}
          {acceptedRound === roundNumber ? "" : ` · round ${roundNumber} on screen`}
        </span>
      )}

      <input
        data-testid="feedback"
        style={styles.input}
        value={feedback}
        placeholder="e.g. make the tail fluffier"
        disabled={busy}
        onChange={(e) => setFeedback(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") send();
        }}
      />
      <button
        type="button"
        data-testid="send-feedback"
        style={styles.button}
        disabled={busy}
        title="Enters as a synthetic high-severity issue and re-runs the revise stage (§7.3)"
        onClick={send}
      >
        Send feedback
      </button>

      <button
        type="button"
        data-testid="accept"
        style={{ ...styles.button, ...styles.primary }}
        disabled={busy}
        // Rule 1: the *index*, straight through. `0` is a round.
        onClick={() => onAccept(selectedRound)}
      >
        {acceptedRound === roundNumber ? `Keep round ${roundNumber}` : `Accept round ${roundNumber}`}
      </button>

      <button
        type="button"
        data-testid="export"
        style={styles.button}
        disabled={busy}
        onClick={() => onExport(selectedRound)}
      >
        Export PNG {EXPORT_SCALE}×
      </button>

      {busy ? (
        <span data-testid="gate-pending" style={styles.hint}>
          {pending} in flight — main is holding the session
        </span>
      ) : null}
    </div>
  );
}

const LINE = "1px solid rgba(128,128,128,.38)";

const styles: Record<string, CSSProperties> = {
  /** The design lock's purple wash: the gate is the one row that wants an answer. */
  gate: {
    flex: "none",
    display: "flex",
    gap: 7,
    alignItems: "center",
    flexWrap: "wrap",
    padding: 9,
    borderTop: LINE,
    background: "rgba(160,110,235,.09)",
  },
  tag: {
    padding: "2px 6px",
    border: LINE,
    borderRadius: 3,
    fontSize: 10,
    background: "rgba(128,128,128,.05)",
  },
  hint: { fontSize: 10, opacity: 0.62 },
  kept: { fontSize: 10, color: "rgba(110,190,130,1)" },
  input: {
    flex: 1,
    minWidth: 170,
    padding: "5px 8px",
    borderRadius: 4,
    border: LINE,
    background: "rgba(128,128,128,.05)",
    color: "inherit",
    font: "inherit",
    fontSize: 12,
  },
  button: {
    padding: "5px 10px",
    borderRadius: 4,
    border: LINE,
    background: "rgba(128,128,128,.05)",
    color: "inherit",
    font: "inherit",
    fontSize: 12,
    cursor: "pointer",
  },
  primary: {
    background: "rgba(100,160,240,.28)",
    borderColor: "rgba(100,160,240,.6)",
    fontWeight: 700,
  },
};
