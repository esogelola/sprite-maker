/**
 * `main/render.ts` — spec §4.4, §4.5 and plan Wave 4.
 *
 * Two things make this file longer than "does it produce a PNG":
 *
 * **1. The oracle is the fixture, not the renderer.** `expectedPixel` below
 * reads `doc.rows` and `doc.palette.colors` and parses the hex itself, so every
 * per-pixel assertion is checked against the document rather than against
 * another copy of the renderer's own arithmetic. `expectMatchesDoc` applies it
 * to *every* pixel of the decoded image, which is what catches a transposed
 * loop, a skipped last row or column, and a stray alpha in one pass.
 *
 * **2. Alpha is the whole of §4.5.** `qwen3-vl` cannot tell transparent from
 * opaque black, so "transparent decodes to alpha 0 on export" and "transparent
 * decodes to the background colour on the critique path" are two separate
 * contracts, and a renderer that composites unconditionally satisfies neither.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { pickCriticBackground, toPng } from "@main/render";
import { charIndex } from "@shared/grid";
import { relativeLuminance } from "@shared/color";
import type { SpriteDoc } from "@shared/schema";
import {
  ALL_FIXTURES,
  BLACK_OUTLINE,
  BLANK,
  BORDER_RING_32,
  CORNER_PALETTE,
  LOW_CONTRAST_PAIR,
  SOLID_BLOCK,
  SPRITE_32,
  SPRITE_64,
  WHITE_ONLY,
} from "../fixtures/sprites";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Rgba = [number, number, number, number];

const FIXTURE_ENTRIES = Object.entries(ALL_FIXTURES);

/** The golden minted by Wave 4 and committed alongside this file. */
const GOLDEN_PATH = fileURLToPath(
  new URL("../fixtures/golden/sprite-32-8x.png", import.meta.url),
);

/**
 * `#rrggbb` → three channels, parsed here rather than imported.
 *
 * `render.ts` uses `hexToRgb` from `shared/color.ts`; borrowing it would make
 * every colour assertion below a comparison of that function with itself.
 */
function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** The RGBA the document says cell `(x, y)` must produce. */
function expectedPixel(
  doc: SpriteDoc,
  x: number,
  y: number,
  background?: string,
): Rgba {
  const index = charIndex(doc.rows[y][x]);
  if (index >= 0) {
    const [r, g, b] = parseHex(doc.palette.colors[index]);
    return [r, g, b, 255];
  }
  if (background === undefined) return [0, 0, 0, 0];
  const [r, g, b] = parseHex(background);
  return [r, g, b, 255];
}

/** The decoded RGBA at image coordinates `(px, py)`. */
function pixelAt(png: PNG, px: number, py: number): Rgba {
  const i = (py * png.width + px) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

/**
 * Every pixel of the decoded image against the document that produced it.
 *
 * Collects mismatches instead of asserting per pixel: a 512×512 render is
 * 262,144 pixels, and one `expect` each turns a 20 ms test into a 30 s one
 * while reporting the same first failure.
 */
function expectMatchesDoc(
  buffer: Buffer,
  doc: SpriteDoc,
  scale: number,
  background?: string,
): PNG {
  const png = PNG.sync.read(buffer);
  expect([png.width, png.height]).toEqual([doc.size.w * scale, doc.size.h * scale]);

  const mismatches: string[] = [];
  for (let py = 0; py < png.height; py++) {
    for (let px = 0; px < png.width; px++) {
      const sx = Math.floor(px / scale);
      const sy = Math.floor(py / scale);
      const want = expectedPixel(doc, sx, sy, background);
      const got = pixelAt(png, px, py);
      if (
        got[0] !== want[0] ||
        got[1] !== want[1] ||
        got[2] !== want[2] ||
        got[3] !== want[3]
      ) {
        if (mismatches.length < 8) {
          mismatches.push(
            `(${px},${py}) from cell (${sx},${sy}) '${doc.rows[sy][sx]}': ` +
              `got [${got.join(", ")}], want [${want.join(", ")}]`,
          );
        }
      }
    }
  }
  expect(mismatches).toEqual([]);
  return png;
}

/** Independent brute force of spec §4.5: maximin luminance distance. */
function bestGreyFor(colors: string[]): string {
  const luminances = colors.map(relativeLuminance);
  let best = "";
  let bestScore = -Infinity;
  for (let g = 0; g < 256; g++) {
    const hex = `#${g.toString(16).padStart(2, "0").repeat(3)}`;
    const score = Math.min(
      ...luminances.map((l) => Math.abs(relativeLuminance(hex) - l)),
    );
    if (score > bestScore) {
      bestScore = score;
      best = hex;
    }
  }
  return best;
}

/** The palette colours a document's rows actually reference. */
function usedColors(doc: SpriteDoc): string[] {
  const used = new Set<number>();
  for (const row of doc.rows) {
    for (const ch of row) {
      const index = charIndex(ch);
      if (index >= 0) used.add(index);
    }
  }
  return [...used].sort((a, b) => a - b).map((i) => doc.palette.colors[i]);
}

/** The smallest luminance gap between a candidate and the used entries. */
function minDistance(candidate: string, colors: string[]): number {
  const l = relativeLuminance(candidate);
  return Math.min(...colors.map((c) => Math.abs(l - relativeLuminance(c))));
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

describe("toPng — geometry", () => {
  it("renders a 16×16 document at 1× as a 16×16 image", () => {
    const png = PNG.sync.read(toPng(SOLID_BLOCK, 1));
    expect([png.width, png.height]).toEqual([16, 16]);
  });

  it("renders 32×32 at 16× as 512×512 — spec §6.8's criticTargetPx", () => {
    const png = PNG.sync.read(toPng(SPRITE_32, 16));
    expect([png.width, png.height]).toEqual([512, 512]);
  });

  it("renders 64×64 at 8× as 512×512 — the same target from the other size", () => {
    const png = PNG.sync.read(toPng(SPRITE_64, 8));
    expect([png.width, png.height]).toEqual([512, 512]);
  });

  it("renders 32×32 at 8× as 256×256 — the golden's geometry", () => {
    const png = PNG.sync.read(toPng(SPRITE_32, 8));
    expect([png.width, png.height]).toEqual([256, 256]);
  });

  it("emits 8-bit RGBA, four bytes per pixel", () => {
    const png = PNG.sync.read(toPng(SPRITE_32, 2));
    expect(png.data.length).toBe(64 * 64 * 4);
    expect(png.depth).toBe(8);
    expect(png.colorType).toBe(6);
  });

  it("returns a Buffer carrying the PNG signature", () => {
    const buffer = toPng(SOLID_BLOCK, 1);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect([...buffer.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});

// ---------------------------------------------------------------------------
// nearest neighbour
// ---------------------------------------------------------------------------

describe("toPng — nearest-neighbour upscaling", () => {
  it("gives all 256 sub-pixels of a source cell at 16× identical RGBA", () => {
    // (11, 4) is the leftmost canopy outline cell of `SPRITE_32`: index 3,
    // `#008751`, with a transparent cell immediately to its left.
    const png = PNG.sync.read(toPng(SPRITE_32, 16));
    expect(SPRITE_32.rows[4][11]).toBe("3");

    const seen = new Set<string>();
    for (let dy = 0; dy < 16; dy++) {
      for (let dx = 0; dx < 16; dx++) {
        seen.add(pixelAt(png, 11 * 16 + dx, 4 * 16 + dy).join(","));
      }
    }
    expect([...seen]).toEqual(["0,135,81,255"]);
  });

  it("keeps the boundary between two cells hard, with no interpolated pixel", () => {
    // The pixel column immediately left of the cell above belongs to a
    // transparent cell. A smoothing resampler puts a partly-opaque green there;
    // nearest-neighbour puts nothing.
    const png = PNG.sync.read(toPng(SPRITE_32, 16));
    expect(pixelAt(png, 11 * 16 - 1, 4 * 16)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(png, 11 * 16, 4 * 16)).toEqual([0, 135, 81, 255]);
  });

  it("uses only colours the palette actually contains", () => {
    const png = PNG.sync.read(toPng(SPRITE_32, 4));
    const allowed = new Set(
      SPRITE_32.palette.colors.map((hex) => `${parseHex(hex).join(",")},255`),
    );
    allowed.add("0,0,0,0");
    const seen = new Set<string>();
    for (let py = 0; py < png.height; py++) {
      for (let px = 0; px < png.width; px++) seen.add(pixelAt(png, px, py).join(","));
    }
    for (const colour of seen) expect(allowed.has(colour)).toBe(true);
  });

  it("matches the document pixel for pixel at 1×", () => {
    expectMatchesDoc(toPng(SPRITE_32, 1), SPRITE_32, 1);
  });

  it("matches the document pixel for pixel at 16×", () => {
    expectMatchesDoc(toPng(SPRITE_32, 16), SPRITE_32, 16);
  });

  it("matches the document at an odd scale, where a >>1 shortcut would not", () => {
    expectMatchesDoc(toPng(SPRITE_32, 3), SPRITE_32, 3);
  });

  it("matches the largest realistic render — 64×64 at 8×", () => {
    expectMatchesDoc(toPng(SPRITE_64, 8), SPRITE_64, 8);
  });

  it("keeps rows and columns in place — a transposed render fails here", () => {
    // `SPRITE_32` is deliberately asymmetric top to bottom: row 4 is canopy,
    // row 30 is the ground line. Reading `rows[x][y]` instead of `rows[y][x]`
    // swaps them, and these two assertions are the ones that notice.
    const png = PNG.sync.read(toPng(SPRITE_32, 1));
    // (14, 23) is trunk — index 4, brown. (23, 14) is canopy — index b, green.
    expect(SPRITE_32.rows[23][14]).toBe("4");
    expect(SPRITE_32.rows[14][23]).toBe("b");
    expect(pixelAt(png, 14, 23)).toEqual([...parseHex("#ab5236"), 255]);
    expect(pixelAt(png, 23, 14)).toEqual([...parseHex("#00e436"), 255]);
    // The ground line spans x 3..28 on row 30; row 3 is empty.
    expect(SPRITE_32.rows[30][3]).toBe("5");
    expect(SPRITE_32.rows[3][30]).toBe(".");
    expect(pixelAt(png, 3, 30)).toEqual([...parseHex("#5f574f"), 255]);
    expect(pixelAt(png, 30, 3)).toEqual([0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// borders
// ---------------------------------------------------------------------------

describe("toPng — borders (the class Waves 1-3 leaked)", () => {
  it("paints the last row and last column of a fully-opaque sprite at 1×", () => {
    // `SOLID_BLOCK` has no transparent cell, so a loop stopping at `w - 1` or
    // `h - 1` leaves a transparent stripe rather than a plausible colour.
    const png = expectMatchesDoc(toPng(SOLID_BLOCK, 1), SOLID_BLOCK, 1);
    for (let x = 0; x < 16; x++) expect(pixelAt(png, x, 15)[3]).toBe(255);
    for (let y = 0; y < 16; y++) expect(pixelAt(png, 15, y)[3]).toBe(255);
  });

  it("paints the last row and last column of a fully-opaque sprite at 4×", () => {
    const png = expectMatchesDoc(toPng(SOLID_BLOCK, 4), SOLID_BLOCK, 4);
    for (let x = 0; x < 64; x++) expect(pixelAt(png, x, 63)[3]).toBe(255);
    for (let y = 0; y < 64; y++) expect(pixelAt(png, 63, y)[3]).toBe(255);
  });

  it("renders all four corners of a 32-wide canvas", () => {
    // `BORDER_RING_32` carries an orphan in each corner — the only fixture that
    // puts content at `(31, 31)` on a 32-wide grid, where a hard-coded 15 and
    // `size.w - 1` are twenty-nine apart.
    const png = expectMatchesDoc(toPng(BORDER_RING_32, 2), BORDER_RING_32, 2);
    const corner = [...parseHex(BORDER_RING_32.palette.colors[1]), 255];
    expect(pixelAt(png, 0, 0)).toEqual(corner);
    expect(pixelAt(png, 63, 0)).toEqual(corner);
    expect(pixelAt(png, 0, 63)).toEqual(corner);
    expect(pixelAt(png, 63, 63)).toEqual(corner);
  });

  it("renders the last pixel of the image, not just the last cell", () => {
    // Scale-level border: the bottom-right *sub*-pixel of the bottom-right
    // cell. A `dx < scale - 1` loop passes every other assertion in this file.
    const png = PNG.sync.read(toPng(SOLID_BLOCK, 5));
    expect(pixelAt(png, 79, 79)).toEqual([
      ...parseHex(SOLID_BLOCK.palette.colors[charIndex(SOLID_BLOCK.rows[15][15])]),
      255,
    ]);
  });
});

// ---------------------------------------------------------------------------
// alpha
// ---------------------------------------------------------------------------

describe("toPng — alpha (spec §4.5: export preserves it)", () => {
  it("decodes a transparent cell to fully transparent black, not white", () => {
    const png = PNG.sync.read(toPng(SPRITE_32, 1));
    expect(SPRITE_32.rows[0][0]).toBe(".");
    expect(pixelAt(png, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("emits alpha 0 or 255 and nothing between", () => {
    const png = PNG.sync.read(toPng(SPRITE_32, 4));
    const alphas = new Set<number>();
    for (let py = 0; py < png.height; py++) {
      for (let px = 0; px < png.width; px++) alphas.add(pixelAt(png, px, py)[3]);
    }
    expect([...alphas].sort((a, b) => a - b)).toEqual([0, 255]);
  });

  it("leaves a fully transparent document fully transparent", () => {
    const png = expectMatchesDoc(toPng(BLANK, 4), BLANK, 4);
    for (let py = 0; py < png.height; py++) {
      for (let px = 0; px < png.width; px++) {
        expect(pixelAt(png, px, py)).toEqual([0, 0, 0, 0]);
      }
    }
  });

  it("gives every opaque cell alpha exactly 255", () => {
    const png = PNG.sync.read(toPng(SOLID_BLOCK, 3));
    for (let py = 0; py < png.height; py++) {
      for (let px = 0; px < png.width; px++) expect(pixelAt(png, px, py)[3]).toBe(255);
    }
  });
});

// ---------------------------------------------------------------------------
// background
// ---------------------------------------------------------------------------

describe("toPng — background (spec §4.5: only the critique path passes one)", () => {
  it("composites transparent cells onto the supplied colour", () => {
    expectMatchesDoc(toPng(SPRITE_32, 2, "#ff00ff"), SPRITE_32, 2, "#ff00ff");
  });

  it("leaves no transparent pixel behind when a background is supplied", () => {
    const png = PNG.sync.read(toPng(SPRITE_32, 2, "#ff00ff"));
    for (let py = 0; py < png.height; py++) {
      for (let px = 0; px < png.width; px++) expect(pixelAt(png, px, py)[3]).toBe(255);
    }
  });

  it("does not repaint opaque cells", () => {
    const plain = PNG.sync.read(toPng(SPRITE_32, 1));
    const composited = PNG.sync.read(toPng(SPRITE_32, 1, "#ff00ff"));
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        if (charIndex(SPRITE_32.rows[y][x]) < 0) continue;
        expect(pixelAt(composited, x, y)).toEqual(pixelAt(plain, x, y));
      }
    }
  });

  it("fills a blank canvas edge to edge", () => {
    const png = PNG.sync.read(toPng(BLANK, 2, "#123456"));
    for (let py = 0; py < png.height; py++) {
      for (let px = 0; px < png.width; px++) {
        expect(pixelAt(png, px, py)).toEqual([0x12, 0x34, 0x56, 255]);
      }
    }
  });

  it("changes the bytes it is given — an ignored parameter fails here", () => {
    const plain = toPng(SPRITE_32, 4);
    const composited = toPng(SPRITE_32, 4, "#ff00ff");
    expect(composited.equals(plain)).toBe(false);
  });

  it("preserves alpha when the parameter is omitted or explicitly undefined", () => {
    const omitted = toPng(SPRITE_32, 4);
    const explicit = toPng(SPRITE_32, 4, undefined);
    expect(explicit.equals(omitted)).toBe(true);
    expect(pixelAt(PNG.sync.read(omitted), 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("accepts uppercase hex, as `HexColor` does", () => {
    expect(toPng(SPRITE_32, 2, "#FF00FF").equals(toPng(SPRITE_32, 2, "#ff00ff"))).toBe(
      true,
    );
  });

  it("rejects anything that is not a #rrggbb colour", () => {
    // `#ff00ff00` covers the trailing end of the pattern; `x#ff00ff` and
    // ` #ff00ff` cover the leading end. Without them an unanchored test would
    // accept a valid colour buried in junk, and `hexToRgb` would then slice from
    // the wrong offset — `"x#ff000f"` parses as `"#f"` → `NaN` channels → 0,
    // so the sprite renders on a background nobody asked for instead of
    // throwing.
    for (const bad of [
      "#fff",
      "ff00ff",
      "#ff00f",
      "#gggggg",
      "",
      "red",
      "#ff00ff00",
      "x#ff00ff",
      " #ff00ff",
    ]) {
      expect(() => toPng(SPRITE_32, 1, bad)).toThrow(/background/i);
    }
  });
});

// ---------------------------------------------------------------------------
// scale
// ---------------------------------------------------------------------------

describe("toPng — scale validation", () => {
  it("accepts 1", () => {
    expect(PNG.sync.read(toPng(SOLID_BLOCK, 1)).width).toBe(16);
  });

  it("accepts a scale above the 16 §6.8 offers the export UI", () => {
    // The module's rule is "positive whole number" and nothing else — §6.8's 1,
    // 4, 8 and 16 are a caller's menu, not a bound. An upper limit added here
    // would pass every other test in this file, because no other test asks for
    // more than 16, and would then reject the first print-resolution export.
    const png = expectMatchesDoc(toPng(SOLID_BLOCK, 32), SOLID_BLOCK, 32);
    expect([png.width, png.height]).toEqual([512, 512]);

    // 16×16 at 32× rather than 64×64 at 64×: a 512×512 render kills a ceiling
    // just as dead as a 4096×4096 one and costs CI a sixty-fourth as much.
    // Cell (7, 5) spot-checked for uniformity, so a large scale is still pixel
    // replication and not a resampler that only shows up past some threshold.
    const cell = [
      ...parseHex(SOLID_BLOCK.palette.colors[charIndex(SOLID_BLOCK.rows[5][7])]),
      255,
    ].join(",");
    const seen = new Set<string>();
    for (let dy = 0; dy < 32; dy++) {
      for (let dx = 0; dx < 32; dx++) {
        seen.add(pixelAt(png, 7 * 32 + dx, 5 * 32 + dy).join(","));
      }
    }
    expect([...seen]).toEqual([cell]);
  });

  it("rejects zero, negatives, fractions and non-finite values", () => {
    for (const bad of [0, -1, -8, 0.5, 1.5, 2.000001, NaN, Infinity, -Infinity]) {
      expect(() => toPng(SPRITE_32, bad)).toThrow(/scale/i);
    }
  });

  it("throws a RangeError rather than a bare Error", () => {
    expect(() => toPng(SPRITE_32, 0)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------

describe("toPng — purity", () => {
  it("does not mutate the document it renders", () => {
    const before = structuredClone(SPRITE_32);
    toPng(SPRITE_32, 4);
    toPng(SPRITE_32, 4, "#ff00ff");
    expect(SPRITE_32).toEqual(before);
  });

  it("is deterministic — the same document renders to the same bytes", () => {
    expect(toPng(SPRITE_32, 8).equals(toPng(SPRITE_32, 8))).toBe(true);
  });

  it("renders every fixture at 1× and 2× without throwing", () => {
    for (const [, doc] of FIXTURE_ENTRIES) {
      expectMatchesDoc(toPng(doc, 1), doc, 1);
      expectMatchesDoc(toPng(doc, 2), doc, 2);
    }
  });

  it("refuses a document whose rows name an index its palette lacks", () => {
    // Unreachable through `SpriteDocSchema`, which rejects an off-palette row
    // character, so the document has to be built by hand. Worth a guard anyway:
    // the alternatives are `undefined` reaching `hexToRgb` — which yields
    // `NaN` channels and a silently wrong colour — or a hole rendered into both
    // the export and the critic's image, where the critic reports it back as an
    // artistic flaw.
    const broken = structuredClone(SOLID_BLOCK) as SpriteDoc;
    expect(broken.palette.colors).toHaveLength(4);
    broken.rows[0] = "f".repeat(16);

    expect(() => toPng(broken, 1)).toThrow(RangeError);
    expect(() => toPng(broken, 1)).toThrow(/palette index 15/);
    expect(() => pickCriticBackground(broken)).toThrow(/palette index 15/);
  });
});

// ---------------------------------------------------------------------------
// pickCriticBackground
// ---------------------------------------------------------------------------

describe("pickCriticBackground (spec §4.5)", () => {
  it("picks white for a sprite whose used entries are all dark", () => {
    // `SPRITE_32` uses pico-8 3, 4, 5 and b — luminance 0.098 to 0.558.
    expect(pickCriticBackground(SPRITE_32)).toBe("#ffffff");
  });

  it("picks black for a sprite whose only used entry is white", () => {
    // The case that proves the search is not biased toward light backgrounds.
    // `WHITE_ONLY` uses `test-struct` index 3, `#ffffff`, and nothing else.
    expect(pickCriticBackground(WHITE_ONLY)).toBe("#000000");
  });

  it("picks a mid grey when the used entries occupy both ends", () => {
    // `CORNER_PALETTE` uses all four `test-struct` entries: black, red, green,
    // white. Neither end of the ramp is far from all of them, so the answer is
    // in the middle — which a black-or-white implementation cannot produce.
    expect(pickCriticBackground(CORNER_PALETTE)).toBe("#b5b5b5");
  });

  it("considers only the entries the sprite uses, not the whole palette", () => {
    // `LOW_CONTRAST_PAIR` is drawn entirely in `test-contrast` 2 and 3, two mid
    // greys, while the palette also carries black and white. Against the used
    // pair the best background is white; against the whole palette it is
    // `#cccccc`. This is the assertion that separates the two readings.
    expect(usedColors(LOW_CONTRAST_PAIR)).toEqual(["#767676", "#7c7c7c"]);
    expect(bestGreyFor([...LOW_CONTRAST_PAIR.palette.colors])).toBe("#cccccc");
    expect(pickCriticBackground(LOW_CONTRAST_PAIR)).toBe("#ffffff");
  });

  it("separates used from unused at the far end of the ramp too", () => {
    // `WHITE_ONLY` again, from the other direction: its palette's whole-palette
    // answer is a mid grey, so a renderer reading `palette.colors` instead of
    // the rows lands 181 grey levels away from the right answer.
    expect(bestGreyFor([...WHITE_ONLY.palette.colors])).toBe("#b5b5b5");
    expect(pickCriticBackground(WHITE_ONLY)).toBe("#000000");
  });

  it("counts index 0 — the outline colour §4.5 is about", () => {
    // `BLACK_OUTLINE` uses `test-struct` 0 and 3, black and white. Skip index 0
    // and the used set is {white}, whose furthest background is **black** — and
    // the outline vanishes into it, which is the exact failure §4.5 exists to
    // prevent. Counting it gives the mid grey both ends can be seen against.
    expect(usedColors(BLACK_OUTLINE)).toEqual(["#000000", "#ffffff"]);
    expect(bestGreyFor(["#ffffff"])).toBe("#000000");
    expect(pickCriticBackground(BLACK_OUTLINE)).toBe("#bcbcbc");
  });

  it("returns white for a sprite with no used entries at all", () => {
    // Nothing to be distant from. White rather than black because §4.5's
    // failure mode is a dark sprite vanishing into a dark field, and a blank
    // canvas should read as blank rather than as an image that failed to load.
    expect(pickCriticBackground(BLANK)).toBe("#ffffff");
  });

  it("returns a lowercase #rrggbb colour for every fixture", () => {
    const wrong = FIXTURE_ENTRIES.filter(
      ([, doc]) => !/^#[0-9a-f]{6}$/.test(pickCriticBackground(doc)),
    ).map(([name, doc]) => `${name} → ${pickCriticBackground(doc)}`);
    expect(wrong).toEqual([]);
  });

  it("maximises the minimum luminance distance to the used entries", () => {
    // The spec property itself, brute-forced independently for every fixture:
    // no other grey is further from everything the sprite draws with.
    const beaten: string[] = [];
    const tied: string[] = [];
    for (const [name, doc] of FIXTURE_ENTRIES) {
      const colors = usedColors(doc);
      if (colors.length === 0) continue;
      const chosen = pickCriticBackground(doc);
      const chosenDistance = minDistance(chosen, colors);
      for (let g = 0; g < 256; g++) {
        const candidate = `#${g.toString(16).padStart(2, "0").repeat(3)}`;
        const distance = minDistance(candidate, colors);
        if (distance > chosenDistance) {
          beaten.push(
            `${name}: ${candidate} (${distance.toFixed(4)}) beats ` +
              `${chosen} (${chosenDistance.toFixed(4)})`,
          );
        }
        // The winner is unique for every fixture, which is why the tie-break
        // rule is unobservable: two candidates would have to be equidistant to
        // the last bit of a double. Recorded rather than asserted away, so that
        // a future fixture that *does* tie shows up here instead of quietly
        // making the choice arbitrary.
        if (candidate !== chosen && distance === chosenDistance) {
          tied.push(`${name}: ${candidate} ties ${chosen}`);
        }
      }
      expect(chosen).toBe(bestGreyFor(colors));
    }
    expect(beaten).toEqual([]);
    expect(tied).toEqual([]);
  });

  it("never returns a colour a used entry could be confused with", () => {
    // Every fixture clears the `low-contrast` threshold against the background
    // it is handed, which is the whole point of compositing.
    const tooClose: string[] = [];
    for (const [name, doc] of FIXTURE_ENTRIES) {
      const colors = usedColors(doc);
      if (colors.length === 0) continue;
      const distance = minDistance(pickCriticBackground(doc), colors);
      if (distance < 0.08) tooClose.push(`${name}: ${distance.toFixed(4)}`);
    }
    expect(tooClose).toEqual([]);
  });

  it("is deterministic and does not mutate the document", () => {
    const before = structuredClone(SPRITE_64);
    expect(pickCriticBackground(SPRITE_64)).toBe(pickCriticBackground(SPRITE_64));
    expect(SPRITE_64).toEqual(before);
  });

  it("hands `toPng` a colour it accepts", () => {
    // The two functions are used together in Wave 7 and nowhere else; a picked
    // colour `toPng` rejected would not surface until then.
    const background = pickCriticBackground(SPRITE_32);
    expectMatchesDoc(toPng(SPRITE_32, 2, background), SPRITE_32, 2, background);
  });
});

// ---------------------------------------------------------------------------
// golden file
// ---------------------------------------------------------------------------

describe("golden file — tests/fixtures/golden/sprite-32-8x.png", () => {
  it("exists in the repository", () => {
    // Deliberately not a write-then-compare: this test must go red when the
    // golden is deleted, not silently mint a new one and pass.
    expect(existsSync(GOLDEN_PATH)).toBe(true);
  });

  it("is byte-identical to a fresh render of SPRITE_32 at 8×", () => {
    const golden = readFileSync(GOLDEN_PATH);
    const rendered = toPng(SPRITE_32, 8);
    expect(rendered.length).toBe(golden.length);
    expect(rendered.equals(golden)).toBe(true);
  });

  it("decodes to the document it claims to hold", () => {
    // Byte equality alone would keep a golden that is wrong in the same way the
    // renderer is. This checks the committed file against the fixture.
    expectMatchesDoc(readFileSync(GOLDEN_PATH), SPRITE_32, 8);
  });

  it("is stable across repeated renders in one process", () => {
    const first = toPng(SPRITE_32, 8);
    const second = toPng(SPRITE_32, 8);
    expect(first.equals(second)).toBe(true);
    expect(first.equals(readFileSync(GOLDEN_PATH))).toBe(true);
  });
});
