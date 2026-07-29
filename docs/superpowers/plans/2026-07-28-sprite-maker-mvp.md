# Sprite Maker MVP Implementation Plan

> **For agentic workers:** This plan executes under `review-gate-protocol` — one wave, one implementer subagent, one independent reviewer subagent, one commit. Steps use checkbox (`- [ ]`) syntax. TDD is mandatory: the failing test is written and *observed failing* before implementation in every wave.

**Goal:** An Electron desktop app that turns a natural-language prompt into pixel art using a local Qwen 3 generator, then improves it through a bounded critique loop driven by a local Qwen 3 VL vision model, with the user gating the result.

**Architecture:** Deterministic outer loop (round sequencing, linting, stop conditions, version snapshots) written in TypeScript; agentic inner revise stage where the model gets a bounded `place_pixel` tool loop. The harness lives in Electron's main process as plain TypeScript so the entire pipeline is testable with a stub Ollama client and no Electron running.

**Tech Stack:** Electron 43 + electron-vite 5, React 19, TypeScript, Zod 4, Vitest 4, pngjs 7, Playwright 1.62 (Electron driver), Ollama (local).

**Spec:** `docs/superpowers/specs/2026-07-28-sprite-maker-design.md` — the spec is authoritative. Where this plan and the spec disagree, the spec wins and the plan is patched.

---

## A note on plan fidelity

`writing-plans` asks for literal code in every step. `review-gate-protocol` dispatches implementers with a file whitelist, pre-flight requirements, and acceptance criteria rather than a line-by-line script. This plan reconciles them deliberately:

- **Literal code is given** for everything subtle enough that two competent engineers would build it differently: row normalization and repair, `setPixel` validation, every lint warning definition, the confidence filter, and the stop-condition evaluation order.
- **Exact signatures plus named tests** are given elsewhere. The implementer writes the test bodies, because under TDD the test *is* the implementer's work, and a plan that pre-writes every assertion turns TDD into transcription.

Every wave still carries exact paths, exact interfaces, and observable acceptance criteria. No wave contains "TBD," "add error handling," or "similar to Wave N."

## Global Constraints

Copied verbatim from the spec. Every wave's requirements implicitly include these.

- **Row encoding:** one character per pixel. `.` = transparent, `0`–`f` = palette index 0–15.
- **Palette size:** 4–16 entries. 16 is the encoding ceiling, not a requirement.
- **Canvas sizes:** 16×16, 32×32, 64×64 only.
- **Every pixel mutation routes through `shared/grid.ts`** — agent `place_pixel` and user mouse click hit identical code.
- **`main/ollama.ts` is the sole HTTP boundary.** Every other module accepts a client interface.
- **`shared/grid.ts` is pure** — no model, no disk, no Electron.
- **Stop conditions evaluate on the *filtered* issue list.** Confidence filters apply first.
- **`HarnessConfig` is serialized into `SessionHistory` on every run.**
- **`suggest` is advisory**, never applied verbatim.
- **Any round may be accepted, not only the last.**
- **Node 22.15.0**, pinned by a committed `.nvmrc` (spec amendment A3). Package manager: npm.
- **Default model bindings:** generator `qwen3:8b`, critic `qwen3-vl:8b-instruct-q4_K_M`.

## Evidence requirements

Per `evidence-on-disk`, any wave claiming a live-verification result must commit the artifact:

| Artifact | Path |
|---|---|
| Screenshots | `docs/superpowers/specs/screenshots/2026-07-28-wave-<N>-<topic>.png` |
| Model output, CLI captures, bench CSV | `docs/superpowers/specs/captures/2026-07-28-wave-<N>-<topic>.txt` |

Inline narration is not evidence. A reviewer rejects when a live-verification criterion is claimed but no matching file appears in `git status --short`.

## Design lock

The editor layout was ratified by the user against an interactive prototype during brainstorming. That prototype is committed **alongside this plan** (before Wave 1) as `docs/superpowers/specs/design/2026-07-28-editor-layout-b.html` and is the **ruled design** for Waves 11–12. Visual gates judge rendered screenshots against it, with the prototype as the "better than / worse than" axis.

---

## Wave scope table

| Wave | New files | Modified files |
|------|-----------|----------------|
| 1 | `package.json`, `tsconfig.json`, `electron.vite.config.ts`, `vitest.config.ts`, `src/shared/schema.ts`, `src/shared/palettes.ts`, `tests/shared/schema.test.ts`, `tests/shared/palettes.test.ts`, `README.md` | `.gitignore` |
| 2 | `src/shared/grid.ts`, `tests/shared/grid.test.ts` | — |
| 3 | `src/main/lint.ts`, `tests/main/lint.test.ts`, `tests/fixtures/sprites.ts` | — |
| 4 | `src/main/render.ts`, `tests/main/render.test.ts`, `tests/fixtures/golden/*.png` | `package.json` |
| 5 | `src/main/ollama.ts`, `src/main/models.ts`, `tests/main/ollama.test.ts`, `tests/main/models.test.ts`, `tests/stubs/ollama.ts`, `tests/live/smoke.test.ts` | `package.json` |
| 6 | `src/main/draft.ts`, `src/main/prompts/draft.ts`, `tests/main/draft.test.ts` | — |
| 7 | `src/main/critique.ts`, `src/main/prompts/critique.ts`, `tests/main/critique.test.ts` | — |
| 8 | `src/main/revise.ts`, `src/main/prompts/revise.ts`, `tests/main/revise.test.ts` | — |
| 9 | `src/main/history.ts`, `src/main/pipeline.ts`, `tests/main/pipeline.test.ts`, `tests/main/history.test.ts` | — |
| 10 | `src/main/index.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `tests/main/ipc.test.ts` | `package.json`, `electron.vite.config.ts` |
| 11 | `src/renderer/components/Canvas.tsx`, `src/renderer/components/PaletteBar.tsx`, `src/renderer/state/store.ts`, `tests/renderer/Canvas.test.tsx`, `e2e/canvas.spec.ts`, `playwright.config.ts` | `src/renderer/App.tsx`, `package.json` |
| 12 | `src/renderer/components/PromptBar.tsx`, `CritiqueDock.tsx`, `Filmstrip.tsx`, `GateBar.tsx`, `StatusBar.tsx`, `ModelPickers.tsx`, `e2e/loop.spec.ts` | `src/renderer/App.tsx`, `src/renderer/state/store.ts` |
| 13 | `src/main/export.ts`, `bench/run.ts`, `bench/prompts.ts`, `tests/main/export.test.ts` | `package.json`, `src/main/ipc.ts`, `src/renderer/components/GateBar.tsx` |
| 14 | `docs/.../captures/2026-07-28-wave-14-e2e.txt`, `docs/.../screenshots/2026-07-28-wave-14-*.png` | `docs/.../specs/2026-07-28-sprite-maker-design.md` |

A reviewer's first check is always: *did the implementer touch only the files in this row?* Anything outside triggers automatic rejection. Whitelist expansion requires human escalation.

---

## Wave 1 — Scaffold, schemas, palettes

**Goal:** `npm test` runs green against real schema and palette tests. No app yet.

**Interfaces produced:**

```ts
// src/shared/schema.ts
export const SizeSchema, IntentSchema, PaletteRefSchema, SpriteDocSchema,
             IssueSchema, CritiqueReportSchema, LintWarningSchema,
             LintReportSchema, HarnessConfigSchema, PixelDiffSchema,
             RoundSchema, SessionHistorySchema
export type Size, Intent, SpriteDoc, Issue, CritiqueReport, LintWarning,
            LintReport, HarnessConfig, PixelDiff, Round, SessionHistory
export const DEFAULT_HARNESS_CONFIG: HarnessConfig

// src/shared/palettes.ts
export interface Palette { id: string; name: string; colors: string[] }
export const PALETTES: Record<string, Palette>
export function getPalette(id: string): Palette        // throws on unknown id
export function listPalettes(): Palette[]
```

`DEFAULT_HARNESS_CONFIG` uses the exact defaults from spec §6.8:

```ts
export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  maxRounds: 3,
  maxReviseTurns: 40,
  maxDraftRetries: 1,
  repairRejectThreshold: 0.20,
  confidenceFloor: 0.30,
  suggestConfidenceFloor: 0.50,
  stopOnNoHighSeverity: true,
  criticUpscale: 16,
  callTimeoutMs: 120000,
  models: { generator: "qwen3:8b", critic: "qwen3-vl:8b-instruct-q4_K_M" },
}
```

Bundled palettes are exactly the five from spec §6.1a: `pico-8` (16), `db16` (16), `aap-16` (16), `nes-16` (16), `gameboy` (4).

**Steps:**

- [ ] **1.1** `npm init -y`; install runtime deps `react@19 react-dom zod@4 pngjs@7` and dev deps `electron@43 electron-vite@5 typescript vitest@4 @types/node @types/react @types/react-dom @types/pngjs`. Pin majors in `package.json`. **Amendment P3:** `electron` and `electron-vite` are **devDependencies**, not dependencies — an earlier draft of this step had them as runtime deps, which would bundle Electron into the packaged app.
- [ ] **1.2** Write `tsconfig.json` (strict, `moduleResolution: "bundler"`, paths `@shared/*` → `src/shared/*`, `@main/*` → `src/main/*`) and `vitest.config.ts` (node environment, same path aliases).
- [ ] **1.3** Write `tests/shared/palettes.test.ts` **first**: every palette has 4–16 colors; every color matches `/^#[0-9A-Fa-f]{6}$/`; no duplicate colors within a palette; `getPalette("nope")` throws; `listPalettes()` returns 5 entries.
- [ ] **1.4** Run `npx vitest run tests/shared/palettes.test.ts`. Expected: FAIL — module not found.
- [ ] **1.5** Implement `src/shared/palettes.ts`. Run again. Expected: PASS.
- [ ] **1.6** Write `tests/shared/schema.test.ts` **first**: `SpriteDocSchema` rejects a doc whose `rows.length !== size.h`; rejects a row containing `g`; rejects `size.w = 24`; accepts a valid 16×16 doc. `CritiqueReportSchema` rejects `confidence: 1.4` and `severity: "critical"`. `HarnessConfigSchema.parse({})` yields `DEFAULT_HARNESS_CONFIG`.
- [ ] **1.7** Run it. Expected: FAIL.
- [ ] **1.8** Implement `src/shared/schema.ts`. Run. Expected: PASS.
- [ ] **1.9** Write `README.md` (what this is, how to run, model prerequisites with the exact `ollama pull` commands). **Amendment P4:** an earlier draft also asked this step to copy the ratified prototype into `docs/.../design/`; it was already committed before Wave 1 in `87e8798`, so that clause is removed.
- [ ] **1.10** Run `npx vitest run`. Commit.

**Acceptance criteria (reviewer checks these as numbered gates):**
1. `npm test` exits 0 with ≥ 12 passing tests.
2. `npx tsc --noEmit` exits 0.
3. `SpriteDocSchema` rejects a 32-row doc declaring `size.h = 16` — reviewer verifies by writing a throwaway assertion, not by reading code.
4. All five palettes present; `gameboy` has exactly 4 colors; no palette exceeds 16.
5. `HarnessConfigSchema.parse({})` equals the spec §6.8 defaults, field for field.
6. Only Wave 1 whitelist files touched.

---

## Wave 2 — `shared/grid.ts`

**Goal:** Every pixel mutation in the system has one pure, tested implementation.

**Interfaces produced:**

```ts
export type Grid = string[]
export const TRANSPARENT = "."
export class GridError extends Error {
  constructor(public code: "out-of-bounds" | "off-palette" | "bad-char", message: string)
}
export function indexChar(i: number): string              // 0..15 -> '0'..'f'
export function charIndex(c: string): number              // '0'..'f' -> 0..15; '.' -> -1
export function makeEmpty(w: number, h: number): Grid
export function normalize(rows: string[], w: number, h: number):
  { grid: Grid; repairs: number; repairedRows: number[] }
export function getPixel(g: Grid, x: number, y: number): string
export function setPixel(g: Grid, x: number, y: number, ch: string, paletteSize: number): Grid
export function fillRow(g: Grid, y: number, x0: number, x1: number, ch: string, paletteSize: number): Grid
export function diff(a: Grid, b: Grid): PixelDiff[]
```

**`normalize` is given literally** — it implements spec §6.3 and is the single most defect-prone function in the codebase:

```ts
export function normalize(rows: string[], w: number, h: number) {
  const grid: Grid = []
  const repairedRows: number[] = []
  let repairs = 0

  for (let y = 0; y < h; y++) {
    const src = rows[y] ?? ""
    let out = ""
    let rowRepairs = 0

    for (let x = 0; x < w; x++) {
      const c = src[x]
      if (c === undefined) { out += TRANSPARENT; rowRepairs++ }        // too short
      else if (c === TRANSPARENT || charIndex(c) >= 0) { out += c }    // valid
      else { out += TRANSPARENT; rowRepairs++ }                        // invalid char
    }
    if (src.length > w) rowRepairs += src.length - w                   // truncated

    if (rowRepairs > 0) repairedRows.push(y)
    repairs += rowRepairs
    grid.push(out)
  }
  if (rows.length > h) repairs += (rows.length - h) * w                // extra rows dropped
  return { grid, repairs, repairedRows }
}
```

**`setPixel` is given literally** — it is the chokepoint the Global Constraints require:

```ts
export function setPixel(g: Grid, x: number, y: number, ch: string, paletteSize: number): Grid {
  const h = g.length, w = g[0]?.length ?? 0
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= w || y >= h)
    throw new GridError("out-of-bounds", `(${x},${y}) outside ${w}x${h}`)
  if (ch !== TRANSPARENT) {
    const i = charIndex(ch)
    if (i < 0) throw new GridError("bad-char", `'${ch}' is not '.' or 0-f`)
    if (i >= paletteSize) throw new GridError("off-palette", `index ${i} exceeds palette size ${paletteSize}`)
  }
  const next = g.slice()
  next[y] = g[y].slice(0, x) + ch + g[y].slice(x + 1)
  return next
}
```

**Steps:**

- [ ] **2.1** Write `tests/shared/grid.test.ts` covering, as a table-driven suite: `normalize` with a short row, a long row, an invalid character, too few rows, too many rows, and a clean grid (0 repairs); `setPixel` bounds rejection on each of the four edges, `off-palette` when `index >= paletteSize`, `bad-char` on `"g"`, purity (input grid unmutated); `fillRow` inclusive of `x1` and rejecting `x0 > x1`; `diff` returning `[]` for identical grids and one entry per changed cell; `indexChar`/`charIndex` round-trip for 0–15.
- [ ] **2.2** Run. Expected: FAIL — module not found.
- [ ] **2.3** Implement `src/shared/grid.ts` using the literal `normalize` and `setPixel` above.
- [ ] **2.4** Run. Expected: PASS.
- [ ] **2.5** Commit.

**Acceptance criteria:**
1. `npm test` green; grid suite has ≥ 20 assertions.
2. `setPixel` on a `gameboy` doc (`paletteSize = 4`) with `ch = "9"` throws `GridError` with `code === "off-palette"` — reviewer verifies by execution, not inspection.
3. `normalize(["ab"], 4, 1)` returns `repairs === 4` (2 invalid chars → transparent, 2 pad) and `grid === ["...."]`. Reviewer runs this exact call.
4. `setPixel` does not mutate its input — reviewer asserts the original grid is unchanged after the call.
5. No imports from `main/`, `renderer/`, `electron`, `fs`, or `node:*` in `grid.ts`.
6. Only Wave 2 whitelist files touched.

---

## Wave 3 — `main/lint.ts`

**Goal:** The deterministic half of the review system, implementing spec §6.5 definitions exactly.

**Interfaces produced:** `export function lint(doc: SpriteDoc): LintReport`

**The five warning codes are given literally**, because the spec forbids the implementation inventing others:

| Code | Definition to implement |
|---|---|
| `orphan-pixel` | A non-transparent cell whose four **orthogonal** neighbours are all transparent. Out-of-canvas counts as transparent. Diagonal attachment does not rescue it. |
| `outline-gap` | A transparent cell with non-transparent cells on **opposite** orthogonal sides (left *and* right, or above *and* below). |
| `low-contrast` | Two palette indices used as orthogonal neighbours anywhere in the sprite whose WCAG relative luminance differs by `< 0.08`. Reported **once per index pair**, not per cell. |
| `unused-palette-entry` | A palette index never appearing in `rows`. Informational. |
| `row-repaired` | One warning per row in `meta.repairedRows`, carrying that row's cells. |

`metrics.symmetryScore` = fraction of non-transparent cells whose mirror about the **vertical centre axis** holds the same index. Reported, never an error.

Relative luminance uses the standard sRGB formula: linearize each channel (`c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`), then `0.2126R + 0.7152G + 0.0722B`.

**Steps:**

- [ ] **3.1** Write `tests/fixtures/sprites.ts` exporting hand-built `SpriteDoc` fixtures: `SOLID_BLOCK` (no warnings), `ONE_ORPHAN`, `DIAGONAL_ONLY` (must still be an orphan), `HORIZONTAL_GAP`, `VERTICAL_GAP`, `LOW_CONTRAST_PAIR`, `PERFECT_MIRROR`, `FULLY_ASYMMETRIC`.
- [ ] **3.2** Write `tests/main/lint.test.ts` **first**: one test per code asserting the exact `cells` array; `DIAGONAL_ONLY` yields an orphan (the definition's sharp edge); `low-contrast` on a sprite using the same near-luminance pair in 30 places reports **one** warning; `PERFECT_MIRROR` scores 1.0 and `FULLY_ASYMMETRIC` scores < 0.2; `SOLID_BLOCK` yields zero warnings of every code.
- [ ] **3.3** Run. Expected: FAIL.
- [ ] **3.4** Implement `src/main/lint.ts`.
- [ ] **3.5** Run. Expected: PASS.
- [ ] **3.6** Commit.

**Acceptance criteria:**
1. `npm test` green.
2. A cell attached only diagonally is reported as `orphan-pixel` — reviewer runs `DIAGONAL_ONLY` and confirms.
3. `low-contrast` deduplicates by index pair: reviewer builds a sprite with 30 adjacent low-contrast cell pairs and confirms exactly one warning.
4. `lint()` imports nothing from `ollama.ts` and performs no I/O.
5. Every warning code in the spec table is emitted by at least one test; no code outside the table is ever emitted.
6. Only Wave 3 whitelist files touched.

---

## Wave 4 — `main/render.ts`

**Goal:** Grid → PNG, at a scale factor, with an optional coordinate overlay for the critic.

**Interfaces produced:**

```ts
export function toPng(doc: SpriteDoc, scale: number): Buffer
export function toPngWithGrid(doc: SpriteDoc, scale: number): Buffer
```

Nearest-neighbour only — no smoothing, ever. `toPngWithGrid` draws 1px rules every 8 source pixels and is used solely to ground the critic's coordinates.

**Steps:**

- [ ] **4.1** Write `tests/main/render.test.ts` **first**: `toPng(doc, 1)` produces a PNG whose decoded dimensions equal `size`; `toPng(doc, 16)` on a 32×32 yields 512×512; a transparent cell decodes to alpha 0; a cell of index 3 decodes to that palette color exactly (no interpolation) at all 16×16 sub-pixels; `toPng(doc, 0)` throws.
- [ ] **4.2** Run. Expected: FAIL.
- [ ] **4.3** Implement `src/main/render.ts` with `pngjs`.
- [ ] **4.4** Run. Expected: PASS.
- [ ] **4.5** Add golden-file test: render a fixture at 8×, write to `tests/fixtures/golden/`, assert byte equality on subsequent runs.
- [ ] **4.6** Commit.

**Acceptance criteria:**
1. `npm test` green.
2. Decoding `toPng(SOLID_BLOCK, 16)` shows every one of the 256 sub-pixels of a source cell carrying the identical RGBA — proves nearest-neighbour, not smoothing. Reviewer verifies by decoding, not by reading code.
3. Transparent cells decode to alpha 0, not white.
4. Golden file committed and byte-stable across two consecutive runs.
5. Only Wave 4 whitelist files touched.

---

## Wave 5 — `main/ollama.ts` + `main/models.ts`

**Goal:** The single HTTP boundary, plus the role registry backing the model pickers.

**Interfaces produced:**

```ts
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string }
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ChatTurn { content: string; toolCalls: ToolCall[] }

export interface OllamaClient {
  listModels(): Promise<string[]>
  generate(req: { model: string; system?: string; prompt: string; options?: Record<string, unknown>; signal?: AbortSignal }): Promise<string>
  vision(req: { model: string; system?: string; prompt: string; images: Buffer[]; signal?: AbortSignal }): Promise<string>
  chatWithTools(req: { model: string; messages: ChatMessage[]; tools: ToolDef[]; signal?: AbortSignal }): Promise<ChatTurn>
}
export function createOllamaClient(baseUrl?: string): OllamaClient   // default http://localhost:11434
export class OllamaUnreachableError extends Error { constructor(public endpoint: string) }

// src/main/models.ts
export interface ModelRegistry {
  list(): Promise<string[]>
  roles(): { generator: string; critic: string }
  bind(role: "generator" | "critic", model: string): void
}
export function createModelRegistry(client: OllamaClient, cfg: HarnessConfig): ModelRegistry
```

`tests/stubs/ollama.ts` exports `createStubClient(script: StubScript): OllamaClient` — a scripted client returning canned responses in order and recording every request. **This stub is the load-bearing test fixture for Waves 6–9.**

**Steps:**

- [ ] **5.1** Write `tests/stubs/ollama.ts`.
- [ ] **5.2** Write `tests/main/ollama.test.ts` **first**, against a local `http.createServer` fixture (not a mock of `fetch`): `generate` posts to `/api/generate` with `stream: false`; `vision` base64-encodes images into the `images` array; `listModels` parses `/api/tags`; a connection refusal throws `OllamaUnreachableError` naming the endpoint; an `AbortSignal` cancels an in-flight request.
- [ ] **5.3** Run. Expected: FAIL.
- [ ] **5.4** Implement `src/main/ollama.ts`.
- [ ] **5.5** Write `tests/main/models.test.ts`: `roles()` returns config defaults; `bind` changes them; `list()` delegates to the client.
- [ ] **5.6** Implement `src/main/models.ts`. Run all. Expected: PASS.
- [ ] **5.7** Write the opt-in live smoke test `tests/live/smoke.test.ts` asserting only that a real `qwen3:8b` call returns a non-empty string. Add the `test:live` script to `package.json`. **Amendment P1:** `vitest.config.ts` is not in this wave's whitelist and its `include` glob is `tests/**/*.test.ts`, so this file would otherwise run during default `npm test`. Guard it with an in-file `describe.skipIf(!process.env.LIVE)` rather than a config change — the guard belongs with the test regardless, since it documents its own precondition.
- [ ] **5.8** Run `npm run test:live` once; save the raw output to `docs/superpowers/specs/captures/2026-07-28-wave-5-live-smoke.txt`. Commit.

**Acceptance criteria:**
1. `npm test` green and **does not** require Ollama running — reviewer confirms by stopping Ollama and re-running.
2. `npm run test:live` passes with Ollama running, and the capture file exists in `git status --short` with real model output.
3. `OllamaUnreachableError` names the exact endpoint URL.
4. Grepping `src/` for `fetch(`, `http.request`, or `axios` outside `ollama.ts` returns zero hits.
5. Only Wave 5 whitelist files touched.

---

## Wave 6 — `main/draft.ts`

**Goal:** Prompt → generator → repaired `SpriteDoc`, with retry above threshold.

**Interfaces produced:**

```ts
export function buildDraftPrompt(input: { prompt: string; size: Size; palette: Palette }): { system: string; user: string }
export function parseDraft(raw: string, size: Size, palette: Palette):
  { grid: Grid; intent: Intent; repairs: number; repairedRows: number[] }
export async function draft(
  deps: { client: OllamaClient },
  input: { prompt: string; size: Size; paletteId: string },
  cfg: HarnessConfig
): Promise<SpriteDoc>
export class DraftRejectedError extends Error { constructor(public repairs: number, public raw: string) }
```

The draft system prompt is prefixed `/no_think`, states the encoding rules, gives the palette as an indexed table, and includes two short worked examples. `parseDraft` tolerates fenced code blocks and prose around the JSON.

**Steps:**

- [ ] **6.1** Write `tests/main/draft.test.ts` **first**, driving `draft()` with the Wave 5 stub: a clean response yields `repairs === 0`; a response with three short rows yields the right `repairs` count and a valid doc; a response exceeding `repairRejectThreshold` triggers **exactly one** retry (assert the stub recorded 2 calls) and the retry prompt contains the misalignment description; a second over-threshold response throws `DraftRejectedError` carrying the raw output; `buildDraftPrompt` output contains `/no_think` and every palette index with its hex.
- [ ] **6.2** Run. Expected: FAIL.
- [ ] **6.3** Implement `src/main/prompts/draft.ts` and `src/main/draft.ts`.
- [ ] **6.4** Run. Expected: PASS.
- [ ] **6.5** Commit.

**Acceptance criteria:**
1. `npm test` green.
2. Retry fires exactly once at `maxDraftRetries: 1` — reviewer asserts the stub's recorded call count is 2, not 3.
3. `DraftRejectedError` carries the raw model output for debugging.
4. `meta.repairs` on the produced doc equals `normalize`'s count.
5. The retry prompt names the specific rows that were malformed.
6. Only Wave 6 whitelist files touched.

---

## Wave 7 — `main/critique.ts`

**Goal:** Vision critique with region clamping and the two-tier confidence filter.

**Interfaces produced:**

```ts
export function buildCritiquePrompt(doc: SpriteDoc, lint: LintReport): { system: string; user: string }
export function parseCritique(raw: string, size: Size): CritiqueReport   // clamps regions; drops fully-OOB issues
export function filterIssues(report: CritiqueReport, cfg: HarnessConfig): CritiqueReport
export async function critique(
  deps: { client: OllamaClient },
  doc: SpriteDoc, lintReport: LintReport, cfg: HarnessConfig
): Promise<CritiqueReport>
```

**`filterIssues` is given literally** — the two-tier behavior is spec §6.4 and is easy to get subtly wrong:

```ts
export function filterIssues(report: CritiqueReport, cfg: HarnessConfig): CritiqueReport {
  const issues = report.issues
    .filter(i => i.confidence >= cfg.confidenceFloor)          // drop hallucinations entirely
    .map(i => i.suggestConfidence >= cfg.suggestConfidenceFloor
      ? i
      : { ...i, suggest: "" })                                  // keep issue, withhold the guess
  return { ...report, issues }
}
```

The critic call sends **both** the upscaled PNG (`toPng(doc, cfg.criticUpscale)`) and the raw row text, per spec §4.4.

**Steps:**

- [ ] **7.1** Write `tests/main/critique.test.ts` **first**: an issue at `confidence: 0.2` with `confidenceFloor: 0.3` is dropped; an issue at `confidence: 0.9, suggestConfidence: 0.4` is **kept** with `suggest === ""`; an issue at `0.9/0.6` keeps its suggest text; a region `[30, 30, 99, 99]` on a 32×32 clamps to `[30,30,31,31]`; a region entirely outside is dropped; non-JSON model output triggers **exactly one** reprompt whose message contains the validation error; a second invalid response returns an empty-issue report rather than throwing; `critique()` passes exactly one image and the row text to the client.
- [ ] **7.2** Run. Expected: FAIL.
- [ ] **7.3** Implement `src/main/prompts/critique.ts` and `src/main/critique.ts`.
- [ ] **7.4** Run. Expected: PASS.
- [ ] **7.5** Commit.

**Acceptance criteria:**
1. `npm test` green.
2. The `0.9 / 0.4` case keeps the issue and empties `suggest` — reviewer executes this exact case. (Dropping the whole issue here is the defect this check exists to catch.)
3. Two consecutive invalid critic responses yield a zero-issue report, never a throw — a broken critic must not destroy a valid sprite.
4. `critique()` sends both an image and the row text; reviewer asserts on the stub's recorded request.
5. Only Wave 7 whitelist files touched.

---

## Wave 8 — `main/revise.ts`

**Goal:** The bounded agentic loop — the one place the model drives.

**Interfaces produced:**

```ts
export const REVISE_TOOLS: ToolDef[]      // place_pixel, fill_row, done
export async function revise(
  deps: { client: OllamaClient },
  doc: SpriteDoc, issues: Issue[], cfg: HarnessConfig
): Promise<{ doc: SpriteDoc; turns: number; hitCap: boolean; summary: string }>
```

An invalid tool call returns an error **string** to the model as a tool result — never a throw — and still counts against `maxReviseTurns`.

**Steps:**

- [ ] **8.1** Write `tests/main/revise.test.ts` **first**: a scripted `place_pixel` then `done` applies one pixel and reports `turns === 2, hitCap === false`; an out-of-bounds `place_pixel` returns a tool result containing `out-of-bounds` and the loop continues; a script that never calls `done` stops at `maxReviseTurns` with `hitCap === true` and keeps the edits that landed; `maxReviseTurns: 2` is honoured exactly; `fill_row` with `x0 > x1` returns an error result without throwing; an off-palette index on a `gameboy` doc returns an error result.
- [ ] **8.2** Run. Expected: FAIL.
- [ ] **8.3** Implement `src/main/prompts/revise.ts` and `src/main/revise.ts`.
- [ ] **8.4** Run. Expected: PASS.
- [ ] **8.5** Commit.

**Acceptance criteria:**
1. `npm test` green.
2. An invalid tool call never throws — reviewer confirms the loop continues and the model receives an error string.
3. `maxReviseTurns` is honoured exactly; setting it to 2 produces at most 2 model turns.
4. Hitting the cap without `done()` still returns the partially-edited doc.
5. Every mutation goes through `shared/grid.ts` — grepping `revise.ts` for direct string splicing on rows returns zero hits.
6. Only Wave 8 whitelist files touched.

---

## Wave 9 — `main/history.ts` + `main/pipeline.ts`

**Goal:** The state machine. **This is the wave that most needs an independent reviewer.**

**Interfaces produced:**

```ts
// history.ts
export function createHistory(sessionId: string, cfg: HarnessConfig): SessionHistory
export function appendRound(h: SessionHistory, r: Round): SessionHistory
export async function saveHistory(h: SessionHistory, dir: string): Promise<string>

// pipeline.ts
export type PipelineState = "IDLE" | "DRAFTING" | "LINTING" | "CRITIQUING"
                          | "REVISING" | "AWAITING_USER" | "DONE" | "FAILED"
export type StopReason = "no-high-severity" | "round-cap" | "empty-diff"
export type PipelineEvent =
  | { type: "state"; state: PipelineState; round: number; detail?: string }
  | { type: "round"; round: Round }
  | { type: "stopped"; reason: StopReason }
  | { type: "error"; message: string }
export interface PipelineDeps { client: OllamaClient; onEvent: (e: PipelineEvent) => void }
export async function run(deps: PipelineDeps,
  input: { prompt: string; size: Size; paletteId: string }, cfg: HarnessConfig): Promise<SessionHistory>
export async function applyFeedback(deps: PipelineDeps,
  history: SessionHistory, feedback: string, roundIndex: number, cfg: HarnessConfig): Promise<SessionHistory>
```

**Two behaviors given literally**, because both are spec rules an implementer would plausibly invert:

```ts
// Stop conditions evaluate on the FILTERED list (spec §7.2).
const filtered = filterIssues(rawCritique, cfg)
const highSev = filtered.issues.filter(i => i.severity === "high")
if (cfg.stopOnNoHighSeverity && highSev.length === 0) return stop("no-high-severity")
if (round >= cfg.maxRounds) return stop("round-cap")

// User feedback is a synthetic high-severity issue re-entering at REVISING (spec §7.3).
const synthetic: Issue = {
  id: `user-${round}`, region: [0, 0, doc.size.w - 1, doc.size.h - 1],
  severity: "high", issue: feedback, suggest: "",
  confidence: 1.0, suggestConfidence: 0.0,
}
```

**Steps:**

- [ ] **9.1** Write `tests/main/history.test.ts`: `createHistory` embeds `cfg` verbatim; `appendRound` computes `diffFromPrev` against the previous round; `saveHistory` writes parseable JSON round-tripping through `SessionHistorySchema`.
- [ ] **9.2** Write `tests/main/pipeline.test.ts` **first**, entirely against the stub client. One test per behavior: the happy path emits `DRAFTING → LINTING → CRITIQUING → AWAITING_USER` and stops with `no-high-severity`; a critic that always returns a high-severity issue stops at `round-cap` after exactly `maxRounds`; a revise stage that changes nothing stops with `empty-diff` **before** the round cap; a high-severity issue at `confidence: 0.1` does **not** keep the loop running (filter-then-evaluate ordering); `applyFeedback` injects a synthetic issue with `confidence === 1.0` and re-enters at `REVISING`; a `DraftRejectedError` transitions to `FAILED` with the raw output in history; two consecutive invalid critiques advance to `AWAITING_USER`; `history.config` equals the passed config.
- [ ] **9.3** Run. Expected: FAIL.
- [ ] **9.4** Implement `src/main/history.ts` then `src/main/pipeline.ts`.
- [ ] **9.5** Run. Expected: PASS.
- [ ] **9.6** Save the emitted event sequence for the happy path to `docs/superpowers/specs/captures/2026-07-28-wave-9-event-trace.txt`. Commit.

**Acceptance criteria:**
1. `npm test` green; pipeline suite covers all three stop reasons with a dedicated test each.
2. **Filter-then-evaluate ordering is proven:** a critic returning one `severity: "high", confidence: 0.1` issue must stop with `no-high-severity` on round 1. Reviewer executes this case. Inverting the order is the defect this check exists to catch.
3. `empty-diff` fires before `round-cap` when revise is a no-op.
4. `applyFeedback` produces an issue with `confidence === 1.0` and `severity === "high"`.
5. The whole suite runs with Ollama stopped.
6. Event-trace capture exists in `git status --short` and shows the real state sequence.
7. Only Wave 9 whitelist files touched.

---

## Wave 10 — Electron shell + IPC

**Goal:** The app boots and the renderer can reach the pipeline. Minimal UI — a button and a `<pre>`.

**Interfaces produced:**

```ts
// src/preload/index.ts exposes window.api
interface Api {
  listModels(): Promise<string[]>
  getPalettes(): Promise<Palette[]>
  run(input: { prompt: string; size: Size; paletteId: string }): Promise<SessionHistory>
  applyFeedback(feedback: string, roundIndex: number): Promise<SessionHistory>
  onEvent(cb: (e: PipelineEvent) => void): () => void
  exportPng(roundIndex: number, scale: number): Promise<string>
}
```

Context isolation on, `nodeIntegration` off. The preload exposes exactly this surface and nothing else.

**Steps:**

- [ ] **10.1** Write `electron.vite.config.ts` for main/preload/renderer.
- [ ] **10.2** Write `tests/main/ipc.test.ts` **first**: every `Api` method maps to a registered `ipcMain.handle` channel; the channel list is exactly the `Api` keys (no extras).
- [ ] **10.3** Run. Expected: FAIL.
- [ ] **10.4** Implement `src/main/index.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, and a minimal `src/renderer/App.tsx` with a prompt input, a Generate button, and a `<pre>` dumping the returned rows.
- [ ] **10.5** Run `npm run dev`, generate one sprite against real Ollama, screenshot to `docs/superpowers/specs/screenshots/2026-07-28-wave-10-boot.png`.
- [ ] **10.6** Commit.

**Acceptance criteria:**
1. `npm run dev` opens a window; no console errors.
2. Screenshot committed showing real generated rows in the `<pre>` — reviewer confirms the file is in `git status --short` and shows actual pixel rows, not an empty box.
3. `contextIsolation: true` and `nodeIntegration: false` in the `BrowserWindow` config.
4. The preload exposes exactly the `Api` keys.
5. `npm test` still green.
6. Only Wave 10 whitelist files touched.

---

## Wave 11 — Canvas + palette + manual editing (visual gate V1)

**Goal:** The pixel grid is real and editable. First visual gate.

**Interfaces produced:**

```ts
// src/renderer/state/store.ts
export interface EditorState {
  history: SessionHistory | null; currentRound: number
  activeIndex: string; activeIssueId: string | null
  state: PipelineState; stopReason: StopReason | null
}
export function useEditor(): EditorState & { setPixel(x,y): void; selectColor(ch): void; selectRound(i): void }
```

**Steps:**

- [ ] **11.1** Install `@playwright/test`; write `playwright.config.ts` targeting Electron via `_electron.launch()`.
- [ ] **11.2** Write `tests/renderer/Canvas.test.tsx` **first**: a 16×16 doc renders 256 cells; a transparent cell renders the checkerboard class; clicking a cell calls `setPixel` with the right coords and the active index. **Amendment P2:** this needs a DOM. `vitest.config.ts` is not in this wave's whitelist, so install `jsdom` and `@testing-library/react` (both covered by this wave's `package.json` entry) and select the environment with a per-file `// @vitest-environment jsdom` docblock rather than changing the global config — the node default is correct for every other suite and should stay.
- [ ] **11.3** Run. Expected: FAIL.
- [ ] **11.4** Implement `Canvas.tsx`, `PaletteBar.tsx`, `store.ts`; wire into `App.tsx`.
- [ ] **11.5** Run. Expected: PASS.
- [ ] **11.6** Write `e2e/canvas.spec.ts`: launch Electron, load a fixture doc, click a palette swatch, click a canvas cell, assert the cell's color changed. Capture `docs/superpowers/specs/screenshots/2026-07-28-wave-11-canvas.png`.
- [ ] **11.7** Commit.

**Acceptance criteria:**
1. `npm test` and `npx playwright test` both green.
2. E2E screenshot committed showing a painted cell.
3. Manual edits route through `shared/grid.ts` — grepping the renderer for direct row splicing returns zero hits.
4. Canvas renders correctly at all three sizes.
5. **Visual gate V1:** a design-oriented reviewer judges the screenshot against the ruled design `docs/superpowers/specs/design/2026-07-28-editor-layout-b.html` on canvas dominance, checkerboard legibility, and swatch selection affordance. A visual REJECT is remediate-and-rerender.
6. Only Wave 11 whitelist files touched.

---

## Wave 12 — Prompt bar, dock, filmstrip, gate, status (visual gate V2)

**Goal:** The full ratified layout, driving the real pipeline.

**Steps:**

- [ ] **12.1** Write `e2e/loop.spec.ts` **first** (it will fail): run a real generation, assert the filmstrip gains a frame per round, clicking an issue highlights a region, clicking a filmstrip frame changes the canvas, the gate appears at `AWAITING_USER`.
- [ ] **12.2** Run. Expected: FAIL.
- [ ] **12.3** Implement `PromptBar`, `ModelPickers`, `CritiqueDock`, `Filmstrip`, `GateBar`, `StatusBar`; compose in `App.tsx`; subscribe to `onEvent` for live state.
- [ ] **12.4** Run. Expected: PASS.
- [ ] **12.5** Capture screenshots: `-wave-12-full.png` (populated, mid-loop), `-wave-12-empty.png` (**first-run state: no sprite, empty filmstrip, no dock**), `-wave-12-gate.png` (awaiting user).
- [ ] **12.6** Commit.

**Acceptance criteria:**
1. `npx playwright test` green.
2. All three screenshots committed, including the **empty/first-run state** — a design whose depth comes from content collapses when empty, and gating only the happy state is a known failure.
3. The critique dock is absent when there are no issues, present when there are.
4. Twin confidence bars render; the `0.91 / 0.40` case is visually distinguishable from `0.91 / 0.95`.
5. The status bar names the stop reason that actually fired.
6. **Interaction contract:** every rendered element affords something. A fresh reviewer drives the live app as a first-run user and a returning user and files every dead end. An element that renders but does nothing is a defect.
7. **Visual gate V2:** design reviewer judges all three screenshots against the ruled design.
8. Only Wave 12 whitelist files touched.

---

## Wave 13 — PNG export + benchmark runner

**Goal:** The tool produces usable output, and the quality instrument exists.

**Interfaces produced:**

```ts
export async function exportPng(doc: SpriteDoc, scale: 1|4|8|16, outPath: string): Promise<string>
// bench/run.ts — npm run bench -- --prompts bench/prompts.ts --out bench-results/
```

`bench/prompts.ts` holds the ten spec §11 eval prompts: flower, dog, sword, tree, house, fox, chest, potion, knight, fish.

Bench CSV columns: `prompt, size, palette, generator, critic, repairs, repairPct, rounds, stopReason, orphanCount, paletteUsed, symmetryScore, draftMs, critiqueMs, reviseMs, totalMs`.

**Steps:**

- [ ] **13.1** Write `tests/main/export.test.ts` **first**: `exportPng(doc, 8, path)` writes a 256×256 file for a 32×32 doc; scale 3 is rejected.
- [ ] **13.2** Run. Expected: FAIL.
- [ ] **13.3** Implement `src/main/export.ts`; wire the export button in `GateBar.tsx` and the IPC handler.
- [ ] **13.4** Run. Expected: PASS.
- [ ] **13.5** Implement `bench/run.ts` and `bench/prompts.ts`. Run the full 10-prompt bench against real models.
- [ ] **13.6** Save the CSV to `docs/superpowers/specs/captures/2026-07-28-wave-13-bench.csv` and one exported PNG to `docs/superpowers/specs/screenshots/2026-07-28-wave-13-export.png`.
- [ ] **13.7** Commit.

**Acceptance criteria:**
1. `npm test` green.
2. Bench CSV committed with 10 real rows — reviewer confirms non-zero `totalMs` and a valid `stopReason` per row.
3. Exported PNG committed at the declared scale with correct dimensions.
4. Bench runs headless — no Electron, no window.
5. Only Wave 13 whitelist files touched.

---

## Wave 14 — Final human review gate

**Goal:** A real end-to-end test of every MVP feature, run by the human, mapped feature-by-feature to the spec.

This is a **human gate**, not a subagent gate. Pausing here is the designed outcome.

**Feature checklist, each exercised live against real models:**

| # | MVP feature | Spec ref | How it's exercised |
|---|---|---|---|
| 1 | NL prompt → pixel art | §2, §7.4 | Type a fresh prompt, generate, see a sprite |
| 2 | Canvas 16/32/64 | §2 | Generate one sprite at each size |
| 3 | Curated palettes | §6.1a | Generate with `pico-8` and with `gameboy` (4-color) |
| 4 | Deterministic linter | §6.5 | Introduce an orphan pixel by hand; confirm the warning |
| 5 | Vision critique with regions | §6.4 | Click an issue; confirm the region highlights correctly |
| 6 | Split confidence | §6.4 | Find a low-`suggestConfidence` issue; confirm `suggest` is withheld |
| 7 | Bounded revise loop | §6.6 | Watch a round change pixels; confirm turn cap respected |
| 8 | Auto-converge ≤3 rounds | §7.2 | Confirm the stop reason shown matches what fired |
| 9 | User feedback loop | §7.3 | Type feedback at the gate; confirm another round runs |
| 10 | Accept any round | §9 | Scrub to an earlier round and accept it |
| 11 | Manual editing | §2 | Paint pixels by hand |
| 12 | PNG export | §2 | Export at 8×; open the file |
| 13 | Model pickers | §2 | Swap the critic model; confirm the next run uses it |
| 14 | Version history | §6.7 | Confirm the session JSON round-trips and embeds `config` |

**Steps:**

- [ ] **14.1** Run all 14 checks live. Record results — pass/fail plus observations — to `docs/superpowers/specs/captures/2026-07-28-wave-14-e2e.txt`.
- [ ] **14.2** Screenshot each of the 14 features to `docs/superpowers/specs/screenshots/2026-07-28-wave-14-<n>-<feature>.png`.
- [ ] **14.3** Measure the spec §11 acceptance criteria against the Wave 13 bench CSV. Record actual numbers.
- [ ] **14.4** **Escalate to the human**: present the results and the §11 bars, with the provisional human-rating criterion for their ruling. This is the ratification point.
- [ ] **14.5** Patch the spec with a `docs(spec):` commit recording actual measured values in place of the provisional guesses in §11 and §12.

**Acceptance criteria:**
1. All 14 features exercised live with committed evidence.
2. Spec §11's four objective bars measured with real numbers.
3. The human has ruled on the subjective bar.
4. Spec patched so the doc at HEAD is more honest than the one we started with.

---

## Self-review

**Spec coverage.** Every spec section maps to a wave: §5.1–5.2 → W1/W10; §6.1–6.1a → W1; §6.2–6.3 → W2/W6; §6.4 → W7; §6.5 → W3; §6.6 → W8; §6.7–6.8 → W1/W9; §7.1–7.3 → W9; §7.4 → W6/W7/W8; §8 → W11/W12; §9 → W6–W9 error paths + W12; §10 → every wave's tests plus W5's live smoke; §11 → W13 bench + W14 gate; §12 → W14.5 patches it; §13 deferred, correctly absent.

**Placeholder scan.** No "TBD," no "add error handling," no "similar to Wave N." The one deliberate deviation from `writing-plans` — test bodies named rather than pre-written — is declared up front with its reasoning rather than left silent.

**Type consistency.** `SpriteDoc`, `Grid`, `LintReport`, `CritiqueReport`, `HarnessConfig`, `SessionHistory`, `PipelineEvent` are defined once in W1/W2 and referenced identically thereafter. `filterIssues` has one signature (W7) used unchanged in W9. `setPixel` takes `paletteSize` in W2 and is called that way in W8. `charIndex` returns `-1` for transparent in W2 and W3 relies on that.

**One gap found and closed:** `PixelDiff` was used by `history.appendRound` in W9 but only implied in W1. It is now explicitly in W1's exported schema list.
