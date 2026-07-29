/**
 * Curated palette library — spec §6.1a. Pure data, no I/O, no dependencies.
 *
 * Row encoding (spec §6.1) uses one hex character per pixel, so a palette can
 * carry at most 16 opaque entries. Four is the floor. A palette shorter than 16
 * simply makes the indices past its end off-palette; `shared/grid.ts` rejects
 * them like any other out-of-range index.
 *
 * Colors are stored as lowercase `#rrggbb`. Index order is palette order:
 * character `0` means `colors[0]`.
 */

export interface Palette {
  readonly id: string;
  readonly name: string;
  readonly colors: readonly string[];
}

/** PICO-8 fantasy-console standard palette (Lexaloffle). */
const PICO_8: Palette = {
  id: "pico-8",
  name: "PICO-8",
  colors: [
    "#000000", // 0  black
    "#1d2b53", // 1  dark blue
    "#7e2553", // 2  dark purple
    "#008751", // 3  dark green
    "#ab5236", // 4  brown
    "#5f574f", // 5  dark grey
    "#c2c3c7", // 6  light grey
    "#fff1e8", // 7  white
    "#ff004d", // 8  red
    "#ffa300", // 9  orange
    "#ffec27", // a  yellow
    "#00e436", // b  green
    "#29adff", // c  blue
    "#83769c", // d  lavender
    "#ff77a8", // e  pink
    "#ffccaa", // f  light peach
  ],
};

/** DawnBringer 16 — Arne Niklas Jansson's canonical 16-color ramp. */
const DB16: Palette = {
  id: "db16",
  name: "DawnBringer 16",
  colors: [
    "#140c1c", // 0  black
    "#442434", // 1  dark maroon
    "#30346d", // 2  dark blue
    "#4e4a4e", // 3  dark grey
    "#854c30", // 4  brown
    "#346524", // 5  dark green
    "#d04648", // 6  red
    "#757161", // 7  grey
    "#597dce", // 8  blue
    "#d27d2c", // 9  orange
    "#8595a1", // a  slate
    "#6daa2c", // b  green
    "#d2aa99", // c  tan / skin
    "#6dc2ca", // d  cyan
    "#dad45e", // e  yellow
    "#deeed6", // f  white
  ],
};

/** AAP-16 by Adigun A. Polack. */
const AAP_16: Palette = {
  id: "aap-16",
  name: "AAP-16",
  colors: [
    "#070708", // 0  near black
    "#332222", // 1  dark brown
    "#774433", // 2  brown
    "#cc8855", // 3  tan / skin
    "#993311", // 4  dark red
    "#dd7711", // 5  orange
    "#ffdd55", // 6  gold
    "#ffff33", // 7  yellow
    "#55aa44", // 8  green
    "#115522", // 9  dark green
    "#44eebb", // a  aqua
    "#3388dd", // b  blue
    "#5544aa", // c  violet
    "#555577", // d  slate
    "#aabbbb", // e  light grey
    "#ffffff", // f  white
  ],
};

/**
 * A curated 16-color subset of the ~54-entry NES (2C02) master palette.
 *
 * The full hardware palette cannot fit the single-hex-character encoding, so
 * this is a deliberate selection rather than a truncation. It was chosen for
 * spread rather than for hue completeness: a 4-step neutral ramp for structure,
 * a 4-step earth/gold ramp, a red-through-peach ramp that doubles as skin
 * tones, and two steps each of green and blue. Every value below appears
 * verbatim in the NES master palette — none are interpolated.
 */
const NES_16: Palette = {
  id: "nes-16",
  name: "NES 16 (curated)",
  colors: [
    "#000000", // 0  black                 ($0f)
    "#7c7c7c", // 1  mid grey              ($00)
    "#bcbcbc", // 2  light grey            ($10)
    "#fcfcfc", // 3  white                 ($30)
    "#503000", // 4  dark brown            ($08)
    "#ac7c00", // 5  bronze                ($18)
    "#f8b800", // 6  gold                  ($28)
    "#f8d878", // 7  straw                 ($38)
    "#a81000", // 8  dark red              ($06)
    "#f83800", // 9  red                   ($16)
    "#f87858", // a  salmon / mid skin     ($26)
    "#f0d0b0", // b  peach / light skin    ($36)
    "#007800", // c  dark green            ($1a)
    "#00b800", // d  green                 ($2a)
    "#0058f8", // e  blue                  ($12)
    "#3cbcfc", // f  sky blue              ($21)
  ],
};

/** Original Game Boy (DMG-01) green ramp, darkest to lightest. */
const GAMEBOY: Palette = {
  id: "gameboy",
  name: "Game Boy (DMG)",
  colors: [
    "#0f380f", // 0  darkest
    "#306230", // 1  dark
    "#8bac0f", // 2  light
    "#9bbc0f", // 3  lightest
  ],
};

/**
 * Palettes are shared singletons handed to the agent, the linter, the
 * renderer and the UI. A mutation anywhere would corrupt every consumer,
 * so freeze both the palette objects and their colour arrays at module
 * load. `readonly` on the interface is a compile-time hint only — this
 * is the runtime guarantee.
 */
function freezePalette(p: Palette): Palette {
  Object.freeze(p.colors);
  return Object.freeze(p);
}

export const PALETTES: Readonly<Record<string, Palette>> = Object.freeze({
  "pico-8": freezePalette(PICO_8),
  db16: freezePalette(DB16),
  "aap-16": freezePalette(AAP_16),
  "nes-16": freezePalette(NES_16),
  gameboy: freezePalette(GAMEBOY),
});

/** Look up a bundled palette. Throws on an unknown id — never returns a stub. */
export function getPalette(id: string): Palette {
  const p = PALETTES[id];
  if (!p) {
    throw new Error(
      `Unknown palette id '${id}'. Known ids: ${Object.keys(PALETTES).join(", ")}`,
    );
  }
  return p;
}

export function listPalettes(): Palette[] {
  return Object.values(PALETTES);
}
