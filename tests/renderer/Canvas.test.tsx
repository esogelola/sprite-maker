// @vitest-environment jsdom
/**
 * The editor surface — spec §4.5, §8; plan Wave 11.
 *
 * The environment docblock above is load-bearing. `vitest.config.ts` sets
 * `environment: "node"`, which is correct for every other suite in this project
 * — main, shared and the stubs all run without a DOM, and switching the default
 * would slow all of them down to give four files a `document`. The per-file
 * docblock is the mechanism Vitest provides for exactly this, and it keeps the
 * config file out of Wave 11's whitelist.
 *
 * Five properties this file exists to pin, each one a defect that has already
 * happened in this project or in the design it is built from:
 *
 * **1. Transparent and palette index 0 must not look the same** (spec §4.5).
 * `pico-8` index 0 *is* `#000000`, and the capture at
 * `captures/2026-07-29-transparency-vlm-probe.txt` records the critic reporting
 * a half-transparent, half-black image as "both halves are identical black
 * backgrounds". That confusion cost the critic its silhouette; rendering it back
 * to the *user* would cost them the ability to see what they are editing. The
 * assertion is on rendered colour, not on a class name.
 *
 * **2. The canvas shows the SELECTED round, not the last one.** This is the
 * reason the wave exists: headless runs measured the revise stage degrading the
 * draft (symmetry 0.955 → 0.410, coverage 0.297 → 0.133), and §9's mitigation
 * for "revise makes the sprite worse" is "any round may be accepted — the
 * filmstrip is the mitigation". A canvas wired to `rounds[rounds.length - 1]`
 * renders a filmstrip that scrubs nothing.
 *
 * **3. `selectedRound: 0` and `activeIndex: "0"` are values, not absences.**
 * Round 0 is the draft and the default selection; index `"0"` is black, the most
 * common outline colour there is. `main/ipc.ts` already carries a whole rule
 * about the first of these; both are probed here explicitly, because a falsy
 * check reads either as "nothing selected".
 *
 * **4. The palette bar shows the DOCUMENT's palette.** `SpriteDoc.palette` is a
 * snapshot taken so a saved sprite renders standalone (§6.2), and a 4-colour
 * `gameboy` document must not be offered sixteen `pico-8` swatches — twelve of
 * which `shared/grid.ts` would reject as off-palette on the way back in.
 *
 * **5. A hand edit round-trips through main.** §8: "a renderer-local edit would
 * be invisible to export, history and the critic, which in v1 meant hand-editing
 * then exporting produced a PNG without the edits and without an error." So the
 * click calls `setPixel` and the surface re-reads the session rather than
 * trusting its own copy.
 *
 * Everything here runs against a scripted `window.api`. The live equivalent is
 * `e2e/canvas.spec.ts`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HarnessConfigSchema,
  LintReportSchema,
  RoundSchema,
  SessionHistorySchema,
  SpriteDocSchema,
  type PipelineEvent,
  type Round,
  type SessionHistory,
  type SpriteDoc,
} from "@shared/schema";

import { App } from "../../src/renderer/App";
import { Canvas, cellSizePx } from "../../src/renderer/components/Canvas";
import { Filmstrip } from "../../src/renderer/components/Filmstrip";
import { PaletteBar } from "../../src/renderer/components/PaletteBar";
import { editorStore } from "../../src/renderer/state/store";
import type { Api } from "../../src/preload/index";

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

/**
 * `pico-8`, whose index 0 is `#000000` — the palette property §4.5 is about.
 * Spelled here rather than imported from `tests/fixtures/sprites.ts` so the
 * transparency assertions read against a literal `#000000`.
 */
const PICO_8 = {
  id: "pico-8",
  colors: [
    "#000000", // 0  black — indistinguishable from transparency when composited
    "#1d2b53",
    "#7e2553",
    "#008751",
    "#ab5236",
    "#5f574f",
    "#c2c3c7",
    "#fff1e8",
    "#ff004d",
    "#ffa300",
    "#ffec27",
    "#00e436",
    "#29adff",
    "#83769c",
    "#ff77a8",
    "#ffccaa",
  ],
};

/** The real 4-entry `gameboy` ramp — twelve short of `pico-8`, which is the point. */
const GAMEBOY = { id: "gameboy", colors: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"] };

function doc(
  id: string,
  size: 16 | 32 | 64,
  rows: string[],
  palette: { id: string; colors: string[] } = PICO_8,
  round = 1,
): SpriteDoc {
  return SpriteDocSchema.parse({
    schemaVersion: 1,
    id,
    createdAt: "2026-07-30T00:00:00.000Z",
    prompt: "a dog standing",
    intent: { subject: "a dog standing" },
    size: { w: size, h: size },
    palette,
    rows,
    meta: {
      generatorModel: "qwen3-vl:8b-instruct-q4_K_M",
      criticModel: "qwen3-vl:8b-instruct-q4_K_M",
      round,
      repairs: 0,
      repairedRows: [],
      parentId: null,
    },
  });
}

/** `n` transparent rows of `n` cells. */
const blank = (n: number): string[] => Array.from({ length: n }, () => ".".repeat(n));

/**
 * A 16×16 whose row 0 reads `0.` then transparency — index 0 hard against `.`,
 * which is §4.5's confusion in the smallest form that shows it.
 *
 * Row 5 carries a lone `4` at x = 3. The coordinates are deliberately unequal:
 * a canvas that transposes x and y paints (5, 3) and every square fixture in the
 * project is blind to it.
 */
const TRANSPARENCY_DOC = doc("dc-transparency", 16, [
  "0...............", //  0  index 0 at (0,0), transparent at (1,0)
  ...blank(16).slice(1, 5),
  "...4............", //  5  (3,5) — not (5,3)
  ...blank(16).slice(6),
]);

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

const EMPTY_LINT = LintReportSchema.parse({
  warnings: [],
  metrics: { coverage: 0.01, paletteUsed: 1, orphanCount: 1, symmetryScore: 1 },
});

function round(n: number, d: SpriteDoc): Round {
  return RoundSchema.parse({
    round: n,
    doc: d,
    lint: EMPTY_LINT,
    critique: null,
    filteredIssues: [],
    diffFromPrev: null,
    userFeedback: null,
    revise: null,
    timings: { draftMs: null, critiqueMs: null, reviseMs: null },
  });
}

/**
 * Three rounds whose row 0 differs in the *first three cells* — `0..`, `.1.`,
 * `..2`.
 *
 * Distinguishable by inspection of three cells, and distinguishable from each
 * *other* rather than merely from blank: a canvas pinned to the last round
 * renders `..2` no matter which frame is clicked, and a canvas pinned to the
 * first renders `0..`. Neither survives asserting all three.
 */
const ROUND_ROWS = ["0...............", ".1..............", "..2............."];

function history(rows: string[] = ROUND_ROWS, acceptedRound: number | null = null): SessionHistory {
  return SessionHistorySchema.parse({
    schemaVersion: 1,
    sessionId: "session-wave-11",
    config: HarnessConfigSchema.parse({}),
    rounds: rows.map((row, i) =>
      round(i + 1, doc(`dc-round-${i + 1}`, 16, [row, ...blank(16).slice(1)], PICO_8, i + 1)),
    ),
    draftFailures: [],
    stopReason: "round-cap",
    finalState: "AWAITING_USER",
    outcome: "completed",
    error: null,
    acceptedRound,
  });
}

// ---------------------------------------------------------------------------
// the scripted window.api
// ---------------------------------------------------------------------------

type Listener = (e: PipelineEvent) => void;

interface Harness {
  api: Api;
  /** Every listener `onEvent` handed back an unsubscriber for. */
  emit(event: PipelineEvent): void;
  setPixel: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  /** What the next `getSession` resolves with. */
  session: SessionHistory | null;
}

function harness(initial: SessionHistory | null = null): Harness {
  const listeners = new Set<Listener>();
  const state: { session: SessionHistory | null } = { session: initial };

  const setPixel = vi.fn(async (roundIndex: number, x: number, y: number, ch: string) => {
    const current = state.session;
    if (current === null) return { ok: false as const, code: "no-session", message: "no session" };
    // The main-process rule, in miniature: an edit to the last round mutates it.
    // Enough of §8 to make the round-trip observable without importing `main/`.
    const rounds = current.rounds.slice();
    const target = rounds[roundIndex];
    const rows = target.doc.rows.slice();
    rows[y] = rows[y].slice(0, x) + ch + rows[y].slice(x + 1);
    rounds[roundIndex] = round(target.round, SpriteDocSchema.parse({ ...target.doc, rows }));
    state.session = SessionHistorySchema.parse({ ...current, rounds });
    return { ok: true as const, value: { doc: rounds[roundIndex].doc, lint: EMPTY_LINT } };
  });

  const getSession = vi.fn(async () => ({ ok: true as const, value: state.session }));
  const run = vi.fn(async () => ({ ok: true as const, value: state.session as SessionHistory }));

  const api = {
    listModels: vi.fn(async () => ({ ok: true as const, value: [] as string[] })),
    getModels: vi.fn(async () => ({ generator: "g", critic: "c" })),
    bindModel: vi.fn(async () => ({ ok: true as const, value: undefined })),
    getConfig: vi.fn(async () => HarnessConfigSchema.parse({})),
    getPalettes: vi.fn(async () => []),
    run,
    applyFeedback: vi.fn(),
    accept: vi.fn(),
    setPixel,
    exportPng: vi.fn(),
    getSessionPath: vi.fn(async () => "/tmp/session.json"),
    getSession,
    onEvent: (cb: Listener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as Api;

  return {
    api,
    emit: (event) => listeners.forEach((l) => l(event)),
    setPixel,
    getSession,
    run,
    get session() {
      return state.session;
    },
    set session(next: SessionHistory | null) {
      state.session = next;
    },
  };
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function cell(x: number, y: number): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="canvas"] [data-x="${x}"][data-y="${y}"]`);
  if (el === null) throw new Error(`no canvas cell at (${x}, ${y})`);
  return el;
}

/** The colour a cell actually paints, resolved through the cascade. */
function fill(el: HTMLElement): string {
  return window.getComputedStyle(el).backgroundColor;
}

/** Row `y` of the canvas, read back out of the DOM as §6.1 characters. */
function renderedRow(y: number, w = 16): string {
  return Array.from({ length: w }, (_, x) => cell(x, y).getAttribute("data-ch") ?? "?").join("");
}

function cells(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="canvas"] [data-x]`));
}

beforeEach(() => {
  editorStore.reset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

describe("Canvas", () => {
  const noop = (): void => {};

  it("renders one cell per pixel at 16, 32 and 64", () => {
    for (const size of [16, 32, 64] as const) {
      // A mark at (1, size - 1) — the bottom row, one column in. The bottom row
      // and the last column are where a loop bound goes wrong, and an asymmetric
      // coordinate is what tells a transposed grid from a correct one.
      const rows = blank(size);
      rows[size - 1] = `.7${".".repeat(size - 2)}`;
      const d = doc(`dc-${size}`, size, rows);

      const { unmount } = render(<Canvas doc={d} activeIndex="0" onPaint={noop} />);

      expect(cells()).toHaveLength(size * size);
      expect(cell(size - 1, size - 1).getAttribute("data-ch")).toBe(".");
      expect(cell(1, size - 1).getAttribute("data-ch")).toBe("7");
      expect(fill(cell(1, size - 1))).toBe("rgb(255, 241, 232)"); // pico-8 '7'
      unmount();
    }
  });

  /**
   * A fixed cell size makes two of the three canvases wrong: at 32px a 64×64
   * sprite is 2048 CSS pixels wide, which is off-screen in a 1280-wide window and
   * is what "renders correctly at 64" actually means.
   */
  it("scales the cell to keep every canvas about the same size on screen", () => {
    expect([16, 32, 64].map(cellSizePx)).toEqual([32, 16, 8]);

    for (const size of [16, 32, 64] as const) {
      const { unmount } = render(
        <Canvas doc={doc(`dc-px-${size}`, size, blank(size))} activeIndex="0" onPaint={noop} />,
      );
      const grid = screen.getByTestId("canvas");
      expect(grid.style.gridTemplateColumns).toBe(`repeat(${size}, ${cellSizePx(size)}px)`);
      expect(cellSizePx(size) * size).toBe(512);
      unmount();
    }
  });

  it("renders every cell with the character the document carries", () => {
    render(<Canvas doc={TRANSPARENCY_DOC} activeIndex="0" onPaint={noop} />);

    expect(renderedRow(0)).toBe(TRANSPARENCY_DOC.rows[0]);
    expect(renderedRow(5)).toBe(TRANSPARENCY_DOC.rows[5]);
  });

  it("paints palette index 0 as the document's own colour for index 0", () => {
    render(<Canvas doc={TRANSPARENCY_DOC} activeIndex="0" onPaint={noop} />);

    expect(fill(cell(0, 0))).toBe("rgb(0, 0, 0)");
  });

  /** Spec §4.5. The one assertion this component was built for. */
  it("does not render a transparent cell as black", () => {
    render(<Canvas doc={TRANSPARENCY_DOC} activeIndex="0" onPaint={noop} />);

    const opaque = cell(0, 0); // '0' — #000000
    const empty = cell(1, 0); // '.' — transparent

    expect(opaque.getAttribute("data-transparent")).toBe("false");
    expect(empty.getAttribute("data-transparent")).toBe("true");
    // Rendered colour, not a class name: the two must not composite the same.
    expect(fill(empty)).not.toBe(fill(opaque));
    // And specifically: the empty cell paints nothing of its own, so the
    // checkerboard behind the grid is what shows through it.
    expect(fill(empty)).toBe("rgba(0, 0, 0, 0)");
  });

  it("puts a checkerboard behind the grid, so an empty cell reads as empty", () => {
    render(<Canvas doc={TRANSPARENCY_DOC} activeIndex="0" onPaint={noop} />);

    const grid = screen.getByTestId("canvas");
    expect(window.getComputedStyle(grid).backgroundImage).toMatch(/gradient/);
  });

  it("reports the clicked cell's own coordinates, never the transpose", () => {
    const onPaint = vi.fn();
    render(<Canvas doc={TRANSPARENCY_DOC} activeIndex="4" onPaint={onPaint} />);

    // (3, 5) holds the only '4' in the document; (5, 3) is transparent.
    expect(cell(3, 5).getAttribute("data-ch")).toBe("4");
    expect(cell(5, 3).getAttribute("data-ch")).toBe(".");

    fireEvent.click(cell(3, 5));

    expect(onPaint).toHaveBeenCalledWith(3, 5, "4");
  });

  /** Falsy-zero, probe 1 of 2. `"0"` is black, the most common outline colour. */
  it("paints with activeIndex '0' rather than treating it as no selection", () => {
    const onPaint = vi.fn();
    render(<Canvas doc={TRANSPARENCY_DOC} activeIndex="0" onPaint={onPaint} />);

    fireEvent.click(cell(7, 9));

    expect(onPaint).toHaveBeenCalledWith(7, 9, "0");
  });

  it("paints with '.' when the eraser is active", () => {
    const onPaint = vi.fn();
    render(<Canvas doc={TRANSPARENCY_DOC} activeIndex="." onPaint={onPaint} />);

    fireEvent.click(cell(0, 0));

    expect(onPaint).toHaveBeenCalledWith(0, 0, ".");
  });

  it("marks the active issue's region and nothing outside it", () => {
    render(
      <Canvas doc={TRANSPARENCY_DOC} activeIndex="0" onPaint={noop} highlight={[2, 4, 5, 6]} />,
    );

    for (const [x, y] of [
      [2, 4],
      [5, 6],
      [3, 5],
    ] as const) {
      expect(cell(x, y).getAttribute("data-highlight")).toBe("true");
    }
    for (const [x, y] of [
      [1, 4],
      [6, 6],
      [2, 3],
      [5, 7],
    ] as const) {
      expect(cell(x, y).getAttribute("data-highlight")).toBe("false");
    }
  });
});

// ---------------------------------------------------------------------------
// PaletteBar
// ---------------------------------------------------------------------------

describe("PaletteBar", () => {
  const noop = (): void => {};

  it("shows the document's palette, not a global default", () => {
    render(<PaletteBar palette={GAMEBOY} activeIndex="0" onSelect={noop} />);

    const swatches = screen.getAllByTestId("swatch");
    // Four colours plus the transparent swatch — never sixteen.
    expect(swatches).toHaveLength(5);
    expect(swatches.map((s) => s.getAttribute("data-index"))).toEqual([".", "0", "1", "2", "3"]);
    expect(fill(swatches[1])).toBe("rgb(15, 56, 15)"); // #0f380f, gameboy's 0
  });

  it("offers every index of a sixteen-colour palette", () => {
    render(<PaletteBar palette={PICO_8} activeIndex="0" onSelect={noop} />);

    const swatches = screen.getAllByTestId("swatch");
    expect(swatches).toHaveLength(17);
    expect(swatches[16].getAttribute("data-index")).toBe("f");
    expect(fill(swatches[16])).toBe("rgb(255, 204, 170)"); // #ffccaa
  });

  /** Falsy-zero, probe 2 of 2. */
  it("marks index '0' as selected rather than reading it as no selection", () => {
    render(<PaletteBar palette={PICO_8} activeIndex="0" onSelect={noop} />);

    const swatches = screen.getAllByTestId("swatch");
    const selected = swatches.filter((s) => s.getAttribute("aria-pressed") === "true");

    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("data-index")).toBe("0");
  });

  it("marks the transparent swatch when the eraser is active", () => {
    render(<PaletteBar palette={PICO_8} activeIndex="." onSelect={noop} />);

    const selected = screen
      .getAllByTestId("swatch")
      .filter((s) => s.getAttribute("aria-pressed") === "true");

    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("data-index")).toBe(".");
  });

  it("reports the chosen index", () => {
    const onSelect = vi.fn();
    render(<PaletteBar palette={PICO_8} activeIndex="0" onSelect={onSelect} />);

    fireEvent.click(screen.getAllByTestId("swatch")[9]); // '8'
    expect(onSelect).toHaveBeenCalledWith("8");

    fireEvent.click(screen.getAllByTestId("swatch")[0]); // transparent
    expect(onSelect).toHaveBeenCalledWith(".");
  });
});

// ---------------------------------------------------------------------------
// Filmstrip
// ---------------------------------------------------------------------------

describe("Filmstrip", () => {
  const noop = (): void => {};
  const rounds = history().rounds;

  it("renders one frame per round, labelled and in round order", () => {
    render(
      <Filmstrip rounds={rounds} selectedRound={0} acceptedRound={null} onSelect={noop} />,
    );

    const frames = screen.getAllByTestId("frame");
    expect(frames).toHaveLength(3);
    // DOM order, not set membership: a filmstrip that scrubs backwards is worse
    // than one that does not scrub at all.
    expect(frames.map((f) => f.getAttribute("data-round"))).toEqual(["1", "2", "3"]);
    expect(frames.map((f) => f.textContent)).toEqual(["1", "2", "3"]);
  });

  /** Falsy-zero again, on the other axis: round 0 is the draft. */
  it("marks selectedRound 0 as the selected frame", () => {
    render(
      <Filmstrip rounds={rounds} selectedRound={0} acceptedRound={null} onSelect={noop} />,
    );

    const selected = screen
      .getAllByTestId("frame")
      .filter((f) => f.getAttribute("aria-current") === "true");

    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("data-round")).toBe("1");
  });

  it("marks a later selected frame", () => {
    render(
      <Filmstrip rounds={rounds} selectedRound={2} acceptedRound={null} onSelect={noop} />,
    );

    const selected = screen
      .getAllByTestId("frame")
      .filter((f) => f.getAttribute("aria-current") === "true");

    expect(selected[0].getAttribute("data-round")).toBe("3");
  });

  /**
   * `acceptedRound` is `Round.round` — 1-based (§6.7) — while `selectedRound` is
   * the 0-based array position. Accepting round 1 must not mark frame 2.
   */
  it("marks the accepted round by its 1-based round number", () => {
    render(
      <Filmstrip rounds={rounds} selectedRound={2} acceptedRound={1} onSelect={noop} />,
    );

    const accepted = screen
      .getAllByTestId("frame")
      .filter((f) => f.getAttribute("data-accepted") === "true");

    expect(accepted).toHaveLength(1);
    expect(accepted[0].getAttribute("data-round")).toBe("1");
  });

  it("marks nothing accepted until the gate is answered", () => {
    render(
      <Filmstrip rounds={rounds} selectedRound={0} acceptedRound={null} onSelect={noop} />,
    );

    expect(
      screen.getAllByTestId("frame").filter((f) => f.getAttribute("data-accepted") === "true"),
    ).toHaveLength(0);
  });

  it("reports the 0-based index of the clicked frame", () => {
    const onSelect = vi.fn();
    render(
      <Filmstrip rounds={rounds} selectedRound={2} acceptedRound={null} onSelect={onSelect} />,
    );

    fireEvent.click(screen.getAllByTestId("frame")[0]);
    expect(onSelect).toHaveBeenCalledWith(0);

    fireEvent.click(screen.getAllByTestId("frame")[2]);
    expect(onSelect).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

describe("editorStore", () => {
  it("starts on the first round with black selected", () => {
    const state = editorStore.getSnapshot();

    expect(state.selectedRound).toBe(0);
    expect(state.activeIndex).toBe("0");
    expect(state.rounds).toEqual([]);
    expect(state.history).toBeNull();
  });

  it("selects round 0 rather than reading it as no selection", () => {
    editorStore.setHistory(history());
    editorStore.selectRound(2);
    expect(editorStore.getSnapshot().selectedRound).toBe(2);

    editorStore.selectRound(0);
    expect(editorStore.getSnapshot().selectedRound).toBe(0);
  });

  it("refuses a round index the session does not have", () => {
    editorStore.setHistory(history());
    editorStore.selectRound(9);
    expect(editorStore.getSnapshot().selectedRound).toBe(0);
  });

  it("appends round snapshots in round order and follows the newest", () => {
    const rounds = history().rounds;
    for (const r of rounds) editorStore.applyRound(r);

    const state = editorStore.getSnapshot();
    expect(state.rounds.map((r) => r.round)).toEqual([1, 2, 3]);
    expect(state.selectedRound).toBe(2);
  });

  it("replaces a round snapshot in place when it is written twice", () => {
    // §6.7: a round is snapshotted at the top of the iteration and replaced once
    // the revise transition completes. Two `round` events, one frame.
    const [first] = history().rounds;
    editorStore.applyRound(first);
    editorStore.applyRound(round(1, doc("dc-replaced", 16, blank(16))));

    const state = editorStore.getSnapshot();
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0].doc.id).toBe("dc-replaced");
  });

  it("leaves a pinned selection alone when a later round arrives", () => {
    const rounds = history().rounds;
    editorStore.applyRound(rounds[0]);
    editorStore.applyRound(rounds[1]);
    editorStore.selectRound(0);
    editorStore.applyRound(rounds[2]);

    expect(editorStore.getSnapshot().selectedRound).toBe(0);
  });

  it("clamps a selection the refreshed history no longer contains", () => {
    editorStore.setHistory(history());
    editorStore.selectRound(2);
    editorStore.setHistory(history(ROUND_ROWS.slice(0, 2)));

    expect(editorStore.getSnapshot().selectedRound).toBe(1);
  });

  it("carries the stop reason off the history", () => {
    editorStore.setHistory(history());
    expect(editorStore.getSnapshot().stopReason).toBe("round-cap");
  });
});

// ---------------------------------------------------------------------------
// App — the wave's reason for existing
// ---------------------------------------------------------------------------

describe("App", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness(history());
    window.api = h.api;
  });

  it("renders no canvas before a session exists", () => {
    window.api = harness(null).api;
    render(<App />);

    expect(screen.queryByTestId("canvas")).toBeNull();
    expect(screen.getByTestId("empty")).toBeDefined();
  });

  it("renders the round a pipeline event delivers", async () => {
    render(<App />);
    const [first] = history().rounds;

    h.emit({ type: "round", snapshot: first });

    await waitFor(() => expect(screen.getByTestId("canvas")).toBeDefined());
    expect(renderedRow(0)).toBe(ROUND_ROWS[0]);
  });

  /**
   * The wave's acceptance criterion 3, and the question the user cannot answer
   * without it: "was round 1 better?"
   */
  it("renders the round the filmstrip selects, not the last one", async () => {
    render(<App />);
    for (const r of history().rounds) h.emit({ type: "round", snapshot: r });

    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));
    // The run has just finished, so the newest round is on screen.
    expect(renderedRow(0)).toBe(ROUND_ROWS[2]);

    fireEvent.click(screen.getAllByTestId("frame")[0]);
    await waitFor(() => expect(renderedRow(0)).toBe(ROUND_ROWS[0]));

    fireEvent.click(screen.getAllByTestId("frame")[1]);
    await waitFor(() => expect(renderedRow(0)).toBe(ROUND_ROWS[1]));

    fireEvent.click(screen.getAllByTestId("frame")[2]);
    await waitFor(() => expect(renderedRow(0)).toBe(ROUND_ROWS[2]));
  });

  it("offers the selected round's own palette", async () => {
    window.api = harness(
      SessionHistorySchema.parse({
        ...history(),
        rounds: [round(1, doc("dc-gb", 16, blank(16), GAMEBOY))],
      }),
    ).api;
    render(<App />);
    fireEvent.click(screen.getByTestId("generate"));

    await waitFor(() => expect(screen.getAllByTestId("swatch")).toHaveLength(5));
  });

  it("paints the clicked cell through Api.setPixel with the active index", async () => {
    render(<App />);
    for (const r of history().rounds) h.emit({ type: "round", snapshot: r });
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));

    fireEvent.click(screen.getAllByTestId("frame")[0]);
    await waitFor(() => expect(renderedRow(0)).toBe(ROUND_ROWS[0]));

    fireEvent.click(screen.getAllByTestId("swatch")[9]); // index '8'
    fireEvent.click(cell(4, 6));

    // roundIndex is the *selected* round, x before y, and the chosen index.
    await waitFor(() => expect(h.setPixel).toHaveBeenCalledWith(0, 4, 6, "8"));
  });

  /**
   * §8's silent-divergence defect, closed. The renderer does not paint its own
   * copy — it re-reads the session and renders what main says is there.
   */
  it("re-reads the session after an edit, so the canvas shows what main holds", async () => {
    render(<App />);
    for (const r of history().rounds) h.emit({ type: "round", snapshot: r });
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));

    fireEvent.click(screen.getAllByTestId("swatch")[9]); // '8'
    fireEvent.click(cell(9, 0));

    await waitFor(() => expect(h.getSession).toHaveBeenCalled());
    await waitFor(() => expect(renderedRow(0)).toBe("..2......8......"));
  });

  it("paints with index '0' when black is the active swatch", async () => {
    render(<App />);
    for (const r of history().rounds) h.emit({ type: "round", snapshot: r });
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));

    // '0' is the default, and never explicitly clicked here: a store that treated
    // it as "nothing selected" would have nothing to paint with.
    fireEvent.click(cell(11, 0));

    await waitFor(() => expect(h.setPixel).toHaveBeenCalledWith(2, 11, 0, "0"));
  });

  it("names the state and the stop reason once the run resolves", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("generate"));

    await waitFor(() => expect(screen.getByTestId("state").textContent).toMatch(/AWAITING_USER/));
    expect(screen.getByTestId("state").textContent).toMatch(/round-cap/);
  });

  it("renders a failure envelope's endpoint", async () => {
    const failing = harness(null);
    (failing.api as unknown as { run: unknown }).run = vi.fn(async () => ({
      ok: false as const,
      code: "ollama-unreachable",
      message: "could not reach Ollama",
      endpoint: "http://127.0.0.1:11434/api/generate",
    }));
    window.api = failing.api;
    render(<App />);

    fireEvent.click(screen.getByTestId("generate"));

    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toMatch(/127\.0\.0\.1:11434/),
    );
  });
});
