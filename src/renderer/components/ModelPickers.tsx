/**
 * Which model plays which role — spec §6.8, §9, §12; plan Wave 12.
 *
 * Two selects, one per role in `HarnessConfig.models`. Both default to
 * `qwen3-vl:8b-instruct-q4_K_M`, which is §6.8's shipped default for *both*
 * roles under amendment A10 — the benchmark found `qwen3:8b` cannot draw, so the
 * vision model generates as well as critiques.
 *
 * **The options are the installed models** (§9: "pickers list only installed
 * models"), read from `Api.listModels()`, which reaches Ollama over HTTP and can
 * fail. When it has not answered yet — or answered a failure — the pickers say
 * so rather than rendering an empty dropdown, because an empty dropdown is an
 * affordance that exists and does nothing, which §8's interaction contract calls
 * a defect outright.
 *
 * **A bound model Ollama does not have is still shown, marked.** Listing only
 * what is installed would make the select display *some other model* while the
 * config still names the missing one — the picker would then be lying about what
 * the next run will call, and §9's row for this failure is "fail the round naming
 * the model", not "quietly pretend it is bound to something else". The option is
 * present, labelled `(not installed)`, and disabled so it cannot be re-chosen.
 *
 * Presentational, like every other component here (§5.1): it does not call
 * `Api.bindModel` itself. `App.tsx` owns the round trip, because rebinding
 * writes through to the live config and the answer is a `Result` the status bar
 * has to be able to render.
 */

import type { CSSProperties } from "react";

import type { ModelRole } from "../../preload/index";

export interface ModelPickersProps {
  /** Every model Ollama has installed, from `Api.listModels()`. */
  installed: readonly string[];
  /** The live bindings from `Api.getModels()`, or `null` before it answers. */
  bound: { generator: string; critic: string } | null;
  onBind(role: ModelRole, model: string): void;
  disabled?: boolean;
}

const ROLES: ReadonlyArray<{ role: ModelRole; label: string; title: string }> = [
  { role: "generator", label: "gen", title: "Generator — draft and revise (§6.6)" },
  { role: "critic", label: "critic", title: "Critic — the vision pass (§7.4)" },
];

export function ModelPickers({
  installed,
  bound,
  onBind,
  disabled = false,
}: ModelPickersProps): React.JSX.Element {
  if (bound === null || installed.length === 0) {
    return (
      <span data-testid="models-unavailable" style={styles.hint}>
        models unavailable — is Ollama running?
      </span>
    );
  }

  return (
    <>
      {ROLES.map(({ role, label, title }) => {
        const current = bound[role];
        // Present but missing: the config names it, so the picker must show it.
        const missing = !installed.includes(current);
        return (
          <label key={role} style={styles.label} title={title}>
            <span style={styles.roleName}>{label}</span>
            <select
              data-testid={`model-${role}`}
              data-missing={missing ? "true" : "false"}
              style={styles.select}
              value={current}
              disabled={disabled}
              onChange={(e) => onBind(role, e.target.value)}
            >
              {missing ? (
                <option value={current} disabled>
                  {current} (not installed)
                </option>
              ) : null}
              {installed.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </>
  );
}

const styles: Record<string, CSSProperties> = {
  label: { display: "flex", alignItems: "center", gap: 4, fontSize: 11 },
  roleName: { opacity: 0.55, fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase" },
  select: {
    padding: "5px 8px",
    borderRadius: 4,
    border: "1px solid rgba(128,128,128,.38)",
    background: "rgba(128,128,128,.05)",
    color: "inherit",
    font: "inherit",
    fontSize: 11,
    maxWidth: 190,
    cursor: "pointer",
  },
  hint: { fontSize: 10, opacity: 0.55 },
};
