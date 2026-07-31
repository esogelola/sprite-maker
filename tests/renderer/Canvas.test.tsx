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
  CritiqueReportSchema,
  HarnessConfigSchema,
  IssueSchema,
  LintReportSchema,
  RoundSchema,
  SessionHistorySchema,
  SpriteDocSchema,
  STOP_REASONS,
  type CritiqueReport,
  type Issue,
  type LintReport,
  type PipelineEvent,
  type Round,
  type SessionHistory,
  type SpriteDoc,
  type StopReason,
} from "@shared/schema";

import { App } from "../../src/renderer/App";
import { Canvas, cellSizePx } from "../../src/renderer/components/Canvas";
import { CritiqueDock } from "../../src/renderer/components/CritiqueDock";
import { Filmstrip } from "../../src/renderer/components/Filmstrip";
import { GateBar } from "../../src/renderer/components/GateBar";
import { ModelPickers } from "../../src/renderer/components/ModelPickers";
import { PaletteBar } from "../../src/renderer/components/PaletteBar";
import { PromptBar } from "../../src/renderer/components/PromptBar";
import { ProviderRow } from "../../src/renderer/components/ProviderRow";
import { StatusBar } from "../../src/renderer/components/StatusBar";
import { editorStore } from "../../src/renderer/state/store";
import type { Api, ProviderView } from "../../src/preload/index";

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

function round(n: number, d: SpriteDoc, overrides: Partial<Round> = {}): Round {
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
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// critique and lint fixtures — Wave 12
// ---------------------------------------------------------------------------

/**
 * §6.4's three cells, in one report.
 *
 * `issue-0` is **the** case the twin bars exist for: `confidence 0.98`,
 * `suggestConfidence 0.20` — *definitely wrong, but my fix is a guess*. A dock
 * that renders one number twice makes it indistinguishable from `0.98/0.98`.
 *
 * `issue-2` carries `confidence: 0` and `suggestConfidence: 0`. Both are legal
 * values, both are falsy, and the second is below `confidenceFloor` — so it is
 * the issue the reviser never received, and it is the one a truthiness check
 * renders as blank.
 */
const ISSUES: Issue[] = [
  IssueSchema.parse({
    id: "issue-0",
    region: [2, 4, 5, 6],
    severity: "high",
    issue: "the left eye reads as a smudge at this scale",
    suggest: "add a light pixel inside the eye",
    confidence: 0.98,
    suggestConfidence: 0.2,
  }),
  IssueSchema.parse({
    id: "issue-1",
    region: [0, 0, 1, 1],
    severity: "medium",
    issue: "outline gap on the left flank",
    suggest: "place index 0 at (7, 12)",
    confidence: 0.77,
    suggestConfidence: 0.88,
  }),
  IssueSchema.parse({
    id: "issue-2",
    region: [9, 9, 10, 10],
    severity: "low",
    issue: "a stray pixel floats off the tail",
    suggest: "clear (9, 9)",
    confidence: 0,
    suggestConfidence: 0,
  }),
];

/** What `filterIssues` leaves: `issue-2` dropped, `issue-0`'s guess blanked. */
const FILTERED: Issue[] = [
  IssueSchema.parse({ ...ISSUES[0], suggest: "" }),
  ISSUES[1],
];

const CRITIQUE: CritiqueReport = CritiqueReportSchema.parse({
  readsAs: "a dog, standing, but the face is hard to read",
  matchesIntent: true,
  overall: 4,
  degraded: false,
  issues: ISSUES,
});

/** §6.4's degraded report: the critic could not be parsed twice. */
const DEGRADED: CritiqueReport = CritiqueReportSchema.parse({
  readsAs: null,
  matchesIntent: true,
  overall: null,
  degraded: true,
  issues: [],
});

/** A converged critique — zero issues, and the dock must still render (R2). */
const CONVERGED: CritiqueReport = CritiqueReportSchema.parse({
  readsAs: "a dog, standing, reads clearly",
  matchesIntent: true,
  overall: 3,
  degraded: false,
  issues: [],
});

/**
 * A lint report with something to say — including `orphanCount: 0`, which is a
 * measured fact and not an absence.
 */
const BUSY_LINT: LintReport = LintReportSchema.parse({
  warnings: [
    { code: "orphan-pixel", cells: [[3, 3]], message: "1 orphan pixel" },
    { code: "low-contrast", cells: [[1, 1]], indices: [2, 3], message: "indices 2 and 3" },
    { code: "unused-palette-entry", cells: [], indices: [5], message: "index 5 is unused" },
  ],
  metrics: { coverage: 0.18, paletteUsed: 4, orphanCount: 0, symmetryScore: 0.913 },
});

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
  accept: ReturnType<typeof vi.fn>;
  applyFeedback: ReturnType<typeof vi.fn>;
  exportPng: ReturnType<typeof vi.fn>;
  bindModel: ReturnType<typeof vi.fn>;
  listModels: ReturnType<typeof vi.fn>;
  getModels: ReturnType<typeof vi.fn>;
  /** A16's provider surface. `setProvider` writes through to `getProvider`. */
  getProvider: ReturnType<typeof vi.fn>;
  setProvider: ReturnType<typeof vi.fn>;
  /** What the next `getSession` resolves with. */
  session: SessionHistory | null;
}

/** Amendment A16's default view: Ollama, found by detection, answering. */
const DETECTED_OLLAMA: ProviderView = {
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  source: "detected",
  connected: true,
  error: null,
  probes: [],
  unavailable: [],
};

/** Each provider's documented default, mirrored from `main/provider.ts`. */
const PROVIDER_DEFAULT_URLS: Record<string, string> = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
};

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

  /**
   * `main/pipeline.ts`'s own `accept`, in miniature — and the whole point of the
   * wave: it converts the renderer's **0-based** index into the **1-based**
   * `Round.round` that `acceptedRound` holds (§6.7), rather than storing the
   * index it was handed.
   */
  const accept = vi.fn(async (roundIndex: number) => {
    const current = state.session;
    if (current === null) return { ok: false as const, code: "no-session", message: "no session" };
    const target = current.rounds[roundIndex];
    if (target === undefined) {
      return { ok: false as const, code: "bad-index", message: `no round at ${roundIndex}` };
    }
    state.session = SessionHistorySchema.parse({
      ...current,
      acceptedRound: target.round,
      finalState: "DONE",
    });
    return { ok: true as const, value: state.session };
  });

  const applyFeedback = vi.fn(async (feedback: string, roundIndex: number) => {
    const current = state.session;
    if (current === null) return { ok: false as const, code: "no-session", message: "no session" };
    const rounds = current.rounds.slice();
    rounds[roundIndex] = RoundSchema.parse({ ...rounds[roundIndex], userFeedback: feedback });
    state.session = SessionHistorySchema.parse({ ...current, rounds });
    return { ok: true as const, value: state.session };
  });

  // Wave 10's registered placeholder, verbatim in shape: the handler exists and
  // says so, rather than the channel rejecting with "No handler registered".
  const exportPng = vi.fn(async (roundIndex: number, scale: number) => ({
    ok: false as const,
    code: "not-implemented",
    message: `exportPng(${roundIndex}, ${scale}) is not implemented until Wave 13`,
  }));

  const bindModel = vi.fn(async () => ({ ok: true as const, value: undefined }));

  /**
   * A16's provider surface, with main's own semantics in miniature.
   *
   * `setProvider` writes through, so the App's re-read after a switch sees what
   * a real main would have: an empty base URL means that provider's default —
   * the one rule the renderer must not reimplement, and therefore the one the
   * stub has to honour.
   */
  const providerState: { view: ProviderView } = { view: { ...DETECTED_OLLAMA } };
  const getProvider = vi.fn(async () => ({ ok: true as const, value: providerState.view }));
  const setProvider = vi.fn(async (provider: string, baseUrl: string) => {
    providerState.view = {
      ...providerState.view,
      provider: provider as ProviderView["provider"],
      baseUrl: baseUrl.trim().length === 0 ? PROVIDER_DEFAULT_URLS[provider] : baseUrl,
      source: "configured",
      connected: true,
      error: null,
      probes: [],
      unavailable: [],
    };
    return { ok: true as const, value: providerState.view };
  });

  const listModels = vi.fn(async () => ({ ok: true as const, value: [] as string[] }));
  const getModels = vi.fn(async () => ({ generator: "g", critic: "c" }));

  const api = {
    listModels,
    getModels,
    getProvider,
    setProvider,
    bindModel,
    getConfig: vi.fn(async () => HarnessConfigSchema.parse({})),
    getPalettes: vi.fn(async () => []),
    run,
    applyFeedback,
    accept,
    setPixel,
    exportPng,
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
    accept,
    applyFeedback,
    exportPng,
    bindModel,
    listModels,
    getModels,
    getProvider,
    setProvider,
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

  /**
   * The assertion is that the selection did not *move* — an out-of-range index
   * is ignored, not clamped. It is read back rather than compared against a
   * literal because what the selection happens to be on a freshly adopted
   * session is the next test's subject, not this one's.
   */
  it("refuses a round index the session does not have", () => {
    editorStore.setHistory(history());
    const before = editorStore.getSnapshot().selectedRound;

    editorStore.selectRound(9);

    expect(editorStore.getSnapshot().selectedRound).toBe(before);
  });

  /**
   * A renderer reload finds main still holding a session (§8), and the round the
   * finished run left on screen is the last one — there is no earlier selection
   * to preserve, so decision 4's rule applies at this entry point too.
   */
  it("shows the newest round when it sees a session for the first time", () => {
    editorStore.setHistory(history());
    expect(editorStore.getSnapshot().selectedRound).toBe(2);
  });

  /**
   * …and never afterwards. `accept` and `setPixel` both re-enter `setHistory`,
   * and a canvas that jumps back to the newest round after the user scrubbed to
   * round 1 and accepted it would undo the one thing Wave 12 exists to do.
   */
  it("keeps a scrubbed-back selection when the session is refreshed", () => {
    editorStore.setHistory(history());
    editorStore.selectRound(0);

    editorStore.setHistory(history(ROUND_ROWS, 1));

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

// ===========================================================================
// Wave 12 — the surfaces that make the tool usable
// ===========================================================================

/**
 * Three rounds carrying everything the dock renders.
 *
 * Round 1 is the one the measured evidence says is usually best
 * (`captures/2026-07-30-wave-11-rounds.txt`): symmetry 0.913, critic score 1/5.
 * Round 3 has converged — zero issues — and the dock must still render it (R2).
 */
function critiquedHistory(acceptedRound: number | null = null): SessionHistory {
  const rows = ROUND_ROWS.map((row) => [row, ...blank(16).slice(1)]);
  return SessionHistorySchema.parse({
    schemaVersion: 1,
    sessionId: "session-wave-12",
    config: HarnessConfigSchema.parse({}),
    rounds: [
      round(1, doc("dc-round-1", 16, rows[0], PICO_8, 1), {
        lint: BUSY_LINT,
        critique: CRITIQUE,
        filteredIssues: FILTERED,
        diffFromPrev: null,
        revise: { turns: 8, hitCap: false, summary: "Reduced head size by clearing top row pixels." },
        timings: { draftMs: 6272, critiqueMs: 21715, reviseMs: 25005 },
      }),
      round(2, doc("dc-round-2", 16, rows[1], PICO_8, 2), {
        lint: BUSY_LINT,
        critique: CRITIQUE,
        filteredIssues: FILTERED,
        diffFromPrev: [{ x: 1, y: 0, from: ".", to: "1" }],
        revise: { turns: 5, hitCap: false, summary: "Redrew the head." },
      }),
      round(3, doc("dc-round-3", 16, rows[2], PICO_8, 3), {
        lint: BUSY_LINT,
        critique: CONVERGED,
        filteredIssues: [],
        diffFromPrev: [],
      }),
    ],
    draftFailures: [],
    stopReason: "round-cap",
    finalState: acceptedRound === null ? "AWAITING_USER" : "DONE",
    outcome: "completed",
    error: null,
    acceptedRound,
  });
}

/** The width a confidence bar's fill actually renders at. */
function barFill(el: HTMLElement): string {
  const fillEl = el.querySelector<HTMLElement>("[data-fill]");
  if (fillEl === null) throw new Error("a confidence bar rendered no fill element");
  return fillEl.style.width;
}

function bars(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>('[data-testid="confidence-bar"]'));
}

// ---------------------------------------------------------------------------
// CritiqueDock
// ---------------------------------------------------------------------------

describe("CritiqueDock", () => {
  const noop = (): void => {};
  const H = critiquedHistory();

  it("renders nothing when no round is selected", () => {
    const { container } = render(
      <CritiqueDock round={null} activeIssueId={null} onSelectIssue={noop} />,
    );
    expect(container.firstChild).toBeNull();
  });

  /**
   * Ruling R2, and the mutant this pins: a dock that hides on an empty issue
   * list makes a converged run look identical to one that never critiqued.
   */
  it("renders on a converged round with zero issues, lint block and all", () => {
    render(<CritiqueDock round={H.rounds[2]} activeIssueId={null} onSelectIssue={noop} />);

    expect(screen.getByTestId("dock")).toBeDefined();
    expect(screen.queryAllByTestId("issue")).toHaveLength(0);
    expect(screen.getByTestId("dock").textContent).toMatch(/no high-severity issues|converged/i);
    // §8: the dock renders `Round.lint` — Wave 3 built a linter whose output
    // reached no surface, and an empty issue list is not a reason to hide it.
    expect(screen.getByTestId("lint")).toBeDefined();
  });

  it("renders what the critic said the sprite reads as", () => {
    render(<CritiqueDock round={H.rounds[0]} activeIssueId={null} onSelectIssue={noop} />);

    expect(screen.getByTestId("reads-as").textContent).toMatch(/the face is hard to read/);
  });

  /**
   * §6.4 measured `overall` running 1 → 4 → 3 while symmetry fell 0.913 → 0.493
   * → 0.441. It is the critic's opinion, and the dock must not sell it as a
   * quality score.
   */
  it("labels overall as the critic's own opinion, not a quality score", () => {
    render(<CritiqueDock round={H.rounds[0]} activeIssueId={null} onSelectIssue={noop} />);

    const overall = screen.getByTestId("overall");
    expect(overall.getAttribute("data-overall")).toBe("4");
    expect(overall.textContent).toMatch(/opinion/i);
  });

  it("renders one bar per confidence field, each at its own value", () => {
    render(<CritiqueDock round={H.rounds[0]} activeIssueId={null} onSelectIssue={noop} />);

    const first = screen.getAllByTestId("issue")[0];
    const [problem, fix] = bars(first);

    expect(problem.getAttribute("data-field")).toBe("confidence");
    expect(fix.getAttribute("data-field")).toBe("suggestConfidence");
    expect(problem.getAttribute("data-value")).toBe("0.98");
    expect(fix.getAttribute("data-value")).toBe("0.2");
    expect(barFill(problem)).toBe("98%");
    expect(barFill(fix)).toBe("20%");
  });

  /**
   * §6.4's whole point, as an assertion: *0.98 / 0.20 must not look like
   * 0.98 / 0.98.* A dock rendering `confidence` into both bars passes every
   * other test in this file.
   */
  it("renders 0.98/0.20 visibly differently from 0.98/0.98", () => {
    const twin = round(1, H.rounds[0].doc, {
      critique: CritiqueReportSchema.parse({
        ...CRITIQUE,
        issues: [IssueSchema.parse({ ...ISSUES[0], suggestConfidence: 0.98 })],
      }),
      filteredIssues: [IssueSchema.parse({ ...ISSUES[0], suggestConfidence: 0.98 })],
    });

    const split = render(<CritiqueDock round={H.rounds[0]} activeIssueId={null} onSelectIssue={noop} />);
    const splitBars = bars(screen.getAllByTestId("issue")[0]).map(barFill);
    expect(splitBars[0]).not.toBe(splitBars[1]);
    split.unmount();

    render(<CritiqueDock round={twin} activeIssueId={null} onSelectIssue={noop} />);
    const twinBars = bars(screen.getAllByTestId("issue")[0]).map(barFill);
    expect(twinBars[0]).toBe(twinBars[1]);
    // And the two renderings are not the same picture.
    expect(splitBars.join("/")).not.toBe(twinBars.join("/"));
  });

  /** Falsy zero: `confidence: 0` is a value the critic emitted, not an absence. */
  it("renders a zero confidence as 0.00 rather than as nothing", () => {
    render(<CritiqueDock round={H.rounds[0]} activeIssueId={null} onSelectIssue={noop} />);

    const stray = screen.getAllByTestId("issue")[2];
    const [problem, fix] = bars(stray);

    expect(problem.getAttribute("data-value")).toBe("0");
    expect(problem.textContent).toMatch(/0\.00/);
    expect(barFill(problem)).toBe("0%");
    expect(fix.textContent).toMatch(/0\.00/);
  });

  /**
   * `critique` is raw and `filteredIssues` is what the reviser received (§6.7).
   * An issue below `confidenceFloor` never reached the agent, and saying so is
   * the difference between "the critic mentioned this" and "the loop acted on
   * this".
   */
  it("marks an issue the reviser never received", () => {
    render(<CritiqueDock round={H.rounds[0]} activeIssueId={null} onSelectIssue={noop} />);

    const issues = screen.getAllByTestId("issue");
    expect(issues[0].getAttribute("data-sent")).toBe("true");
    expect(issues[2].getAttribute("data-sent")).toBe("false");
    expect(issues[2].textContent).toMatch(/below the confidence floor|not sent/i);
  });

  /** §6.4: a blanked `suggest` is the signal, and it has to be legible as one. */
  it("says the fix was withheld rather than showing text the agent never got", () => {
    render(<CritiqueDock round={H.rounds[0]} activeIssueId={null} onSelectIssue={noop} />);

    const issues = screen.getAllByTestId("issue");
    expect(issues[0].getAttribute("data-suggest-withheld")).toBe("true");
    expect(issues[0].textContent).not.toMatch(/add a light pixel inside the eye/);
    // The one whose fix cleared the floor still shows it.
    expect(issues[1].getAttribute("data-suggest-withheld")).toBe("false");
    expect(issues[1].textContent).toMatch(/place index 0 at \(7, 12\)/);
  });

  it("reports the clicked issue's id", () => {
    const onSelectIssue = vi.fn();
    render(<CritiqueDock round={H.rounds[0]} activeIssueId={null} onSelectIssue={onSelectIssue} />);

    fireEvent.click(screen.getAllByTestId("issue")[1]);
    expect(onSelectIssue).toHaveBeenCalledWith("issue-1");
  });

  it("marks the active issue and only that one", () => {
    render(<CritiqueDock round={H.rounds[0]} activeIssueId="issue-1" onSelectIssue={noop} />);

    const active = screen.getAllByTestId("issue").filter((i) => i.getAttribute("data-active") === "true");
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute("data-issue-id")).toBe("issue-1");
  });

  it("renders the deterministic lint metrics, including a zero orphan count", () => {
    render(<CritiqueDock round={H.rounds[0]} activeIssueId={null} onSelectIssue={noop} />);

    const lintBlock = screen.getByTestId("lint");
    expect(lintBlock.textContent).toMatch(/0\.913/); // symmetry
    expect(lintBlock.textContent).toMatch(/0\.18/); // coverage
    expect(lintBlock.textContent).toMatch(/4/); // palette entries used
    // Falsy zero: `orphanCount: 0` is a measurement, and a blank is not one.
    const orphans = screen.getByTestId("lint-orphans");
    expect(orphans.getAttribute("data-count")).toBe("0");
    expect(orphans.textContent).toMatch(/0/);
  });

  it("renders every lint warning the round carries, by code", () => {
    render(<CritiqueDock round={H.rounds[0]} activeIssueId={null} onSelectIssue={noop} />);

    const codes = screen.getAllByTestId("lint-warning").map((w) => w.getAttribute("data-code"));
    expect(codes).toEqual(["orphan-pixel", "low-contrast", "unused-palette-entry"]);
  });

  /**
   * Measured: a round claimed it "reduced head size by clearing top row pixels"
   * while adding 44 cells of coloured bands. The prose is the agent's claim; the
   * number beside it is what happened.
   */
  it("labels the revise summary as the agent's claim and puts the diff beside it", () => {
    render(<CritiqueDock round={H.rounds[1]} activeIssueId={null} onSelectIssue={noop} />);

    const claim = screen.getByTestId("revise-claim");
    expect(claim.textContent).toMatch(/Redrew the head/);
    expect(claim.textContent).toMatch(/claim/i);
    expect(screen.getByTestId("diff-count").getAttribute("data-cells")).toBe("1");
  });

  /** Falsy zero on the other axis: a revise that changed nothing changed 0 cells. */
  it("renders an empty diff as 0 cells changed", () => {
    render(<CritiqueDock round={H.rounds[2]} activeIssueId={null} onSelectIssue={noop} />);

    const diff = screen.getByTestId("diff-count");
    expect(diff.getAttribute("data-cells")).toBe("0");
    expect(diff.textContent).toMatch(/0/);
  });

  it("says the critic could not be read when the report is degraded", () => {
    const degraded = round(1, H.rounds[0].doc, { critique: DEGRADED, filteredIssues: [] });
    render(<CritiqueDock round={degraded} activeIssueId={null} onSelectIssue={noop} />);

    expect(screen.getByTestId("dock").textContent).toMatch(/could not be read|degraded/i);
    // Never an invented score.
    expect(screen.queryByTestId("overall")).toBeNull();
  });

  it("still renders the lint block on a round no critic has seen", () => {
    const handEdit = round(4, H.rounds[0].doc, { lint: BUSY_LINT, critique: null });
    render(<CritiqueDock round={handEdit} activeIssueId={null} onSelectIssue={noop} />);

    expect(screen.getByTestId("lint")).toBeDefined();
    expect(screen.getByTestId("dock").textContent).toMatch(/not been critiqued|no critique/i);
  });
});

// ---------------------------------------------------------------------------
// GateBar
// ---------------------------------------------------------------------------

describe("GateBar", () => {
  const noop = (): void => {};
  const props = {
    state: "AWAITING_USER" as const,
    selectedRound: 0,
    roundNumber: 1,
    acceptedRound: null,
    pending: null,
    onAccept: noop,
    onFeedback: noop,
    onExport: noop,
  };

  it("renders at the gate", () => {
    render(<GateBar {...props} />);
    expect(screen.getByTestId("gate")).toBeDefined();
    expect(screen.getByTestId("accept")).toBeDefined();
    expect(screen.getByTestId("export")).toBeDefined();
    expect(screen.getByTestId("feedback")).toBeDefined();
  });

  it("does not render mid-run", () => {
    const { container } = render(<GateBar {...props} state="REVISING" />);
    expect(container.firstChild).toBeNull();
  });

  /**
   * The wave's reason for existing. `selectedRound: 0` is the first round, the
   * measured-best one, and the most common accept target — a truthiness check
   * here reads it as "nothing selected".
   */
  it("accepts the round the filmstrip has selected, including round index 0", () => {
    const onAccept = vi.fn();
    render(<GateBar {...props} selectedRound={0} roundNumber={1} onAccept={onAccept} />);

    fireEvent.click(screen.getByTestId("accept"));
    expect(onAccept).toHaveBeenCalledWith(0);
  });

  it("accepts a later selected round by its own index", () => {
    const onAccept = vi.fn();
    render(<GateBar {...props} selectedRound={2} roundNumber={3} onAccept={onAccept} />);

    fireEvent.click(screen.getByTestId("accept"));
    expect(onAccept).toHaveBeenCalledWith(2);
  });

  it("names the round Accept would keep", () => {
    render(<GateBar {...props} selectedRound={0} roundNumber={1} />);
    expect(screen.getByTestId("accept").textContent).toMatch(/round 1/);
  });

  it("sends feedback against the selected round", () => {
    const onFeedback = vi.fn();
    render(<GateBar {...props} selectedRound={1} roundNumber={2} onFeedback={onFeedback} />);

    fireEvent.change(screen.getByTestId("feedback"), { target: { value: "make the tail fluffier" } });
    fireEvent.click(screen.getByTestId("send-feedback"));

    expect(onFeedback).toHaveBeenCalledWith("make the tail fluffier", 1);
  });

  /** Falsy zero, on the feedback path too: round index 0 is a round. */
  it("sends feedback against round index 0", () => {
    const onFeedback = vi.fn();
    render(<GateBar {...props} selectedRound={0} roundNumber={1} onFeedback={onFeedback} />);

    fireEvent.change(screen.getByTestId("feedback"), { target: { value: "shorter ears" } });
    fireEvent.click(screen.getByTestId("send-feedback"));

    expect(onFeedback).toHaveBeenCalledWith("shorter ears", 0);
  });

  it("exports round index 0", () => {
    const onExport = vi.fn();
    render(<GateBar {...props} selectedRound={0} roundNumber={1} onExport={onExport} />);

    fireEvent.click(screen.getByTestId("export"));
    expect(onExport).toHaveBeenCalledWith(0);
  });

  it("refuses to send empty feedback", () => {
    const onFeedback = vi.fn();
    render(<GateBar {...props} onFeedback={onFeedback} />);

    fireEvent.change(screen.getByTestId("feedback"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("send-feedback"));

    expect(onFeedback).not.toHaveBeenCalled();
  });

  it("exports the selected round", () => {
    const onExport = vi.fn();
    render(<GateBar {...props} selectedRound={2} roundNumber={3} onExport={onExport} />);

    fireEvent.click(screen.getByTestId("export"));
    expect(onExport).toHaveBeenCalledWith(2);
  });

  /**
   * Wave 14's script runs Accept (feature 10) before hand editing (11) and
   * export (12). A gate that vanishes on `DONE` makes the ratified gate
   * unrunnable and leaves the user with no way to export what they just kept.
   */
  it("survives the accept it just recorded, so the sprite can still be exported", () => {
    render(<GateBar {...props} state="DONE" acceptedRound={1} />);

    expect(screen.getByTestId("gate").textContent).toMatch(/round 1/);
    expect(screen.getByTestId("export")).toBeDefined();
  });

  it("stands down while a mutation is in flight", () => {
    render(<GateBar {...props} pending="run" />);

    expect((screen.getByTestId("accept") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("send-feedback") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

describe("StatusBar", () => {
  const base = {
    state: "AWAITING_USER" as const,
    history: null,
    liveRound: 0,
    turn: null,
    failure: null,
  };

  function withStop(stopReason: StopReason): SessionHistory {
    return SessionHistorySchema.parse({ ...critiquedHistory(), stopReason });
  }

  it("names the current state", () => {
    render(<StatusBar {...base} state="REVISING" />);
    expect(screen.getByTestId("state").textContent).toMatch(/REVISING/);
  });

  /**
   * §8: state and stop reason are read from `SessionHistory` so they survive a
   * reload. No event is emitted anywhere in this test.
   */
  it("reads the stop reason off the history, with no events at all", () => {
    render(<StatusBar {...base} history={withStop("round-cap")} />);

    expect(screen.getByTestId("state").textContent).toMatch(/round-cap|round cap/);
  });

  /** All five (§7.2), and each one in words a user can act on. */
  it("explains every stop reason in plain language", () => {
    for (const reason of STOP_REASONS) {
      const view = render(<StatusBar {...base} history={withStop(reason)} />);
      const stop = screen.getByTestId("stop-reason");
      expect(stop.getAttribute("data-reason")).toBe(reason);
      // Not the bare enum echoed back — an explanation beside it.
      expect(stop.textContent!.replace(reason, "").trim().length).toBeGreaterThan(12);
      view.unmount();
    }
  });

  /** Amendment A14, the newest reason and the one a default branch swallows. */
  it("says plainly that a regressed revision was discarded", () => {
    render(<StatusBar {...base} history={withStop("revise-regressed")} />);

    const stop = screen.getByTestId("stop-reason");
    expect(stop.getAttribute("data-reason")).toBe("revise-regressed");
    expect(stop.textContent).toMatch(/discard/i);
    expect(stop.textContent).toMatch(/worse/i);
  });

  it("names the accepted round", () => {
    render(<StatusBar {...base} state="DONE" history={critiquedHistory(1)} />);
    expect(screen.getByTestId("state").textContent).toMatch(/accepted round 1/);
  });

  /**
   * Wave 10b single-flighted the session, and with no cancellation the refusal
   * window is *minutes*. A refusal the UI swallows is exactly the class of
   * defect §8 names: an action that did not happen, reported as if it had.
   */
  it("renders a busy refusal rather than swallowing it", () => {
    render(
      <StatusBar
        {...base}
        failure={{ code: "busy", message: "accept: run is still in flight — one session mutation at a time" }}
      />,
    );

    const error = screen.getByTestId("error");
    expect(error.getAttribute("data-code")).toBe("busy");
    expect(error.textContent).toMatch(/still in flight/);
  });

  it("names the exact endpoint when Ollama is unreachable", () => {
    render(
      <StatusBar
        {...base}
        failure={{
          code: "ollama-unreachable",
          message: "could not reach Ollama",
          endpoint: "http://127.0.0.1:11434/api/generate",
        }}
      />,
    );

    expect(screen.getByTestId("error").textContent).toMatch(/127\.0\.0\.1:11434/);
  });

  it("renders the run failure the history recorded", () => {
    const failed = SessionHistorySchema.parse({
      ...critiquedHistory(),
      outcome: "failed",
      finalState: "FAILED",
      error: "OllamaTimeoutError: qwen3-vl:8b-instruct-q4_K_M timed out after 45000ms",
    });
    render(<StatusBar {...base} state="FAILED" history={failed} />);

    expect(screen.getByTestId("history-error").textContent).toMatch(/timed out after 45000ms/);
  });

  it("shows the revise turn while the longest stage runs", () => {
    render(<StatusBar {...base} state="REVISING" liveRound={2} turn="turn 7 of 40" />);

    expect(screen.getByTestId("state").textContent).toMatch(/turn 7 of 40/);
    expect(screen.getByTestId("state").textContent).toMatch(/round 2/);
  });

  /**
   * …and retires it once the run has settled. "round 3" beside "accepted round
   * 1" reads as the round on screen, which it is not — the filmstrip says that,
   * and the round *count* says how many there were.
   */
  it("stops naming the live round once the run has settled", () => {
    render(<StatusBar {...base} state="DONE" history={critiquedHistory(1)} liveRound={3} />);

    const text = screen.getByTestId("state").textContent!;
    expect(text).toMatch(/3 rounds/);
    expect(text).toMatch(/accepted round 1/);
    expect(text).not.toMatch(/· round 3/);
  });
});

// ---------------------------------------------------------------------------
// ModelPickers
// ---------------------------------------------------------------------------

describe("ModelPickers", () => {
  const noop = (): void => {};
  const INSTALLED = ["qwen3-vl:8b-instruct-q4_K_M", "qwen3:8b", "llama3.2:3b"];
  const DEFAULT_MODEL = "qwen3-vl:8b-instruct-q4_K_M";

  it("offers every installed model for both roles", () => {
    render(
      <ModelPickers
        installed={INSTALLED}
        bound={{ generator: DEFAULT_MODEL, critic: DEFAULT_MODEL }}
        onBind={noop}
      />,
    );

    for (const id of ["model-generator", "model-critic"]) {
      const select = screen.getByTestId(id) as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toEqual(INSTALLED);
    }
  });

  /** §6.8's shipped default, for both roles (amendment A10). */
  it("shows the bound model as the selected one", () => {
    render(
      <ModelPickers
        installed={INSTALLED}
        bound={{ generator: DEFAULT_MODEL, critic: "qwen3:8b" }}
        onBind={noop}
      />,
    );

    expect((screen.getByTestId("model-generator") as HTMLSelectElement).value).toBe(DEFAULT_MODEL);
    expect((screen.getByTestId("model-critic") as HTMLSelectElement).value).toBe("qwen3:8b");
  });

  it("reports the role and the model chosen", () => {
    const onBind = vi.fn();
    render(
      <ModelPickers
        installed={INSTALLED}
        bound={{ generator: DEFAULT_MODEL, critic: DEFAULT_MODEL }}
        onBind={onBind}
      />,
    );

    fireEvent.change(screen.getByTestId("model-critic"), { target: { value: "qwen3:8b" } });
    expect(onBind).toHaveBeenCalledWith("critic", "qwen3:8b");
  });

  /**
   * §9: "if one disappears mid-session, fail the round naming the model". A
   * picker that silently drops the bound model shows a value that is not what
   * the next run will call, which is a lie rather than a missing option.
   */
  it("still shows a bound model Ollama no longer has", () => {
    render(
      <ModelPickers
        installed={INSTALLED}
        bound={{ generator: "qwen3-vl:30b-a3b", critic: DEFAULT_MODEL }}
        onBind={noop}
      />,
    );

    const select = screen.getByTestId("model-generator") as HTMLSelectElement;
    expect(select.value).toBe("qwen3-vl:30b-a3b");
    expect(select.textContent).toMatch(/not installed/i);
  });

  it("says so while the model list is still unknown", () => {
    render(<ModelPickers installed={[]} bound={null} onBind={noop} />);
    expect(screen.getByTestId("models-unavailable")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PromptBar
// ---------------------------------------------------------------------------

describe("PromptBar", () => {
  const noop = (): void => {};
  const PALETTES = [
    { id: "pico-8", name: "PICO-8", colors: [] as string[] },
    { id: "gameboy", name: "Game Boy", colors: [] as string[] },
  ];
  const props = {
    prompt: "a dog standing",
    onPromptChange: noop,
    size: 16 as const,
    onSizeChange: noop,
    paletteId: "pico-8",
    onPaletteChange: noop,
    palettes: PALETTES,
    pending: null,
    blocked: null,
    onGenerate: noop,
  };

  it("offers the three canvas sizes §6.2 permits", () => {
    render(<PromptBar {...props} />);
    const select = screen.getByTestId("size") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["16", "32", "64"]);
    expect(select.value).toBe("16");
  });

  it("offers the palette library", () => {
    render(<PromptBar {...props} />);
    const select = screen.getByTestId("palette-picker") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["pico-8", "gameboy"]);
  });

  it("reports a new size as a number, not a string", () => {
    const onSizeChange = vi.fn();
    render(<PromptBar {...props} onSizeChange={onSizeChange} />);

    fireEvent.change(screen.getByTestId("size"), { target: { value: "64" } });
    expect(onSizeChange).toHaveBeenCalledWith(64);
  });

  it("reports a new palette", () => {
    const onPaletteChange = vi.fn();
    render(<PromptBar {...props} onPaletteChange={onPaletteChange} />);

    fireEvent.change(screen.getByTestId("palette-picker"), { target: { value: "gameboy" } });
    expect(onPaletteChange).toHaveBeenCalledWith("gameboy");
  });

  it("refuses to generate from an empty prompt", () => {
    render(<PromptBar {...props} prompt="   " />);
    expect((screen.getByTestId("generate") as HTMLButtonElement).disabled).toBe(true);
  });

  /** §8: Generate is disabled when Ollama is unreachable. No silent fallback. */
  it("refuses to generate while Ollama is unreachable", () => {
    render(<PromptBar {...props} blocked="Ollama is unreachable at http://127.0.0.1:11434" />);
    expect((screen.getByTestId("generate") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the store — Wave 12 additions
// ---------------------------------------------------------------------------

describe("editorStore — the active issue", () => {
  it("starts with no issue selected", () => {
    expect(editorStore.getSnapshot().activeIssueId).toBeNull();
  });

  it("selects and clears an issue", () => {
    editorStore.selectIssue("issue-1");
    expect(editorStore.getSnapshot().activeIssueId).toBe("issue-1");

    editorStore.selectIssue(null);
    expect(editorStore.getSnapshot().activeIssueId).toBeNull();
  });

  /**
   * An issue belongs to one round's critique, and ids are synthesized from the
   * issue's index (`issue-0`, `issue-1`, …) — so the same id exists in every
   * round and means something different in each. Carrying a selection across a
   * scrub highlights a region the user never clicked.
   */
  it("drops the active issue when the filmstrip moves", () => {
    editorStore.setHistory(critiquedHistory());
    editorStore.selectIssue("issue-0");
    editorStore.selectRound(2);

    expect(editorStore.getSnapshot().activeIssueId).toBeNull();
  });

  it("adopts the pipeline state the history records, so a reload keeps it", () => {
    editorStore.setHistory(critiquedHistory(1));

    expect(editorStore.getSnapshot().pipelineState).toBe("DONE");
    expect(editorStore.getSnapshot().history!.acceptedRound).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// App — Wave 12: the gate, the dock and the highlight
// ---------------------------------------------------------------------------

describe("App — the gate", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness(critiquedHistory());
    window.api = h.api;
  });

  /** The wave's acceptance criterion 2, and the defect that makes it pointless. */
  it("accepts the round the filmstrip has selected, not the last one", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));

    // Scrub back to round 1 — the round measured best in this project's own run.
    fireEvent.click(screen.getAllByTestId("frame")[0]);
    await waitFor(() => expect(renderedRow(0)).toBe(ROUND_ROWS[0]));

    fireEvent.click(screen.getByTestId("accept"));

    // 0, the array index — not `rounds.length - 1`, and not skipped as falsy.
    await waitFor(() => expect(h.accept).toHaveBeenCalledWith(0));
    // And what came back is 1-based `Round.round`, on the frame it belongs to.
    await waitFor(() =>
      expect(
        screen.getAllByTestId("frame").filter((f) => f.getAttribute("data-accepted") === "true"),
      ).toHaveLength(1),
    );
    expect(
      screen
        .getAllByTestId("frame")
        .filter((f) => f.getAttribute("data-accepted") === "true")[0]
        .getAttribute("data-round"),
    ).toBe("1");
    expect(h.session!.acceptedRound).toBe(1);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toMatch(/DONE/));
  });

  it("accepts a later round by its own index", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));

    fireEvent.click(screen.getAllByTestId("frame")[2]);
    await waitFor(() => expect(renderedRow(0)).toBe(ROUND_ROWS[2]));

    fireEvent.click(screen.getByTestId("accept"));

    await waitFor(() => expect(h.accept).toHaveBeenCalledWith(2));
    await waitFor(() => expect(h.session!.acceptedRound).toBe(3));
  });

  /** Wave 10b's refusal, rendered. The renderer is not the authority (rule 5). */
  it("renders a busy refusal from Accept instead of swallowing it", async () => {
    (h.api as unknown as { accept: unknown }).accept = vi.fn(async () => ({
      ok: false as const,
      code: "busy",
      message: "accept: run is still in flight — one session mutation at a time",
    }));
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));

    fireEvent.click(screen.getByTestId("accept"));

    await waitFor(() => expect(screen.getByTestId("error").getAttribute("data-code")).toBe("busy"));
    expect(screen.getByTestId("error").textContent).toMatch(/still in flight/);
    // And nothing was marked accepted on the strength of a refusal.
    expect(
      screen.getAllByTestId("frame").filter((f) => f.getAttribute("data-accepted") === "true"),
    ).toHaveLength(0);
  });

  /**
   * `main/ipc.ts` rule 5 is the authority and answers `busy`; this is the
   * courtesy half — while a mutation is in flight the gate says so and stands
   * down, rather than inviting a second click that can only be refused.
   */
  it("stands the gate down while main is holding the session", async () => {
    let release: (value: { ok: true; value: SessionHistory }) => void = () => {};
    const held = new Promise<{ ok: true; value: SessionHistory }>((resolve) => {
      release = resolve;
    });
    (h.api as unknown as { accept: unknown }).accept = vi.fn(() => held);

    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));
    expect((screen.getByTestId("accept") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("accept"));

    await waitFor(() =>
      expect((screen.getByTestId("accept") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByTestId("gate-pending").textContent).toMatch(/accept/);

    release({ ok: true, value: critiquedHistory(3) });
    await waitFor(() =>
      expect((screen.getByTestId("accept") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("sends feedback against the selected round", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));

    fireEvent.click(screen.getAllByTestId("frame")[1]);
    await waitFor(() => expect(renderedRow(0)).toBe(ROUND_ROWS[1]));

    fireEvent.change(screen.getByTestId("feedback"), { target: { value: "longer legs" } });
    fireEvent.click(screen.getByTestId("send-feedback"));

    await waitFor(() => expect(h.applyFeedback).toHaveBeenCalledWith("longer legs", 1));
  });

  /** Wave 13 builds it; until then the honest answer is that it did not happen. */
  it("surfaces Export's not-implemented answer rather than pretending", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));

    fireEvent.click(screen.getByTestId("export"));

    await waitFor(() => expect(h.exportPng).toHaveBeenCalledWith(2, 8));
    await waitFor(() =>
      expect(screen.getByTestId("error").getAttribute("data-code")).toBe("not-implemented"),
    );
  });
});

describe("App — the dock", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness(critiquedHistory());
    window.api = h.api;
  });

  it("renders the selected round's critique and lint", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("dock")).toBeDefined());

    expect(screen.getByTestId("lint")).toBeDefined();
  });

  /** §8: clicking an issue highlights its region on the canvas. */
  it("highlights the clicked issue's region on the canvas", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));

    fireEvent.click(screen.getAllByTestId("frame")[0]);
    await waitFor(() => expect(screen.getAllByTestId("issue")).toHaveLength(3));

    // Nothing lit before the click.
    expect(cell(3, 5).getAttribute("data-highlight")).toBe("false");

    fireEvent.click(screen.getAllByTestId("issue")[0]); // region [2, 4, 5, 6]

    await waitFor(() => expect(cell(3, 5).getAttribute("data-highlight")).toBe("true"));
    expect(cell(2, 4).getAttribute("data-highlight")).toBe("true");
    expect(cell(5, 6).getAttribute("data-highlight")).toBe("true");
    expect(cell(6, 6).getAttribute("data-highlight")).toBe("false");
    expect(cell(1, 4).getAttribute("data-highlight")).toBe("false");
  });

  it("clears the highlight when the same issue is clicked again", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));
    fireEvent.click(screen.getAllByTestId("frame")[0]);
    await waitFor(() => expect(screen.getAllByTestId("issue")).toHaveLength(3));

    fireEvent.click(screen.getAllByTestId("issue")[0]);
    await waitFor(() => expect(cell(3, 5).getAttribute("data-highlight")).toBe("true"));

    fireEvent.click(screen.getAllByTestId("issue")[0]);
    await waitFor(() => expect(cell(3, 5).getAttribute("data-highlight")).toBe("false"));
  });

  it("drops the highlight when the filmstrip moves to another round", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));
    fireEvent.click(screen.getAllByTestId("frame")[0]);
    await waitFor(() => expect(screen.getAllByTestId("issue")).toHaveLength(3));

    fireEvent.click(screen.getAllByTestId("issue")[0]);
    await waitFor(() => expect(cell(3, 5).getAttribute("data-highlight")).toBe("true"));

    fireEvent.click(screen.getAllByTestId("frame")[2]);
    await waitFor(() => expect(cell(3, 5).getAttribute("data-highlight")).toBe("false"));
  });
});

describe("App — reload survival", () => {
  it("adopts the session main is still holding, with no events at all", async () => {
    const h = harness(critiquedHistory(1));
    window.api = h.api;
    render(<App />);

    // Nothing was generated in this renderer, and no event was emitted.
    await waitFor(() => expect(screen.getAllByTestId("frame")).toHaveLength(3));
    expect(h.run).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toMatch(/DONE/);
    expect(screen.getByTestId("stop-reason").getAttribute("data-reason")).toBe("round-cap");
    expect(screen.getByTestId("state").textContent).toMatch(/accepted round 1/);
  });

  it("shows the first-run empty state when main holds nothing", async () => {
    window.api = harness(null).api;
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("empty")).toBeDefined());
    expect(screen.queryByTestId("dock")).toBeNull();
    expect(screen.queryByTestId("gate")).toBeNull();
    expect(screen.getByTestId("filmstrip-empty")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ProviderRow — amendment A16
// ---------------------------------------------------------------------------

/**
 * The provider row, beside the model pickers.
 *
 * §8's bar was `[prompt……] [Generate] [32▾] [pico-8▾] [models▾]`, and A16 adds
 * the question that comes before all of them: *which server is this talking to,
 * and is it there?* The row exists because detection is invisible otherwise — a
 * cobuilder whose app found LM Studio at 1234 has no way to confirm it did,
 * and a cobuilder whose app found nothing has no way to point it anywhere
 * without editing an environment variable and restarting, which is the
 * workaround this whole amendment exists to delete.
 *
 * Presentational, like every other component here (§5.1): it reports a chosen
 * provider and URL and renders whatever main answered. It does not call
 * `Api.setProvider` itself, because the answer is a `Result` the status bar has
 * to be able to render — including `busy`.
 */
describe("ProviderRow", () => {
  const noop = (): void => {};

  const view = (patch: Partial<ProviderView> = {}): ProviderView => ({
    ...DETECTED_OLLAMA,
    ...patch,
  });

  it("says nothing until main has answered", () => {
    render(<ProviderRow view={null} onSelect={noop} />);
    // Not a select defaulted to `ollama`: that is a claim, and before
    // `getProvider` resolves nobody has made it.
    expect(screen.queryByTestId("provider-select")).toBeNull();
    expect(screen.getByTestId("provider-pending")).toBeDefined();
  });

  it("offers both providers and selects the live one", () => {
    render(<ProviderRow view={view({ provider: "lmstudio" })} onSelect={noop} />);

    const select = screen.getByTestId("provider-select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["ollama", "lmstudio"]);
    expect(select.value).toBe("lmstudio");
  });

  it("shows the base URL in an editable field", () => {
    render(<ProviderRow view={view({ baseUrl: "http://192.168.1.20:1234" })} onSelect={noop} />);

    const input = screen.getByTestId("provider-url") as HTMLInputElement;
    expect(input.value).toBe("http://192.168.1.20:1234");
    expect(input.disabled).toBe(false);
  });

  it("reports the edited URL for the current provider", () => {
    const onSelect = vi.fn();
    render(<ProviderRow view={view({ provider: "lmstudio" })} onSelect={onSelect} />);

    fireEvent.change(screen.getByTestId("provider-url"), {
      target: { value: "http://192.168.1.20:1234" },
    });
    fireEvent.click(screen.getByTestId("provider-apply"));

    expect(onSelect).toHaveBeenCalledWith("lmstudio", "http://192.168.1.20:1234");
  });

  it("applies the URL on Enter as well as on the button", () => {
    const onSelect = vi.fn();
    render(<ProviderRow view={view()} onSelect={onSelect} />);

    const input = screen.getByTestId("provider-url");
    fireEvent.change(input, { target: { value: "http://box.local:11434" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("ollama", "http://box.local:11434");
  });

  it("moves to the new provider's own default rather than carrying the old port", () => {
    // A15 gave each provider its own base-URL variable for exactly this reason:
    // pointing LM Studio at 11434 is a mistake neither server can detect. The
    // empty URL is main's "use that provider's default", so the row never has to
    // know the port.
    const onSelect = vi.fn();
    render(<ProviderRow view={view({ baseUrl: "http://127.0.0.1:11434" })} onSelect={onSelect} />);

    fireEvent.change(screen.getByTestId("provider-select"), { target: { value: "lmstudio" } });

    expect(onSelect).toHaveBeenCalledWith("lmstudio", "");
  });

  it("adopts a URL the app resolved on its own", async () => {
    // The field is a text input with its own state, and a switch that main
    // answered with a different URL — a default, or a trailing slash it stripped
    // — has to land in it. Otherwise the row shows one thing and the app is
    // talking to another.
    const { rerender } = render(<ProviderRow view={view()} onSelect={noop} />);
    rerender(
      <ProviderRow
        view={view({ provider: "lmstudio", baseUrl: "http://127.0.0.1:1234" })}
        onSelect={noop}
      />,
    );

    await waitFor(() =>
      expect((screen.getByTestId("provider-url") as HTMLInputElement).value).toBe(
        "http://127.0.0.1:1234",
      ),
    );
  });

  it("says the server is answering, and how the provider was chosen", () => {
    render(<ProviderRow view={view({ source: "detected", connected: true })} onSelect={noop} />);

    const status = screen.getByTestId("provider-status");
    expect(status.getAttribute("data-connected")).toBe("true");
    expect(status.getAttribute("data-source")).toBe("detected");
    // "it picked LM Studio at :1234" has to be readable, not inferred.
    expect(status.textContent).toMatch(/detected/i);
  });

  it("names the endpoint when the server is not answering", () => {
    render(
      <ProviderRow
        view={view({
          connected: false,
          error: "Ollama is unreachable at http://127.0.0.1:11434/api/tags (ECONNREFUSED)",
        })}
        onSelect={noop}
      />,
    );

    const status = screen.getByTestId("provider-status");
    expect(status.getAttribute("data-connected")).toBe("false");
    expect(status.textContent).toContain("http://127.0.0.1:11434/api/tags");
  });

  it("carries the whole detection failure when nothing answered", () => {
    // Both URLs and both providers, because naming one sends someone running LM
    // Studio to restart Ollama.
    const error =
      "no model server answered — tried ollama at http://127.0.0.1:11434/api/tags " +
      "(ECONNREFUSED) and lmstudio at http://127.0.0.1:1234/v1/models (ECONNREFUSED)";
    render(<ProviderRow view={view({ source: "fallback", connected: false, error })} onSelect={noop} />);

    const status = screen.getByTestId("provider-status");
    expect(status.textContent).toContain("http://127.0.0.1:11434/api/tags");
    expect(status.textContent).toContain("http://127.0.0.1:1234/v1/models");
  });

  it("names a bound model the current provider does not have", () => {
    // The stale-binding state, rendered rather than discovered inside a run.
    render(
      <ProviderRow
        view={view({
          provider: "lmstudio",
          unavailable: [{ role: "generator", model: "qwen3-vl:8b-instruct-q4_K_M" }],
        })}
        onSelect={noop}
      />,
    );

    const warning = screen.getByTestId("provider-unavailable");
    expect(warning.textContent).toContain("qwen3-vl:8b-instruct-q4_K_M");
    expect(warning.textContent).toContain("generator");
  });

  it("says nothing about bindings when every one of them exists", () => {
    render(<ProviderRow view={view()} onSelect={noop} />);
    expect(screen.queryByTestId("provider-unavailable")).toBeNull();
  });

  it("greys out while a mutation holds the session", () => {
    // `main/ipc.ts` rule 5 refuses a switch during a run. The controls follow the
    // refusal rather than inviting one.
    render(<ProviderRow view={view()} onSelect={noop} disabled />);

    expect((screen.getByTestId("provider-select") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId("provider-url") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("provider-apply") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// App — the provider row's round trip
// ---------------------------------------------------------------------------

describe("App — the provider row", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness(null);
    window.api = h.api;
  });

  it("shows the provider main resolved, on first paint", async () => {
    render(<App />);

    await waitFor(() =>
      expect((screen.getByTestId("provider-select") as HTMLSelectElement).value).toBe("ollama"),
    );
    expect(h.getProvider).toHaveBeenCalled();
    expect((screen.getByTestId("provider-url") as HTMLInputElement).value).toBe(
      "http://127.0.0.1:11434",
    );
  });

  it("switches provider and repopulates the model pickers", async () => {
    // §9: "pickers list only installed models" — and the installed models are a
    // property of the *server*, so a switch that left the old list on screen
    // would offer models the new provider does not have.
    h.listModels.mockResolvedValueOnce({ ok: true, value: ["ollama-only"] });
    h.getModels.mockResolvedValueOnce({ generator: "ollama-only", critic: "ollama-only" });
    render(<App />);

    await waitFor(() =>
      expect(
        Array.from((screen.getByTestId("model-generator") as HTMLSelectElement).options).map(
          (o) => o.value,
        ),
      ).toEqual(["ollama-only"]),
    );

    h.listModels.mockResolvedValue({ ok: true, value: ["lmstudio-only"] });
    h.getModels.mockResolvedValue({ generator: "lmstudio-only", critic: "lmstudio-only" });

    fireEvent.change(screen.getByTestId("provider-select"), { target: { value: "lmstudio" } });

    await waitFor(() => expect(h.setProvider).toHaveBeenCalledWith("lmstudio", ""));
    await waitFor(() =>
      expect(
        Array.from((screen.getByTestId("model-generator") as HTMLSelectElement).options).map(
          (o) => o.value,
        ),
      ).toEqual(["lmstudio-only"]),
    );
    // And the row shows where it went — LM Studio's own port, not Ollama's.
    expect((screen.getByTestId("provider-url") as HTMLInputElement).value).toBe(
      "http://127.0.0.1:1234",
    );
  });

  it("repopulates the pickers when only the base URL changes", async () => {
    h.listModels.mockResolvedValueOnce({ ok: true, value: ["here"] });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("provider-url")).toBeDefined());

    h.listModels.mockResolvedValue({ ok: true, value: ["over-there"] });
    fireEvent.change(screen.getByTestId("provider-url"), {
      target: { value: "http://192.168.1.20:11434" },
    });
    fireEvent.click(screen.getByTestId("provider-apply"));

    await waitFor(() =>
      expect(h.setProvider).toHaveBeenCalledWith("ollama", "http://192.168.1.20:11434"),
    );
    await waitFor(() =>
      expect(
        Array.from((screen.getByTestId("model-generator") as HTMLSelectElement).options).map(
          (o) => o.value,
        ),
      ).toContain("over-there"),
    );
  });

  it("renders a refused switch instead of swallowing it", async () => {
    // Wave 10b answers a second session mutation `{ok:false, code:"busy"}`, and
    // §8's founding defect is an action that did not happen being reported as
    // though it had. Wave 12 already surfaces `busy`; this joins it.
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("provider-select")).toBeDefined());

    h.setProvider.mockResolvedValueOnce({
      ok: false,
      code: "busy",
      message: "setProvider: run is still in flight — one session mutation at a time",
    });

    fireEvent.change(screen.getByTestId("provider-select"), { target: { value: "lmstudio" } });

    await waitFor(() => {
      const error = screen.getByTestId("error");
      expect(error.getAttribute("data-code")).toBe("busy");
      expect(error.textContent).toContain("one session mutation at a time");
    });
    // The row still shows the provider that is actually in use.
    expect((screen.getByTestId("provider-select") as HTMLSelectElement).value).toBe("ollama");
  });

  it("blocks Generate when the new provider does not have the bound model", async () => {
    // The stale-binding decision, at the surface it has to land on: the failure
    // happens at the switch, not minutes later inside a generation.
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("provider-select")).toBeDefined());

    h.setProvider.mockResolvedValueOnce({
      ok: true,
      value: {
        provider: "lmstudio",
        baseUrl: "http://127.0.0.1:1234",
        source: "configured",
        connected: true,
        error: null,
        probes: [],
        unavailable: [{ role: "generator", model: "qwen3-vl:8b-instruct-q4_K_M" }],
      },
    });

    fireEvent.change(screen.getByTestId("provider-select"), { target: { value: "lmstudio" } });

    await waitFor(() =>
      expect((screen.getByTestId("generate") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByTestId("generate").getAttribute("title")).toContain(
      "qwen3-vl:8b-instruct-q4_K_M",
    );
    expect(screen.getByTestId("provider-unavailable").textContent).toContain("generator");
  });

  it("blocks Generate when the provider is not answering", async () => {
    h.getProvider.mockResolvedValue({
      ok: true,
      value: {
        provider: "lmstudio",
        baseUrl: "http://127.0.0.1:1234",
        source: "fallback",
        connected: false,
        error: "no model server answered — tried ollama at … and lmstudio at …",
        probes: [],
        unavailable: [],
      },
    });
    render(<App />);

    await waitFor(() =>
      expect((screen.getByTestId("generate") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByTestId("provider-status").getAttribute("data-connected")).toBe("false");
  });

  it("re-reads the provider when Retry is pressed", async () => {
    // §9's explicit retry. A user who started their server after the app has to
    // have a way back that is not a restart — and after A16 that path includes
    // re-asking whether the server is there at all.
    h.listModels.mockResolvedValueOnce({ ok: false, code: "ollama-unreachable", message: "down" });
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("retry")).toBeDefined());
    const before = h.getProvider.mock.calls.length;

    h.listModels.mockResolvedValue({ ok: true, value: ["back"] });
    fireEvent.click(screen.getByTestId("retry"));

    await waitFor(() => expect(h.getProvider.mock.calls.length).toBeGreaterThan(before));
  });
});
