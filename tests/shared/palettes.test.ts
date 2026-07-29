import { describe, expect, it } from "vitest";

import { PALETTES, getPalette, listPalettes, type Palette } from "@shared/palettes";

const HEX = /^#[0-9A-Fa-f]{6}$/;
const EXPECTED_IDS = ["pico-8", "db16", "aap-16", "nes-16", "gameboy"] as const;

describe("bundled palette library (spec §6.1a)", () => {
  it("bundles exactly the five specified palettes", () => {
    expect(Object.keys(PALETTES).sort()).toEqual([...EXPECTED_IDS].sort());
    expect(listPalettes()).toHaveLength(5);
  });

  it("bundles the exact entry counts the spec table declares", () => {
    const sizes = Object.fromEntries(
      listPalettes().map((p) => [p.id, p.colors.length]),
    );
    expect(sizes).toEqual({
      "pico-8": 16,
      db16: 16,
      "aap-16": 16,
      "nes-16": 16,
      gameboy: 4,
    });
  });

  it.each(EXPECTED_IDS)("%s carries 4-16 colors, the encoding ceiling", (id) => {
    const p = getPalette(id);
    expect(p.colors.length).toBeGreaterThanOrEqual(4);
    expect(p.colors.length).toBeLessThanOrEqual(16);
  });

  it.each(EXPECTED_IDS)("%s uses only 6-digit hex colors", (id) => {
    for (const c of getPalette(id).colors) expect(c).toMatch(HEX);
  });

  it.each(EXPECTED_IDS)("%s has no duplicate colors", (id) => {
    const colors = getPalette(id).colors.map((c) => c.toLowerCase());
    expect(new Set(colors).size).toBe(colors.length);
  });

  it.each(EXPECTED_IDS)("%s has a non-empty human name and a matching id key", (id) => {
    const p = getPalette(id);
    expect(p.id).toBe(id);
    expect(p.name.length).toBeGreaterThan(0);
    expect(PALETTES[id]).toBe(p);
  });

  it("gameboy is the 4-entry DMG green ramp, not padded to 16", () => {
    expect(getPalette("gameboy").colors).toHaveLength(4);
  });

  it("getPalette throws on an unknown id", () => {
    expect(() => getPalette("nope")).toThrow(/nope/);
  });

  it("listPalettes returns every entry in PALETTES", () => {
    expect(listPalettes().map((p) => p.id).sort()).toEqual(
      Object.keys(PALETTES).sort(),
    );
  });

  it("freezes palette colour arrays against mutation by any consumer", () => {
    const colors = getPalette("gameboy").colors as string[];
    expect(Object.isFrozen(colors)).toBe(true);
    expect(() => colors.push("#ffffff")).toThrow(TypeError);
    expect(getPalette("gameboy").colors).toHaveLength(4);
  });

  it("freezes the palette objects themselves", () => {
    const p = getPalette("pico-8") as { name: string };
    expect(Object.isFrozen(p)).toBe(true);
    expect(() => {
      p.name = "hijacked";
    }).toThrow(TypeError);
    expect(getPalette("pico-8").name).not.toBe("hijacked");
  });

  it("freezes the PALETTES registry against added or swapped entries", () => {
    const reg = PALETTES as Record<string, Palette>;
    expect(Object.isFrozen(reg)).toBe(true);
    expect(() => {
      reg.evil = { id: "evil", name: "evil", colors: ["#000000"] };
    }).toThrow(TypeError);
    expect(Object.keys(PALETTES)).toHaveLength(5);
  });
});
