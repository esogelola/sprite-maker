/**
 * Which server the app is talking to — spec amendment A16; §8's top bar.
 *
 * §8's sketch is `[prompt……] [Generate] [32▾] [pico-8▾] [models▾]`, and this row
 * is the question that comes before all of them. It exists because detection is
 * otherwise invisible: someone whose app found LM Studio at 1234 has no way to
 * confirm that it did, and someone whose app found nothing has no way to point
 * it anywhere without editing an environment variable and restarting — which is
 * the workaround A16 exists to delete.
 *
 * Four things here are decisions rather than layout:
 *
 * **1. Nothing is rendered until main has answered.** A select defaulted to
 * `ollama` is a claim, and before `getProvider` resolves nobody has made it —
 * the same reason `ModelPickers` refuses to render an empty dropdown.
 *
 * **2. Changing the provider clears the URL.** An empty base URL is main's
 * "that provider's own default", and carrying the old one across would point LM
 * Studio at 11434 — the mistake A15 gave each provider its own base-URL variable
 * to prevent, and one neither server can detect. The row therefore never has to
 * know a port number.
 *
 * **3. The field is local state that follows the view.** A controlled input
 * driven straight off `view.baseUrl` cannot be typed into one character at a
 * time; a purely local one drifts away from what the app is actually using when
 * main answers with a default or strips a trailing slash. So it is seeded from
 * the view and re-seeded whenever the view's URL changes.
 *
 * **4. The status is main's word, including `connected`.** That is a claim about
 * a socket, and §5.1 makes this file pure presentation. It renders the string it
 * is given — which after a failed detection is the *whole* diagnostic, naming
 * both providers and both endpoints, because naming one sends a person running
 * LM Studio to go and restart Ollama.
 *
 * Presentational, like every other component here: `App.tsx` owns the round trip,
 * because `setProvider` is a session mutation whose answer can be
 * `{ok:false, code:"busy"}` and the status bar has to render that.
 */

import { useEffect, useState, type CSSProperties } from "react";

import type { ProviderName, ProviderView } from "../../preload/index";

export interface ProviderRowProps {
  /** `Api.getProvider()`'s answer, or `null` before it arrives. */
  view: ProviderView | null;
  /** An empty `baseUrl` means "this provider's documented default". */
  onSelect(provider: ProviderName, baseUrl: string): void;
  disabled?: boolean;
}

/** In `PROVIDERS`' order, which is also the order detection prefers them. */
const OPTIONS: ReadonlyArray<{ value: ProviderName; label: string }> = [
  { value: "ollama", label: "Ollama" },
  { value: "lmstudio", label: "LM Studio" },
];

/** How the provider was chosen, in words the row has room for. */
const SOURCE_LABEL: Record<ProviderView["source"], string> = {
  configured: "configured",
  detected: "detected",
  fallback: "nothing answered",
};

export function ProviderRow({
  view,
  onSelect,
  disabled = false,
}: ProviderRowProps): React.JSX.Element {
  const [url, setUrl] = useState(view?.baseUrl ?? "");

  // Decision 3. Keyed on the value rather than on the object, so a re-read that
  // changed nothing does not wipe out what the user is halfway through typing.
  useEffect(() => {
    if (view !== null) setUrl(view.baseUrl);
  }, [view?.baseUrl]);

  if (view === null) {
    return (
      <span data-testid="provider-pending" style={styles.hint}>
        finding a model server…
      </span>
    );
  }

  const apply = (): void => onSelect(view.provider, url);

  return (
    <>
      <label style={styles.label} title="Which local model server this app talks to (A16)">
        <span style={styles.roleName}>server</span>
        <select
          data-testid="provider-select"
          style={styles.select}
          value={view.provider}
          disabled={disabled}
          // Decision 2: the empty URL is "use that provider's default".
          onChange={(e) => onSelect(e.target.value as ProviderName, "")}
        >
          {OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <input
        data-testid="provider-url"
        style={styles.url}
        value={url}
        disabled={disabled}
        aria-label="model server base URL"
        placeholder="http://127.0.0.1:11434"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
        }}
      />

      <button
        type="button"
        data-testid="provider-apply"
        style={styles.apply}
        disabled={disabled}
        title="Point the app at this URL and re-read its model list"
        onClick={apply}
      >
        Connect
      </button>

      <span
        data-testid="provider-status"
        data-connected={view.connected ? "true" : "false"}
        data-source={view.source}
        style={{ ...styles.status, ...(view.connected ? styles.up : styles.down) }}
        // The full string on the title as well as in the text: the row is one
        // line, and a truncated endpoint is the half of the diagnostic that
        // matters.
        title={view.error ?? `${view.baseUrl} is answering`}
      >
        {view.connected
          ? `connected · ${SOURCE_LABEL[view.source]}`
          : (view.error ?? `${view.baseUrl} is not answering`)}
      </span>

      {view.unavailable.length === 0 ? null : (
        <span
          data-testid="provider-unavailable"
          style={styles.missing}
          title="Pick a model this server has, or the next run fails on its first call"
        >
          {view.unavailable.map((m) => `${m.role}: ${m.model}`).join(" · ")} not on this server
        </span>
      )}
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
    cursor: "pointer",
  },
  url: {
    width: 168,
    padding: "5px 8px",
    borderRadius: 4,
    border: "1px solid rgba(128,128,128,.38)",
    background: "rgba(128,128,128,.05)",
    color: "inherit",
    font: "inherit",
    fontSize: 11,
  },
  apply: {
    padding: "5px 9px",
    borderRadius: 4,
    border: "1px solid rgba(128,128,128,.38)",
    background: "rgba(128,128,128,.05)",
    color: "inherit",
    font: "inherit",
    fontSize: 11,
    cursor: "pointer",
  },
  status: {
    fontSize: 10,
    maxWidth: 320,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /** The same green and amber the status bar's own dot uses. */
  up: { color: "rgba(120,220,140,.85)" },
  down: { color: "rgba(240,180,60,.95)" },
  missing: { fontSize: 10, color: "rgba(240,180,60,.95)" },
};
