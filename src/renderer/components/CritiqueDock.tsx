/**
 * What the critic and the linter said — spec §6.4, §6.5, §8; plan Wave 12.
 *
 * The dock is the only surface in the app that shows *why* a round looks the way
 * it does, and three of the four things it renders have been measured to lie in
 * a specific direction. Rendering them without saying so would be worse than
 * rendering nothing, so the honesty rules are the design:
 *
 * **1. `overall` is anti-correlated with quality, and is labelled an opinion.**
 * Measured in this project's own run (`captures/2026-07-30-wave-11-rounds.txt`):
 * the critic scored the three rounds 1 → 4 → 3 while `symmetryScore` fell
 * monotonically 0.913 → 0.493 → 0.441, and §7.2's A14 note records the guard
 * blocking a round the critic rated 3/5 over one it rated 1/5 — correctly. A
 * five-point score in a big font *is* a quality claim; this one renders as the
 * critic's opinion, beside the deterministic metrics that disagree with it.
 *
 * **2. `revise.summary` is the agent's claim, never a description of what
 * happened.** One round claimed it "reduced head size by clearing top row
 * pixels" while adding 44 cells of coloured bands; another claimed a redraw
 * having changed zero pixels. The prose is quoted and attributed, and
 * `diffFromPrev.length` — the number that cannot be wrong — sits next to it.
 *
 * **3. `critique` is raw and `filteredIssues` is what the reviser received**
 * (§6.7). An issue below `confidenceFloor` was dropped before the agent ever saw
 * it, and an issue above it but below `suggestConfidenceFloor` reached the agent
 * with its `suggest` blanked. Showing the raw list alone would show fix text the
 * agent never got; showing the filtered list alone would hide issues the critic
 * genuinely raised. Both are rendered, and each issue says which side it fell on.
 *
 * **The dock renders whenever a round is selected — ruling R2**, including a
 * converged critique with zero issues, including a degraded one, and including a
 * hand-edited round no critic has seen. v1's spec hid it on an empty issue list,
 * which made a converged run look identical to one that never critiqued; the
 * ratified prototype disagreed and the prototype wins. The lint block in
 * particular renders unconditionally: Wave 3 built a deterministic linter whose
 * output had reached no surface at all before this file.
 *
 * **Twin confidence bars** (§6.4). `confidence` asks *is the problem real*,
 * `suggestConfidence` asks *is my fix correct*, and the valuable cell is high
 * over low. The two bars carry different labels, different widths and different
 * colours, because collapsing them into one number destroys exactly that signal
 * — and a component that renders one value into both bars would too.
 */

import { useMemo, type CSSProperties } from "react";

import type { Issue, LintWarning, Round } from "@shared/schema";

export interface CritiqueDockProps {
  /** The round the filmstrip has selected, or `null` before a run. */
  round: Round | null;
  /** `Issue.id` of the highlighted issue, scoped to this round. */
  activeIssueId: string | null;
  /** Toggling is the caller's decision — it owns the current selection. */
  onSelectIssue(id: string): void;
}

/** Below this, `filterIssues` blanks `suggest` — §6.8's `suggestConfidenceFloor`. */
const SUGGEST_FLOOR = 0.5;

const SEVERITY_COLOR: Record<Issue["severity"], string> = {
  high: "rgba(220,70,70,.9)",
  medium: "rgba(225,170,50,.9)",
  low: "rgba(110,170,225,.9)",
};

/** One decimal place too few and 0.98 / 0.95 read the same; two is enough. */
const pct = (v: number): string => `${Math.round(v * 100)}%`;

export function CritiqueDock({
  round,
  activeIssueId,
  onSelectIssue,
}: CritiqueDockProps): React.JSX.Element | null {
  /**
   * The filtered copy of each issue, by id.
   *
   * `filteredIssues` is what the revise stage actually received, so its presence
   * answers "did this reach the agent" and its `suggest` answers "with the fix,
   * or without it". Built once per round rather than searched per issue.
   */
  const filtered = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of round?.filteredIssues ?? []) map.set(issue.id, issue);
    return map;
  }, [round]);

  if (round === null) return null;

  const critique = round.critique;

  return (
    <aside data-testid="dock" style={styles.dock} aria-label={`critique, round ${round.round}`}>
      <div style={styles.label}>Critique · round {round.round}</div>

      {critique === null ? (
        <p data-testid="no-critique" style={styles.meta}>
          No critique — this round has not been critiqued. It was drafted or hand
          edited, and the lint below is all that has looked at it.
        </p>
      ) : critique.degraded ? (
        <p data-testid="degraded" style={styles.degraded}>
          The critic could not be read — two unparseable replies (§6.4). There is
          no score and no issue list, and this round was <em>not</em> reviewed.
        </p>
      ) : (
        <>
          <p data-testid="reads-as" style={styles.readsAs}>
            “{critique.readsAs ?? "—"}”
          </p>
          {/*
           * Rule 1. `overall === null` is only reachable on a degraded report,
           * which the branch above already caught — but the field is nullable
           * and a rendered "null/5" is exactly the invented score §6.4 forbids.
           */}
          {critique.overall === null ? null : (
            <p data-testid="overall" data-overall={critique.overall} style={styles.meta}>
              The critic’s opinion: {critique.overall}/5 · {critique.issues.length} issue
              {critique.issues.length === 1 ? "" : "s"}
              <br />
              <span style={styles.caveat}>
                An opinion, not a quality score — measured running 1 → 4 → 3 on a
                sprite whose symmetry fell 0.913 → 0.493 → 0.441. Read the lint
                metrics below against it.
              </span>
            </p>
          )}

          {critique.issues.length === 0 ? (
            <p data-testid="converged" style={styles.converged}>
              No high-severity issues — converged, and handed to you.
            </p>
          ) : (
            critique.issues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                sent={filtered.get(issue.id)}
                active={activeIssueId === issue.id}
                onSelect={onSelectIssue}
              />
            ))
          )}
        </>
      )}

      <ReviseBlock round={round} />
      <LintBlock round={round} />
    </aside>
  );
}

/**
 * One issue, with the twin bars and the two filter verdicts.
 *
 * `sent` is the *filtered* copy — `undefined` when the issue never reached the
 * revise stage at all. Both facts are on `data-` attributes as well as in the
 * text, because "the critic mentioned this" and "the loop acted on this" are
 * different claims and the difference is the reason §6.7 stores both lists.
 */
function IssueCard({
  issue,
  sent,
  active,
  onSelect,
}: {
  issue: Issue;
  sent: Issue | undefined;
  active: boolean;
  onSelect(id: string): void;
}): React.JSX.Element {
  // `undefined`, not falsy: an issue that reached the agent is an object.
  const wasSent = sent !== undefined;
  // The agent got the problem and lost the guess (§6.4).
  const withheld = wasSent && sent.suggest.length === 0 && issue.suggest.length > 0;

  return (
    <button
      type="button"
      data-testid="issue"
      data-issue-id={issue.id}
      data-severity={issue.severity}
      data-active={active ? "true" : "false"}
      data-sent={wasSent ? "true" : "false"}
      data-suggest-withheld={withheld ? "true" : "false"}
      aria-pressed={active}
      onClick={() => onSelect(issue.id)}
      style={{
        ...styles.issue,
        borderLeftColor: SEVERITY_COLOR[issue.severity],
        ...(active ? styles.issueActive : null),
      }}
    >
      <span style={styles.issueText}>{issue.issue}</span>

      <span style={styles.bars}>
        <ConfidenceBar
          field="confidence"
          label="problem"
          value={issue.confidence}
          low={false}
        />
        <ConfidenceBar
          field="suggestConfidence"
          label="fix"
          value={issue.suggestConfidence}
          low={issue.suggestConfidence < SUGGEST_FLOOR}
        />
      </span>

      <span style={styles.region}>
        region [{issue.region.join(", ")}] · {issue.severity}
      </span>

      {wasSent ? null : (
        <span data-testid="issue-dropped" style={styles.dropped}>
          below the confidence floor — not sent to the reviser
        </span>
      )}
      {withheld ? (
        <span style={styles.withheld}>
          fix withheld: the critic’s own confidence in it was low, so the agent got
          the problem and decided for itself
        </span>
      ) : wasSent && sent.suggest.length > 0 ? (
        // `display: block` matters: an inline span here ran straight on from the
        // severity above it and rendered "· mediumsuggested: narrow the torso".
        <span style={styles.suggested}>suggested: {sent.suggest}</span>
      ) : null}
    </button>
  );
}

/**
 * One confidence field, as a labelled bar.
 *
 * `value` is rendered three ways — the number, the bar's width, and a `data-`
 * attribute — so a component that passed the same field twice would render two
 * identical bars *and* two identical numbers, which is what the test asserts
 * against. `0` is a legal value and prints as `0.00` at 0% width: it means the
 * critic is certain there is no problem, which is not the same as having said
 * nothing.
 */
function ConfidenceBar({
  field,
  label,
  value,
  low,
}: {
  field: "confidence" | "suggestConfidence";
  label: string;
  value: number;
  low: boolean;
}): React.JSX.Element {
  return (
    <span data-testid="confidence-bar" data-field={field} data-value={value} style={styles.bar}>
      <span style={styles.barLabel}>
        {label} {value.toFixed(2)}
      </span>
      <span style={styles.track}>
        <span
          data-fill={value}
          style={{
            ...styles.fill,
            width: pct(value),
            background: low ? "rgba(225,120,60,.95)" : "rgba(110,190,130,.95)",
          }}
        />
      </span>
    </span>
  );
}

/**
 * What the revise stage claims it did, and what it actually changed — rule 2.
 *
 * Rendered on every round that has either, so "revise did not run" and "revise
 * ran and changed nothing" stay different statements. `diffFromPrev` is `null`
 * on the first round (no parent to diff against) and `[]` when a pass changed
 * nothing; `length === 0` is a measurement and prints as `0`.
 */
function ReviseBlock({ round }: { round: Round }): React.JSX.Element | null {
  const { revise, diffFromPrev } = round;
  if (revise === null && diffFromPrev === null) return null;

  return (
    <div style={styles.section}>
      <div style={styles.label}>Revise · what changed</div>
      {diffFromPrev === null ? (
        <p data-testid="diff-count" data-cells="null" style={styles.meta}>
          first round — nothing to diff against
        </p>
      ) : (
        <p data-testid="diff-count" data-cells={diffFromPrev.length} style={styles.number}>
          {diffFromPrev.length} cell{diffFromPrev.length === 1 ? "" : "s"} changed since the parent
        </p>
      )}
      {revise === null ? (
        <p style={styles.meta}>the revise stage did not run on this round</p>
      ) : (
        <p data-testid="revise-claim" style={styles.meta}>
          {revise.turns} turn{revise.turns === 1 ? "" : "s"}
          {revise.hitCap ? " · hit the turn cap" : ""} · the agent’s claim:{" "}
          <em style={styles.claim}>“{revise.summary}”</em>
          <br />
          <span style={styles.caveat}>
            The claim is the agent’s own account and has been measured wrong — the
            cell count above is what happened.
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * `Round.lint` — spec §6.5, §8.
 *
 * Metrics first, because they are the numbers §7.2's A14 guard actually decides
 * on and the ones `overall` is anti-correlated with. Every one of them is
 * printed even at zero: `orphanCount: 0` is a clean sprite, not a missing
 * measurement, and a blank there is indistinguishable from a linter that never
 * ran — which is precisely the state this block exists to end.
 *
 * Warnings are listed by code with their cell counts. They are deliberately
 * **not** split into structural and advisory here: spec A6 puts that split in
 * `shared/schema.ts` as `STRUCTURAL_LINT_CODES` so §7, §11, the bench and this
 * dock filter identically, and that constant has not shipped. A local copy in
 * the renderer is the second hardcoding A6 was written to prevent.
 */
function LintBlock({ round }: { round: Round }): React.JSX.Element {
  const { warnings, metrics } = round.lint;

  return (
    <div data-testid="lint" style={styles.section}>
      <div style={styles.label}>Lint · deterministic</div>
      <p style={styles.number}>
        <span data-testid="lint-orphans" data-count={metrics.orphanCount}>
          {metrics.orphanCount} orphan{metrics.orphanCount === 1 ? "" : "s"}
        </span>
        {" · "}
        <span data-testid="lint-symmetry" data-value={metrics.symmetryScore}>
          symmetry {metrics.symmetryScore.toFixed(3)}
        </span>
        {" · "}
        <span data-testid="lint-coverage" data-value={metrics.coverage}>
          coverage {metrics.coverage.toFixed(2)}
        </span>
        {" · "}
        <span data-testid="lint-palette" data-count={metrics.paletteUsed}>
          {metrics.paletteUsed} palette entries used
        </span>
      </p>
      {warnings.length === 0 ? (
        <p style={styles.meta}>no warnings</p>
      ) : (
        warnings.map((warning, i) => <LintRow key={`${warning.code}-${i}`} warning={warning} />)
      )}
    </div>
  );
}

function LintRow({ warning }: { warning: LintWarning }): React.JSX.Element {
  return (
    <p data-testid="lint-warning" data-code={warning.code} style={styles.meta}>
      <b style={styles.code}>{warning.code}</b> — {warning.message}
      {warning.cells.length === 0 ? "" : ` (${warning.cells.length} cells)`}
    </p>
  );
}

const LINE = "1px solid rgba(128,128,128,.38)";

const styles: Record<string, CSSProperties> = {
  dock: {
    width: 260,
    flex: "none",
    borderLeft: LINE,
    background: "rgba(128,128,128,.05)",
    padding: 9,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  },
  label: {
    fontSize: 10,
    letterSpacing: ".09em",
    textTransform: "uppercase",
    opacity: 0.6,
    marginBottom: 6,
  },
  readsAs: { margin: "0 0 4px", fontSize: 12 },
  meta: { margin: "3px 0", fontSize: 10, opacity: 0.72, lineHeight: 1.4 },
  caveat: { opacity: 0.8, fontStyle: "italic" },
  claim: { fontStyle: "italic" },
  /** Metrics are numbers to be compared between rounds; tabular figures line up. */
  number: { margin: "3px 0", fontSize: 10, opacity: 0.85, fontVariantNumeric: "tabular-nums" },
  converged: {
    margin: "8px 0",
    fontSize: 11,
    padding: "6px 7px",
    borderRadius: 4,
    border: LINE,
    borderLeft: "3px solid rgba(110,190,130,.95)",
    background: "rgba(110,190,130,.10)",
  },
  degraded: {
    margin: "8px 0",
    fontSize: 11,
    padding: "6px 7px",
    borderRadius: 4,
    border: LINE,
    borderLeft: "3px solid rgba(225,120,60,.95)",
    background: "rgba(225,120,60,.10)",
  },
  issue: {
    display: "block",
    width: "100%",
    textAlign: "left",
    border: LINE,
    borderLeft: "3px solid rgba(220,70,70,.9)",
    borderRadius: 4,
    padding: "6px 7px",
    marginBottom: 6,
    cursor: "pointer",
    background: "rgba(128,128,128,.05)",
    color: "inherit",
    font: "inherit",
    fontSize: 11,
  },
  issueActive: {
    background: "rgba(100,160,240,.16)",
    borderColor: "rgba(100,160,240,.7)",
  },
  issueText: { display: "block", lineHeight: 1.35 },
  bars: { display: "flex", gap: 5, marginTop: 4 },
  bar: { flex: 1, display: "block", fontSize: 10 },
  barLabel: { display: "block", opacity: 0.72, fontVariantNumeric: "tabular-nums" },
  track: {
    display: "block",
    height: 3,
    borderRadius: 2,
    background: "rgba(128,128,128,.28)",
    marginTop: 2,
    overflow: "hidden",
  },
  fill: { display: "block", height: "100%" },
  /** Every line inside an issue card is its own block; see the `suggested` note. */
  region: { display: "block", marginTop: 3, fontSize: 10, opacity: 0.72 },
  suggested: { display: "block", marginTop: 3, fontSize: 10, opacity: 0.72 },
  dropped: { display: "block", marginTop: 3, fontSize: 10, opacity: 0.62, fontStyle: "italic" },
  withheld: { display: "block", marginTop: 3, fontSize: 10, color: "rgba(235,170,90,.95)" },
  section: { marginTop: 12 },
  code: { fontWeight: 700, opacity: 0.9 },
};
