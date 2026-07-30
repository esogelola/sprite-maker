/**
 * The colour picker — spec §6.1a, §8; plan Wave 11.
 *
 * **It renders the document's palette, never the library's.** `SpriteDoc.palette`
 * is a snapshot taken at draft time precisely so a saved sprite renders standalone
 * (§6.2), and the bundled palettes are 4 to 16 entries long. A bar built from
 * `listPalettes()[0]` would offer a 4-colour `gameboy` sprite sixteen swatches,
 * twelve of which `shared/grid.ts` rejects as `off-palette` on the way back
 * through `setPixel` — an affordance that exists and does nothing, which §8's
 * interaction contract calls a defect outright.
 *
 * **The transparent swatch comes first and is a real choice.** It is the eraser,
 * and `.` is a legal value everywhere a row character is (§6.1). It carries its
 * own checkerboard rather than a colour, for the same §4.5 reason the canvas
 * does: a swatch showing `#000000` for "erase" would be the confusion, in the one
 * place the user picks between the two.
 *
 * Swatches are `<button>`s. They are pressed, they can be tabbed to, and
 * `aria-pressed` says which one is active — which is also the assertion that
 * `activeIndex: "0"` is not being read as "nothing selected".
 */

import type { CSSProperties } from "react";

import { indexChar } from "@shared/grid";
import type { PaletteRef } from "@shared/schema";

export interface PaletteBarProps {
  /** `doc.palette` — the snapshot the document carries, not a library lookup. */
  palette: PaletteRef;
  /** The active row character, `"."` or `0`-`f`. */
  activeIndex: string;
  onSelect(ch: string): void;
}

/** The eraser. Spelled out because `indexChar` cannot produce it. */
const TRANSPARENT = ".";

export function PaletteBar({ palette, activeIndex, onSelect }: PaletteBarProps): React.JSX.Element {
  const entries: Array<{ ch: string; label: string; style: CSSProperties }> = [
    {
      ch: TRANSPARENT,
      label: "transparent",
      style: styles.checker,
    },
    ...palette.colors.map((hex, i) => ({
      ch: indexChar(i),
      label: `index ${indexChar(i)} — ${hex}`,
      style: { backgroundColor: hex },
    })),
  ];

  return (
    <div data-testid="palette" style={styles.bar} aria-label={`palette ${palette.id}`}>
      {entries.map(({ ch, label, style }) => {
        // `===` against the character, never a truthiness test: `"0"` is a
        // non-empty string and therefore truthy, but the *index* it names is 0
        // and every near-miss in this project has been on that number.
        const active = activeIndex === ch;
        return (
          <button
            key={ch}
            type="button"
            data-testid="swatch"
            data-index={ch}
            aria-pressed={active}
            aria-label={label}
            title={label}
            onClick={() => onSelect(ch)}
            style={{ ...styles.swatch, ...style, ...(active ? styles.selected : null) }}
          />
        );
      })}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  bar: {
    display: "flex",
    flexWrap: "wrap",
    gap: 4,
    justifyContent: "center",
    maxWidth: 520,
  },
  swatch: {
    width: 22,
    height: 22,
    padding: 0,
    borderRadius: 3,
    border: "2px solid transparent",
    boxShadow: "0 0 0 1px rgba(128,128,128,.38)",
    cursor: "pointer",
    display: "block",
  },
  selected: {
    borderColor: "rgba(100,160,240,1)",
    transform: "scale(1.18)",
  },
  /** The same idiom as the canvas: empty is a checker, never a colour. */
  checker: {
    backgroundColor: "#161922",
    backgroundImage: [
      "linear-gradient(45deg, #20242e 25%, transparent 25%)",
      "linear-gradient(-45deg, #20242e 25%, transparent 25%)",
      "linear-gradient(45deg, transparent 75%, #20242e 75%)",
      "linear-gradient(-45deg, transparent 75%, #20242e 75%)",
    ].join(", "),
    backgroundSize: "10px 10px",
    backgroundPosition: "0 0, 0 5px, 5px -5px, -5px 0",
  },
};
