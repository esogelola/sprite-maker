/**
 * The round scrubber — spec §8, §9; plan Wave 11 (moved forward from Wave 12).
 *
 * **This is the component the wave exists for.** Headless runs measured the
 * revise stage making sprites worse — symmetry 0.955 → 0.410 in one run, coverage
 * 0.297 → 0.133 in another with the critic scoring its own output 1 of 5, and in
 * one case the best sprite in the session was round 1. §9's entire mitigation for
 * "revise makes the sprite worse" is one line: *any round may be accepted, not
 * only the last — the filmstrip is the mitigation.* A rendered canvas alone shows
 * the final round in colour and cannot answer "was round 1 better?", which is the
 * only question the user actually asked.
 *
 * Two numbering conventions meet here and they are not the same number:
 *
 * - **`selectedRound` is the 0-based array position** the renderer speaks, the
 *   one `Api.setPixel(roundIndex, …)` and `Api.accept(roundIndex)` take, and `0`
 *   is the draft rather than "nothing selected".
 * - **`acceptedRound` is `Round.round`, 1-based** (§6.7 is explicit: it "stores
 *   `Round.round`, which is 1-based — not an array index"), so it is compared
 *   against `round.round` and never against the loop index.
 *
 * Mixing them marks the wrong frame as accepted by exactly one position, which is
 * invisible on a single-round session and wrong on every other.
 *
 * Frames are drawn from `Round.doc.rows` rather than by replaying `diffFromPrev`.
 * §8 describes the filmstrip as replaying those diffs, and the *history* is
 * exactly that replay — `main/ipc.ts` recomputes `diffFromPrev` on every edit so
 * the stored diff and the stored rows agree. Re-deriving the pixels here would be
 * a second implementation of a thing main already guarantees, and it would show
 * the user something main does not hold.
 */

import type { CSSProperties } from "react";

import type { Round } from "@shared/schema";

import { cellFill } from "./Canvas";

export interface FilmstripProps {
  rounds: readonly Round[];
  /** 0-based array position of the frame on screen. */
  selectedRound: number;
  /** `SessionHistory.acceptedRound` — 1-based `Round.round`, or `null`. */
  acceptedRound: number | null;
  onSelect(index: number): void;
}

/** Thumbnail edge, in CSS pixels — the design lock's frame size. */
const FRAME_PX = 52;

/**
 * How many source cells one thumbnail cell covers.
 *
 * A 64×64 frame drawn cell-for-cell is 4096 nodes *per frame*; at three frames
 * that is more DOM than the canvas itself, to fill 52 pixels. Sampling every
 * `step`th cell caps a thumbnail at roughly 22×22 and keeps the silhouette, which
 * is the only thing legible at this size.
 */
function sampleStep(w: number): number {
  return Math.max(1, Math.ceil(w / 26));
}

export function Filmstrip({
  rounds,
  selectedRound,
  acceptedRound,
  onSelect,
}: FilmstripProps): React.JSX.Element {
  if (rounds.length === 0) {
    return (
      <div style={styles.strip}>
        <span data-testid="filmstrip-empty" style={styles.hint}>
          rounds appear here as they are generated
        </span>
      </div>
    );
  }

  return (
    <div data-testid="filmstrip" style={styles.strip} role="tablist" aria-label="rounds">
      {rounds.map((round, index) => {
        // `index`, 0-based, against the selection the renderer speaks…
        const selected = index === selectedRound;
        // …and `round.round`, 1-based, against what §6.7 persisted. Never mixed.
        const accepted = acceptedRound !== null && acceptedRound === round.round;
        return (
          <button
            key={round.doc.id}
            type="button"
            role="tab"
            data-testid="frame"
            data-round={round.round}
            data-round-index={index}
            data-accepted={accepted ? "true" : "false"}
            aria-current={selected}
            aria-selected={selected}
            aria-label={`round ${round.round}${accepted ? ", accepted" : ""}`}
            title={`round ${round.round}${accepted ? " — accepted" : ""}`}
            onClick={() => onSelect(index)}
            style={{
              ...styles.frame,
              ...(selected ? styles.selected : null),
              ...(accepted ? styles.accepted : null),
            }}
          >
            <Thumbnail round={round} />
            <span style={styles.label}>{round.round}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The sprite at 52 pixels.
 *
 * Empty cells paint nothing, exactly as on the canvas — `cellFill` is imported
 * from `Canvas.tsx` rather than reimplemented so §4.5's rule holds at both
 * scales. The frame's own background is what shows through.
 */
function Thumbnail({ round }: { round: Round }): React.JSX.Element {
  const { w, h } = round.doc.size;
  const step = sampleStep(w);
  const columns = Math.ceil(w / step);

  const cells: React.JSX.Element[] = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const fill = cellFill(round.doc.palette, round.doc.rows[y][x]);
      cells.push(
        <i
          key={`${x},${y}`}
          style={fill === undefined ? undefined : { backgroundColor: fill }}
        />,
      );
    }
  }

  return (
    <span
      aria-hidden="true"
      style={{
        ...styles.thumb,
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gridAutoRows: `${FRAME_PX / columns}px`,
      }}
    >
      {cells}
    </span>
  );
}

const styles: Record<string, CSSProperties> = {
  strip: {
    display: "flex",
    gap: 7,
    alignItems: "center",
    flexWrap: "wrap",
    padding: 8,
    borderTop: "1px solid rgba(128,128,128,.38)",
    background: "rgba(128,128,128,.10)",
    minHeight: 68,
  },
  hint: { fontSize: 11, opacity: 0.55 },
  frame: {
    position: "relative",
    width: FRAME_PX,
    height: FRAME_PX,
    padding: 0,
    border: "1px solid rgba(128,128,128,.38)",
    borderRadius: 4,
    background: "#161922",
    cursor: "pointer",
    display: "block",
    overflow: "hidden",
  },
  selected: { outline: "2px solid rgba(100,160,240,1)", outlineOffset: 1 },
  /** A green rim, distinct from the blue selection: a round can be both. */
  accepted: { borderColor: "rgba(110,190,130,1)", boxShadow: "0 0 0 2px rgba(110,190,130,.45)" },
  thumb: { display: "grid", width: "100%", height: "100%", lineHeight: 0 },
  label: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    textAlign: "center",
    fontSize: 9,
    lineHeight: "11px",
    background: "rgba(0,0,0,.6)",
    color: "#fff",
  },
};
