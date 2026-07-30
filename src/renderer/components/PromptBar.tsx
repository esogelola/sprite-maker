/**
 * The top bar — spec §2, §6.1a, §6.2, §8; plan Wave 12.
 *
 * §8's layout sketch is `[prompt……] [Generate] [32▾] [pico-8▾] [models▾]`, and
 * until this wave the last three were constants in `App.tsx`: every sprite the
 * app could make was 16×16 pico-8, which is two of §2's shipped features
 * unreachable from the UI.
 *
 * **Size is one of §6.2's three squares and is reported as a number.** A `<select>`
 * hands back a string, and `SizeSchema` is a discriminated union on the numeric
 * literal `w` — so `{w: "32"}` fails validation in main with a schema error about
 * a field the user never typed. The conversion happens here, once.
 *
 * **Generate is disabled when there is nothing to generate from, and when Ollama
 * is unreachable** (§8: "Generate is disabled and the status bar names the exact
 * endpoint. No silent fallback."). `blocked` is a string rather than a boolean so
 * the button's own tooltip can say why, instead of leaving the user with a
 * greyed-out control and a reason three lines further down.
 *
 * The model pickers arrive as `children` rather than being rendered here: §8 puts
 * them in this row, but they answer to `Api.listModels`/`bindModel` and have
 * nothing to do with the prompt. Composing them in keeps one flex row without
 * making this component know about roles.
 */

import type { CSSProperties, ReactNode } from "react";

/** §6.2's three canvases. Not a free number — the schema is a union of literals. */
export const SIZES = [16, 32, 64] as const;
export type CanvasSize = (typeof SIZES)[number];

export interface PromptBarProps {
  prompt: string;
  onPromptChange(prompt: string): void;
  size: CanvasSize;
  onSizeChange(size: CanvasSize): void;
  paletteId: string;
  onPaletteChange(paletteId: string): void;
  /** `Api.getPalettes()` — the curated library (§6.1a). */
  palettes: ReadonlyArray<{ id: string; name: string }>;
  /** The mutation in flight, or `null`. */
  pending: string | null;
  /** Why Generate is unavailable, or `null`. Rendered on the button's title. */
  blocked: string | null;
  onGenerate(): void;
  children?: ReactNode;
}

export function PromptBar({
  prompt,
  onPromptChange,
  size,
  onSizeChange,
  paletteId,
  onPaletteChange,
  palettes,
  pending,
  blocked,
  onGenerate,
  children,
}: PromptBarProps): React.JSX.Element {
  const busy = pending !== null;
  const disabled = busy || blocked !== null || prompt.trim().length === 0;

  return (
    <div style={styles.bar}>
      <input
        data-testid="prompt"
        style={styles.input}
        value={prompt}
        placeholder="describe a sprite"
        disabled={busy}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !disabled) onGenerate();
        }}
      />

      <button
        type="button"
        data-testid="generate"
        style={{ ...styles.control, ...styles.primary }}
        disabled={disabled}
        title={blocked ?? "Draft, lint and critique until a stop condition fires"}
        onClick={onGenerate}
      >
        {pending === "run" ? "Generating…" : "Generate"}
      </button>

      <select
        data-testid="size"
        style={styles.control}
        value={size}
        disabled={busy}
        aria-label="canvas size"
        // The string a select hands back, converted once. `SizeSchema` is a
        // union of numeric literals and rejects "32" with a schema error about
        // a field the user never typed.
        onChange={(e) => onSizeChange(Number(e.target.value) as CanvasSize)}
      >
        {SIZES.map((n) => (
          <option key={n} value={n}>
            {n}×{n}
          </option>
        ))}
      </select>

      <select
        data-testid="palette-picker"
        style={styles.control}
        value={paletteId}
        disabled={busy}
        aria-label="palette"
        onChange={(e) => onPaletteChange(e.target.value)}
      >
        {palettes.map((palette) => (
          <option key={palette.id} value={palette.id}>
            {palette.name}
          </option>
        ))}
      </select>

      {children}
    </div>
  );
}

const LINE = "1px solid rgba(128,128,128,.38)";

const styles: Record<string, CSSProperties> = {
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
  control: {
    padding: "6px 10px",
    borderRadius: 4,
    border: LINE,
    background: "rgba(128,128,128,.05)",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
  },
  primary: {
    border: "1px solid rgba(100,160,240,.6)",
    background: "rgba(100,160,240,.28)",
    fontWeight: 700,
    padding: "6px 14px",
  },
};
