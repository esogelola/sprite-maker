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

Captures may be `.txt` or `.csv`. These paths are **implicitly whitelisted for every wave** — see the standing exception under the scope table. Without that clause this rule and the whitelist rule contradict each other, and a reviewer applying both would reject a wave that did everything right.

## Design lock

The editor layout was ratified by the user against an interactive prototype during brainstorming. That prototype is committed **alongside this plan** (before Wave 1) as `docs/superpowers/specs/design/2026-07-28-editor-layout-b.html` and is the **ruled design** for Waves 11–12. Visual gates judge rendered screenshots against it, with the prototype as the "better than / worse than" axis.

Two limits on that, both found by the audit:

- **Where the prototype and spec §8 disagreed about the critique dock, the prototype won** (ruling R2). The dock renders whenever a critique exists, including a converged one. Spec §8 has been patched to match.
- **The prototype has no empty state** — it loads with the fox already drawn and rounds 1–3 as pending placeholders. So Wave 12's required first-run screenshot is judged against **written criteria, not the prototype**. A gate that can only compare against a populated design cannot judge the state where the design has nothing to hold.

---

## Wave scope table

> **v2 — 2026-07-29.** Waves 3–14 were rewritten after the consistency audit (see `docs/superpowers/specs/2026-07-29-consistency-audit-findings.md`). Waves 1 and 2 below are the historical record of what shipped and are not re-executed. **Wave 2c is new** — it exists because the audit found that no wave after Wave 1 could modify `src/shared/schema.ts`, which stranded amendment A2 and every subsequent schema-shaped finding.

| Wave | New files | Modified files |
|------|-----------|----------------|
| 1 | `package.json`, `tsconfig.json`, `electron.vite.config.ts`, `vitest.config.ts`, `src/shared/schema.ts`, `src/shared/palettes.ts`, `tests/shared/schema.test.ts`, `tests/shared/palettes.test.ts`, `README.md` | `.gitignore` |
| 2 | `src/shared/grid.ts`, `tests/shared/grid.test.ts` | — |
| 2b | — | `src/shared/grid.ts`, `tests/shared/grid.test.ts`, `src/shared/schema.ts`, `tests/shared/schema.test.ts` |
| **2c** | — | `src/shared/schema.ts`, `tests/shared/schema.test.ts` |
| **2d** | — | `src/shared/schema.ts`, `tests/shared/schema.test.ts` |
| 3 | `src/main/lint.ts`, `tests/main/lint.test.ts`, `tests/fixtures/sprites.ts` | — |
| 4 | `src/main/render.ts`, `tests/main/render.test.ts`, `tests/fixtures/golden/*.png` | `package.json`, `tests/fixtures/sprites.ts` |
| 5 | `src/main/ollama.ts`, `src/main/models.ts`, `tests/main/ollama.test.ts`, `tests/main/models.test.ts`, `tests/stubs/ollama.ts`, `tests/live/smoke.test.ts` | `package.json` |
| 6 | `src/main/draft.ts`, `src/main/prompts/draft.ts`, `tests/main/draft.test.ts` | `tests/stubs/ollama.ts` |
| 7 | `src/main/critique.ts`, `src/main/prompts/critique.ts`, `tests/main/critique.test.ts` | `tests/stubs/ollama.ts` |
| 8 | `src/main/revise.ts`, `src/main/prompts/revise.ts`, `tests/main/revise.test.ts` | `tests/stubs/ollama.ts`, `src/main/ollama.ts` |
| 9 | `src/main/history.ts`, `src/main/pipeline.ts`, `tests/main/pipeline.test.ts`, `tests/main/history.test.ts` | `tests/stubs/ollama.ts`, `src/main/draft.ts`, `tests/main/draft.test.ts`,  |
| 10 | `src/main/index.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `tests/main/ipc.test.ts`, `playwright.config.ts`, `e2e/boot.spec.ts` | `package.json`, `electron.vite.config.ts` |
| 11 | `src/renderer/components/Canvas.tsx`, `src/renderer/components/PaletteBar.tsx`, `src/renderer/state/store.ts`, `tests/renderer/Canvas.test.tsx`, `e2e/canvas.spec.ts` | `src/renderer/App.tsx`, `package.json` |
| 12 | `src/renderer/components/PromptBar.tsx`, `CritiqueDock.tsx`, `Filmstrip.tsx`, `GateBar.tsx`, `StatusBar.tsx`, `ModelPickers.tsx`, `e2e/loop.spec.ts` | `src/renderer/App.tsx`, `src/renderer/state/store.ts`, `src/renderer/components/Canvas.tsx` |
| 13 | `src/main/export.ts`, `bench/run.ts`, `bench/prompts.ts`, `tests/main/export.test.ts` | `package.json`, `tsconfig.json`, `src/main/ipc.ts`, `src/renderer/components/GateBar.tsx` |
| 14 | — | `docs/superpowers/specs/2026-07-28-sprite-maker-design.md` |

A reviewer's first check is always: *did the implementer touch only the files in this row?* Anything outside triggers automatic rejection. Whitelist expansion requires human escalation.

**Standing exception — evidence artifacts.** Files under `docs/superpowers/specs/screenshots/` and `docs/superpowers/specs/captures/` whose names carry this wave's number are **implicitly whitelisted for every wave**, and are not scope creep. Without this clause the plan told reviewers to reject any file outside the row *and* to reject a wave whose required evidence was missing — a contradiction that fired on Waves 5, 9, 10, 11, 12 and 13, and would have rejected a wave that did everything right or taught an implementer to skip the capture.

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
  criticUpscale: 16,          // ← SUPERSEDED, see below
  callTimeoutMs: 120000,
  models: { generator: "qwen3:8b", critic: "qwen3-vl:8b-instruct-q4_K_M" },
}
```

> **Historical record — this literal is no longer current.** Wave 1 shipped exactly the above, and it is still what `src/shared/schema.ts` contains until Wave 2c runs. But `criticUpscale` is **superseded by `criticTargetPx` (default 512)** in spec §6.8, because a fixed multiplier renders 64×64 to 1024px for the vision encoder to throw away. Read spec §6.8, not this block, for the current shape.
>
> This annotation exists because a stale literal in this plan has already caused two defects: the pre-A4 `normalize` body (which an implementer would have copied verbatim) and Wave 2's acceptance criterion 3. A code block in a plan is read as authoritative whether or not it is labelled as history.

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
export function normalize(rows: string[], w: number, h: number, paletteSize: number):
  { grid: Grid; repairs: number; repairedRows: number[] }
export function getPixel(g: Grid, x: number, y: number): string
export function setPixel(g: Grid, x: number, y: number, ch: string, paletteSize: number): Grid
export function fillRow(g: Grid, y: number, x0: number, x1: number, ch: string, paletteSize: number): Grid
export function diff(a: Grid, b: Grid): PixelDiff[]
```

**`normalize` is given literally** — it implements spec §6.3 and is the single most defect-prone function in the codebase:

```ts
export function normalize(rows: string[], w: number, h: number, paletteSize: number) {
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
      else if (c === TRANSPARENT) { out += c }                         // always valid
      else if (charIndex(c) >= 0 && charIndex(c) < paletteSize) { out += c }  // in palette
      else { out += TRANSPARENT; rowRepairs++ }                        // invalid or off-palette
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
3. `normalize(["ab"], 4, 1, 16)` returns `repairs === 2` (2 pad) and `grid === ["ab.."]`. Reviewer runs this exact call.

   **Amendment P5:** this criterion originally asserted `repairs === 4` and `["...."]`, reasoning "2 invalid chars → transparent, 2 pad". That was wrong — `a` and `b` are palette indices 10 and 11 per spec §6.1, so they survive at any palette size ≥ 12. The plan contradicted itself while the spec and the plan's own literal `normalize` agreed with each other. The implementer refused to conform and reported it; a reviewer traced it independently and ruled the same way.

   Three cases are now pinned, and the third only exists because of A4: `normalize(["ab"], 4, 1, 16)` → `["ab.."]`, 2 repairs; `normalize(["AB"], 4, 1, 16)` → `["...."]`, 4 repairs (the case P5's original arithmetic actually described, uppercase being invalid); and `normalize(["ab"], 4, 1, 4)` → `["...."]`, 4 repairs — the same input as the first case, now off-palette against a 4-colour ramp. That last pair is the clearest statement of what A4 changed: the answer depends on the palette, and a criterion written without one is not answerable.
4. `setPixel` does not mutate its input — reviewer asserts the original grid is unchanged after the call.
5. No imports from `main/`, `renderer/`, `electron`, `fs`, or `node:*` in `grid.ts`.
6. Only Wave 2 whitelist files touched.

---

## Wave 2c — Schema completion

**Goal:** Land every schema-shaped finding from the audit in one file, so no later wave needs to reach into `src/shared/schema.ts`. This wave exists because the audit found that no wave after Wave 1 could modify the schema — which stranded amendment A2 (ratified in a `docs(spec):` commit and never implemented) and had nowhere to put `draftFailures`.

**Everything here is defined in spec §6.5, §6.7, §6.8 and §6.9. Read those first; this list is the checklist, the spec is the contract.**

| Change | Why |
|---|---|
| **Delete** `LintReport.errors` | Ruling R3. A4 made every violation it could describe unrepresentable before `lint()` is called |
| `LintWarning.indices?: number[]` | Consumers had to regex free text to learn which palette index a warning concerns |
| `symmetryScore` documented as `1` for a blank sprite | `0/0 = NaN` fails the schema bounds and serializes to `null` |
| `SizeSchema` → union of three **square** literals | v1 admitted `{w:16, h:64}`; every consumer assumed square |
| `Round`: add `filteredIssues`, `userFeedback`, `revise`, `timings`; make `diffFromPrev` nullable | Each is a field some consumer needed and no producer had. Nullable `diffFromPrev` is the one that matters most — see below |
| `SessionHistory`: add `draftFailures`, `stopReason`, `finalState`, `outcome`, `acceptedRound` | Same |
| `PipelineState`, `StopReason`, `PipelineEvent` move here from `main/pipeline.ts` | Preload and renderer consume them; a value import of `main/pipeline` pulls `node:http` into the renderer bundle |
| `HarnessConfig`: `criticUpscale` → `criticTargetPx` (default 512) | A fixed multiplier sends 64×64 to 1024px for the encoder to discard |
| `CritiqueReport`: `degraded: boolean`, `overall` and `readsAs` nullable | A degraded report had to invent a score, which then polluted every bench metric |
| `ChatMessage`, `ToolCall`, `ChatTurn`, `ToolDef` types added | Wave 5 produces them, but preload and the stub need them and neither may import from `main/` |

**The `diffFromPrev` nullability is the sharpest edge here.** Non-nullable made "this is the first round" and "the revise stage changed nothing" the *same value*, and spec §6.7 v1 pointed the stop condition directly at the stored field. An implementation following the spec literally stopped every run after the draft with a bogus `empty-diff`. Nullable makes the distinction representable; §7.2 makes it moot by evaluating `empty-diff` on the transition instead.

- [ ] **2c.1** Write the failing tests first, one per row of the table above. For the deletions, assert the field is *gone* (`"errors" in parsed === false`). For `SizeSchema`, assert `{w:16,h:64}` fails. For `diffFromPrev`, assert `null` parses and that `null` and `[]` are distinguishable.
- [ ] **2c.2** Run. Expected: FAIL.
- [ ] **2c.3** Implement.
- [ ] **2c.4** Run. Expected: PASS. Existing tests must still pass except those asserting deleted fields.
- [ ] **2c.5** Add one off-palette fixture at **32×32** — amendment A4 is currently pinned only at 16×16 and only at palette sizes 4 and 16, which the Wave 2b reviewer flagged as a surviving mutant class.
- [ ] **2c.6** Commit.

**Acceptance criteria:**
1. `npm test` green; `npx tsc --noEmit` clean.
2. `LintReportSchema.parse({...})` **rejects** an object carrying `errors`.
3. `SizeSchema` rejects `{w:16, h:64}` and accepts all three squares.
4. `RoundSchema` accepts `diffFromPrev: null` and `diffFromPrev: []` as distinct values.
5. `SessionHistorySchema.parse({})` fails; a fully-populated history round-trips through `JSON.stringify`/`parse` unchanged.
6. An off-palette index is rejected at 32×32, not only 16×16.
7. Only Wave 2c whitelist files touched.

---

## Wave 2d — Schema closure

**Goal:** Land the last three schema items, so that from here to Wave 14 no wave needs `src/shared/schema.ts` and the B04 failure mode is genuinely over. Two came from Wave 2c's own read-ahead; one from its reviewer.

| Change | Why |
|---|---|
| `SessionHistory.error: string \| null` | `draftFailures` covers only draft rejection. An `OllamaTimeoutError` during `CRITIQUING` is not a draft failure and nothing else could hold it — so a persisted history could not say why it failed, while spec §8 specifies the status bar to read failure state from that artifact |
| `SessionHistory.schemaVersion: 1` **and** `HarnessConfigSchema` becomes `strictObject` | A lenient config schema silently drops an unrecognized key and substitutes the current default, so an artifact from an older run re-parses claiming limits it never used. That is precisely the confusion §6.8 exists to prevent, and `SessionHistory` had no other staleness signal |
| `Round.round` and `SpriteDoc.meta.round` → `z.int().positive()` | Both were `nonnegative()`, so `round: 0` parsed even though §7.5 pins the draft as round 1. The schema could not catch a 0-based Wave 9 |

- [ ] **2d.1** Write the failing tests first: a history carrying `error: "..."` parses and `error: null` parses, but the field is required; `schemaVersion` is required and pinned to `1`; `HarnessConfigSchema.parse({ criticUpscale: 16 })` **throws** rather than silently substituting `criticTargetPx: 512`; `round: 0` is rejected on both `Round` and `SpriteDoc.meta`.
- [ ] **2d.2** Run. FAIL. **2d.3** Implement. **2d.4** Run. PASS — existing tests must survive except fixtures needing the two new required fields.
- [ ] **2d.5** Commit.

**Acceptance criteria:**
1. `npm test` green; `npx tsc --noEmit` clean.
2. `HarnessConfigSchema.parse({ criticUpscale: 16 })` throws. **This is the one that matters** — silently accepting it is how a stale artifact misreports its own run.
3. `SessionHistorySchema` requires `schemaVersion` and `error`.
4. `round: 0` rejected on both `Round` and `SpriteDoc.meta`.
5. No existing test weakened — report every fixture changed and why.
6. Only Wave 2d whitelist files touched.

---

## Wave 3 — `main/lint.ts`

**Goal:** The deterministic half of the review system. Spec §6.5 defines all five codes, their cardinality, and their `cells`/`indices` contents — **implement exactly that table and invent nothing.**

**Interfaces produced:** `export function lint(doc: SpriteDoc): LintReport`

Three things the audit found that would otherwise bite:

- **Neighbour reads must be lenient.** `orphan-pixel` and `outline-gap` are defined with "out-of-canvas counts as transparent", but `shared/grid.ts`'s `getPixel` **throws** out of bounds. Define a local `at(g, x, y)` returning `TRANSPARENT` outside the canvas. Do not add a lenient reader to `grid.ts` — out of whitelist, and strictness is correct there.
- **`low-contrast` needs `i < j` and transparent exclusion.** `i === j` has Δluminance 0, so without the distinctness guard every filled sprite reports low-contrast against itself. And `charIndex('.')` is `-1`, so `colors[-1]` is `undefined` and the luminance parser crashes on the first sprite with a transparent neighbour — that is, all of them.
- **Do not reimplement the luminance formula with rounding.** `gameboy` indices 2 and 3 sit 0.0006 below the 0.08 threshold. They are the canary.

- [ ] **3.1** Write `tests/fixtures/sprites.ts`. **Every fixture is the return value of `SpriteDocSchema.parse(...)` on an untyped object literal — never a bare `: SpriteDoc =` annotation.** The refinements are runtime-only, so a typed fixture silently bypasses row-count, row-length and off-palette validation, and `lint()` would then be tested against states that cannot occur in production. Fixtures: `SOLID_BLOCK`, `BLANK`, `ONE_ORPHAN`, `DIAGONAL_ONLY`, `HORIZONTAL_GAP`, `VERTICAL_GAP`, `LOW_CONTRAST_PAIR`, `PERFECT_MIRROR`, `FULLY_ASYMMETRIC`, plus at least one **32×32** and one using index 3 (Wave 4 needs both and cannot create them).

  **Every fixture's `meta.round` must be `1`, not `0`.** Wave 2d tightened `SpriteDoc.meta.round` to `positive()` because §7.5 pins the draft as round 1. Since fixtures are `SpriteDocSchema.parse(...)` calls evaluated at module load, a literal carrying `round: 0` **throws at import** and takes the whole fixture file down with it — an error that surfaces as every lint test failing to collect, pointing nowhere near the cause.

  **`SOLID_BLOCK` is pinned concretely**: 16×16 on `gameboy`, four horizontal bands in index order `0, 2, 1, 3`. This is the only shape that yields zero warnings — it uses all four indices (so no `unused-palette-entry`) and places no sub-threshold pair orthogonally adjacent (0↔2 Δ 0.32, 2↔1 Δ 0.254, 1↔3 Δ 0.334). "Zero warnings" is a property of the palette *and* the sprite, not the sprite alone: every bundled 16-colour palette carries 15–25 low-contrast pairs.

  Fixtures needing a contrived palette inline a `palette: { id, colors }` literal. `lint()` must therefore read `doc.palette.colors` and **never** `getPalette(doc.palette.id)`, which would throw.

- [ ] **3.2** Write `tests/main/lint.test.ts` first: one test per code asserting exact `cells`, `indices` and **cardinality**; `DIAGONAL_ONLY` yields an orphan (the definition's sharp edge); a sprite with 30 adjacent low-contrast pairs of the same two indices yields **one** warning; `SOLID_BLOCK` yields zero warnings of every code; `BLANK` yields `symmetryScore === 1` and `coverage === 0`; `PERFECT_MIRROR` scores 1.0 and `FULLY_ASYMMETRIC` under 0.2.
- [ ] **3.3** Run. FAIL. **3.4** Implement. **3.5** Run. PASS. **3.6** Commit.

**Acceptance criteria:**
1. `npm test` green.
2. A diagonally-attached cell is reported as `orphan-pixel` — reviewer runs `DIAGONAL_ONLY`.
3. `SOLID_BLOCK` yields **zero** warnings of every code, including `low-contrast` despite hundreds of same-index adjacencies.
4. `BLANK` yields `symmetryScore === 1`, not `NaN`.
5. `low-contrast` deduplicates per index pair and carries the pair in `indices`.
6. Every fixture export is a `SpriteDocSchema.parse` return value — reviewer greps for `: SpriteDoc =` and finds none.
7. `lint()` performs no I/O and never calls `getPalette`.
8. Only Wave 3 whitelist files touched.

---

## Wave 4 — `main/render.ts`

**Goal:** Grid → PNG, nearest-neighbour, at a scale factor.

**Interfaces produced:**

```ts
export function toPng(doc: SpriteDoc, scale: number, background?: string): Buffer
export function pickCriticBackground(doc: SpriteDoc): string   // hex, max luminance distance
```

**`background` exists because transparency composites to black for the vision encoder** — verified empirically (spec §4.5, capture `2026-07-29-transparency-vlm-probe.txt`). Shown a half-transparent, half-opaque-black image, `qwen3-vl` reported *"No visible differences."* Since `pico-8` index 0 is `#000000`, a black-outlined sprite on transparency loses its whole silhouette, which is exactly what §4.4 asks the image to judge.

`pickCriticBackground` returns the hex with maximum WCAG luminance distance from the palette entries the sprite **actually uses** — computed, not fixed, because `nes-16` and `db16` both carry mid-greys and a hardcoded grey would reintroduce the defect for sprites using them.

**Omitting `background` preserves alpha.** Export must never composite; only the critique path passes one.

**`toPngWithGrid` is deleted from the design.** v1 specified it "solely to ground the critic's coordinates", but Wave 7 sends `toPng` plus the raw row text, and spec §4.4's stated mitigation *is* the text grid. It would have shipped untested, unused, with its rule colour and alpha behaviour unspecified.

- [ ] **4.1** Write `tests/main/render.test.ts` first: `toPng(doc, 1)` decodes to `size`; `toPng(doc32, 16)` yields 512×512; a transparent cell decodes to alpha 0; **all 256 sub-pixels of one source cell at 16× carry identical RGBA** (this is what proves nearest-neighbour rather than smoothing); `toPng(doc, 0)` throws.
- [ ] **4.2** Run. FAIL. **4.3** Implement with `pngjs`. **4.4** Run. PASS.
- [ ] **4.5** Pin `pngjs` to an **exact** version in `package.json`. A caret range means a minor bump changing deflate parameters silently breaks the golden file during some later wave's `npm install`.
- [ ] **4.6** Golden-file test: render the 32×32 fixture at 8×, commit the PNG, assert byte equality. **The test must FAIL if the golden file is absent** — a write-then-compare passes trivially on the run that mints it.
- [ ] **4.7** Commit.

**Acceptance criteria:**
1. `npm test` green.
2. Every one of the 256 sub-pixels of a source cell at 16× carries identical RGBA — reviewer verifies by decoding, not by reading code.
3. Transparent decodes to alpha 0, not white.
4. Golden committed and byte-stable across two consecutive runs; deleting it turns the test red rather than regenerating it.
5. `pngjs` is pinned exactly.
6. Only Wave 4 whitelist files touched.

---

## Wave 5 — `main/ollama.ts` + `main/models.ts` + the stub

**Goal:** The single HTTP boundary, the role registry, and **the stub that Waves 6–9 depend on**.

Interfaces are defined in spec §6.9. `ChatMessage.tool_calls` is not optional decoration — without it the Wave 8 revise loop cannot continue a tool conversation at all.

**`StubScript` is pinned here, literally.** v1 named it "the load-bearing test fixture for Waves 6–9" and never defined it, so four waves would have asserted against a recording surface with no declared shape:

```ts
export interface RecordedCall {
  method: "generate" | "vision" | "chatWithTools" | "listModels"
  model: string; system?: string; prompt?: string
  images?: Buffer[]; messages?: ChatMessage[]; tools?: ToolDef[]
  options?: Record<string, unknown>; format?: string
}
export interface StubScript {
  generate?: string[]          // consumed in order; the last is reused when exhausted
  vision?: string[]
  chatWithTools?: ChatTurn[]
  models?: string[]
}
export interface StubClient extends OllamaClient {
  calls: RecordedCall[]
  reset(): void
}
export function createStubClient(script: StubScript): StubClient
```

Waves 6–9 may **modify** this file to extend the script surface — they are in its Modified column precisely so that discovering a missing capability is a normal edit rather than an escalation.

**Pre-authorised escalation:** `ToolDef`'s shape was invented in Wave 2c (spec §6.9 names `ChatMessage`, `ToolCall` and `ChatTurn` but not `ToolDef`), using Ollama's OpenAI-compatible envelope `{ type: "function", function: { name, description, parameters } }`. If the wire format differs, `src/shared/schema.ts` is **not** in this wave's whitelist — escalate rather than working around it. This is the B04 failure mode in miniature, and it is flagged here so it is a decision rather than a surprise.

- [ ] **5.1** Write `tests/stubs/ollama.ts` to the shape above.
- [ ] **5.2** Write `tests/main/ollama.test.ts` first, against a real local `http.createServer` fixture (not a `fetch` mock): `generate` posts `/api/generate` with `stream:false`; `vision` base64-encodes into `images` and forwards `options`/`format`; **`chatWithTools` posts `/api/chat`, marshals the tool array, and maps `message.tool_calls` to `ChatTurn.toolCalls` with `id`, `name` and parsed `arguments`** — this is Wave 8's only model path and the highest wire-format risk, and v1 left it untested; `listModels` parses `/api/tags`; connection refusal throws `OllamaUnreachableError` naming the endpoint; an `AbortSignal` cancels in flight and surfaces `OllamaTimeoutError(model, elapsedMs)` (the server fixture can simply hang).
- [ ] **5.3** Run. FAIL. **5.4** Implement `ollama.ts`.
- [ ] **5.5** Write `tests/main/models.test.ts`: `roles()` returns config defaults; **`bind()` writes through to the live `HarnessConfig.models`** — not to registry-local state, or the pipeline never sees the change *and* the config recorded in history names the wrong model, defeating the whole point of §6.8; `list()` delegates.

  **`bind()` must spread `cfg.models`, not decorate it.** Wave 2d made `HarnessConfigSchema` and its nested `ModelsSchema` strict, so any extra key added to the models object now **throws** on the next `parse` rather than being silently dropped. The same applies to Waves 10 and 12: whatever the renderer hands back to `HarnessConfigSchema.parse` must carry only known keys — a UI-only field tacked onto the config object will throw in the renderer path.
- [ ] **5.6** Implement `models.ts`. Run all. PASS.
- [ ] **5.7** Write `tests/live/smoke.test.ts`, guarded with an in-file `describe.skipIf(!process.env.LIVE)` — `vitest.config.ts` is not in this whitelist and its include glob would otherwise run it during `npm test`. Add the `test:live` script.
- [ ] **5.8** Run `npm run test:live` once; save raw output to `captures/2026-07-28-wave-5-live-smoke.txt`. Commit.

**Acceptance criteria:**
1. `npm test` green **with Ollama stopped** — reviewer confirms by stopping it.
2. `npm run test:live` passes with Ollama running; capture committed with real model output.
3. `chatWithTools` round-trips a tool call through the HTTP fixture — asserted, not assumed.
4. `bind("critic", m)` is observable in the `HarnessConfig` a subsequent `run` would receive.
5. `OllamaTimeoutError` carries the model and elapsed ms.
6. Grepping `src/` for `fetch(`, `http.request` or `axios` outside `ollama.ts` returns zero hits.
7. Only Wave 5 whitelist files touched.

---

## Wave 6 — `main/draft.ts`

**Goal:** Prompt → generator → repaired `SpriteDoc`.

```ts
export function buildDraftPrompt(input: { prompt: string; size: Size; palette: Palette }): { system: string; user: string }
export function parseDraft(raw: string, size: Size, palette: Palette):
  { grid: Grid; intent: Intent; repairs: number; repairedRows: number[] }
export async function draft(deps: { client: OllamaClient }, input: { prompt; size; paletteId }, cfg: HarnessConfig): Promise<SpriteDoc>
export class DraftRejectedError extends Error { constructor(public repairs: number, public raw: string) }
```

Four corrections from the audit:

- **`normalize` takes four arguments.** Pass `palette.colors.length`. (v1's plan text still showed the 3-argument palette-blind version and its literal body — corrected in the Wave 2 section above.)
- **The threshold is an unbounded ratio**: `repairs / (w × h) > cfg.repairRejectThreshold`. `repairs` can exceed the cell count — 100 rows on a 16×16 canvas charges 1344 against 256.
- **`parseDraft` never throws.** The prompt must require `{ intent: {subject, …}, rows: [...] }`. Unparseable output yields `rows: []` and `intent: { subject: input.prompt }`; `normalize` then charges `w × h` repairs, ratio 1.0, routing into the existing retry path. v1 left this undefined, so a prose-only response escaped the state machine as an unhandled rejection.
- **Palette colors are `readonly`** (frozen singletons). Copy when building the doc: `colors: [...palette.colors]`.

- [ ] **6.1** Write `tests/main/draft.test.ts` first, driving `draft()` with the Wave 5 stub: clean response → `repairs === 0`; three short rows → correct count **and `meta.repairedRows` naming those exact indices**; over-threshold → exactly one retry (assert `stub.calls.length === 2`) whose prompt **names the defects by kind** ("row 4 used index 9, this palette has 4 colours" is a different instruction from "row 4 was 12 chars"); second over-threshold → `DraftRejectedError` carrying the raw output; a prose-only response routes through the same retry path rather than throwing; `buildDraftPrompt` contains every palette index with its hex and the required output shape, and `draft()` sends **`think: false`** on the request (spec A8 — assert on the stub's recorded call, not on the prompt text; the `/no_think` prefix this criterion used to require was measured to be inert).
- [ ] **6.2** Run. FAIL. **6.3** Implement. **6.4** Run. PASS. **6.5** Commit.

**Acceptance criteria:**
1. `npm test` green.
2. Retry fires exactly once at `maxDraftRetries: 1` — `stub.calls.length === 2`, not 3.
3. **`meta.repairs` AND `meta.repairedRows` both equal `normalize`'s outputs.** A doc with `repairs > 0` and `repairedRows: []` is a defect — `repairedRows` has a `[]` default, so a `draft()` that forgets it parses clean while claiming nothing was repaired, and `row-repaired` would then never fire in production.
4. A prose-only model response does not throw; it retries and then raises `DraftRejectedError`.
5. Every model call is wrapped in an `AbortController` armed with the area-scaled `callTimeoutMs`.
6. Only Wave 6 whitelist files touched.

---

## Wave 7 — `main/critique.ts`

**Goal:** Vision critique with repair, clamping, and the two-tier confidence filter. Spec §6.4 is the contract.

```ts
export function buildCritiquePrompt(doc: SpriteDoc, lint: LintReport): { system: string; user: string }
export function repairCritique(rawJson: unknown, size: Size): unknown   // BEFORE schema validation
export function parseCritique(raw: string, size: Size): CritiqueReport
export function filterIssues(report: CritiqueReport, cfg: HarnessConfig): CritiqueReport
export async function critique(deps, doc, lintReport, cfg): Promise<CritiqueReport>
```

`filterIssues` is pinned literally — the two-tier behaviour is easy to invert:

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

**Repair runs on the raw JSON before validation** (§6.4's table). `Coord` is non-negative, so a partly-valid region like `[-5,-5,3,3]` — the most common VLM error — would otherwise fail the schema, consume the single reprompt, and degrade the whole report to zero issues.

The call sends the upscaled PNG at `scale = max(1, floor(cfg.criticTargetPx / size.w))`, **composited onto `pickCriticBackground(doc)`** (spec §4.5 — without it a dark-outlined sprite has no silhouette), the raw row text, and `format: "json"`.

**`repairCritique` also repairs a missing `overall` or `readsAs` to `null`.** Both became nullable in Wave 2c so a degraded report need not invent a score — but a *live* critic omitting either would still fail validation and burn the single reprompt. §6.4's repair table does not list them because they were non-nullable when it was written.

- [ ] **7.1** Write `tests/main/critique.test.ts` first: `confidence 0.2` with floor `0.3` → dropped; **`confidence 0.9 / suggestConfidence 0.4` → KEPT with `suggest === ""`** (dropping the whole issue here is the defect this test exists to catch); `0.9/0.6` keeps its suggest; region `[30,30,99,99]` on 32×32 clamps; `[-5,-5,3,3]` clamps rather than failing validation; reversed regions normalize; entirely-outside drops; missing `id` is synthesized rather than failing the report; non-JSON → exactly one reprompt containing the validation error; second failure → `degraded: true`, `overall: null`, `issues: []` — never a throw and never an invented score; `critique()` sends exactly one image plus the row text plus `format: "json"`.
- [ ] **7.2** Run. FAIL. **7.3** Implement. **7.4** Run. PASS.
- [ ] **7.5** Capture one real critic response to `captures/2026-07-28-wave-7-critic-sample.txt` and use it as a contract-test fixture, so the suite fails when real models drift. Commit.

**Acceptance criteria:**
1. `npm test` green.
2. The `0.9 / 0.4` case keeps the issue and empties `suggest`.
3. A critic response missing only `id` produces a valid report, not a degraded one.
4. Two unparseable responses yield `degraded: true` with `overall: null` — a broken critic must not destroy a valid sprite, and must not be recorded as a score.
5. Negative-coordinate regions clamp rather than failing validation.
6. Real critic output captured and committed.
7. Only Wave 7 whitelist files touched.

---

## Wave 8 — `main/revise.ts`

**Goal:** The bounded agentic loop — the one place the model drives.

```ts
export const REVISE_TOOLS: ToolDef[]      // place_pixel, fill_row, done
export async function revise(deps: { client; onTurn?: (n: number) => void },
  doc: SpriteDoc, issues: Issue[], cfg: HarnessConfig
): Promise<{ grid: Grid; turns: number; hitCap: boolean; summary: string }>
```

**`revise` returns a `Grid`, not a `SpriteDoc`.** The pipeline owns `meta` construction (spec §7.5) — otherwise a revised doc silently inherits the draft's `id`, `round`, `createdAt` and `parentId: null`, so every round shares one identity and the lineage field is permanently inert.

Four behaviours the audit pinned:

- Append the assistant's turn **including `tool_calls`** before the tool results, or the model re-issues calls it already made.
- An invalid tool call returns an error **string**, never throws, and counts against the cap.
- **Numeric strings are coerced** before validation — a model emitting `"3"` is well-formed intent.
- **A turn with zero tool calls counts against the cap** and injects a nudge naming the three tools. This is the most common qwen3 tool-loop behaviour; counting only tool-firing turns spins forever on an identical message array.

Binds to `models.generator`; every call sends **`think: false`** (spec A8). This is the stage where it matters most — 40 turns × up to 3 rounds, each otherwise paying for a reasoning trace nothing reads. Assert it on the stub's recorded call. Calls `onTurn` per turn so Wave 9 can emit live progress — v1's longest stage emitted nothing.

- [ ] **8.1** Write `tests/main/revise.test.ts` first: scripted `place_pixel` then `done` → one pixel changed, `turns === 2`, `hitCap === false`; out-of-bounds `place_pixel` → tool result containing `out-of-bounds`, loop continues; `"3"` as a string is accepted; a script that never calls `done` → stops at `maxReviseTurns` with `hitCap === true`, keeping landed edits; `maxReviseTurns: 2` honoured exactly; a zero-tool-call turn counts and nudges; `fill_row` with `x0 > x1` errors without throwing; off-palette on a gameboy doc errors; `onTurn` fires once per turn; the assistant message appended to the transcript carries `tool_calls`.
- [ ] **8.2** Run. FAIL. **8.3** Implement. **8.4** Run. PASS. **8.5** Commit.

**Acceptance criteria:**
1. `npm test` green.
2. An invalid tool call never throws; the loop continues and the model receives an error string.
3. A zero-tool-call turn advances the counter — reviewer scripts three of them against `maxReviseTurns: 2` and confirms termination.
4. `maxReviseTurns` honoured exactly.
5. The transcript's assistant turns carry `tool_calls` — reviewer asserts on the stub's recorded messages.
6. `revise` returns a `Grid`; grepping for `meta` construction in `revise.ts` returns nothing.
7. Only Wave 8 whitelist files touched.

---

## Wave 9 — `main/history.ts` + `main/pipeline.ts`

**Goal:** The state machine. **The wave that most needs an independent reviewer**, and the one whose v1 design was most wrong.

```ts
export interface PipelineDeps {
  client: OllamaClient
  onEvent: (e: PipelineEvent) => void
  persist?: (h: SessionHistory) => Promise<void>
}
export async function run(deps, input: { prompt; size; paletteId }, cfg): Promise<SessionHistory>
export async function applyFeedback(deps, history, feedback: string, roundIndex: number, cfg): Promise<SessionHistory>
export async function accept(history: SessionHistory, roundIndex: number): Promise<SessionHistory>

// history.ts
export function createHistory(sessionId: string, cfg: HarnessConfig): SessionHistory
export function appendRound(h: SessionHistory, r: Round): SessionHistory
export function completeRound(h: SessionHistory, index: number,
  patch: { revise: ReviseSummary; reviseMs: number }): SessionHistory   // phase two
export async function saveHistory(h: SessionHistory, dir: string): Promise<string>
```

Spec §7.1 is the contract. The five things v1 got wrong, each now a required test:

1. **The round is snapshotted at the top of every iteration**, after `CRITIQUING`, before any revision. v1 snapshotted only on the `REVISING` exit, so a run converging on its first critique returned `rounds: []`.

   **A round is written in two phases** (spec §6.7). At snapshot time `revise` and `timings.reviseMs` describe a stage that has not run, so the round is pushed with both `null`, then **replaced in place** after the revise transition completes, then persisted again. `history.ts` therefore needs `completeRound(h, index, { revise, reviseMs })` alongside `appendRound`, and `persist` fires **twice** per revised round — once at snapshot, once at completion.

   Without phase two, `revise` and `reviseMs` are permanently `null` on every round: `turns`, `hitCap` and `summary` become dead exactly as they were before the audit added them, and three of Wave 13's CSV columns silently empty. Buffering the round until after revision is not an alternative — it reintroduces `rounds: []` when `REVISING` times out into `FAILED`, and it starves the `round` event that draws the filmstrip during the longest stage.
2. **`empty-diff` is evaluated as `diff(docBefore, docAfter)` on the revise transition** — never by reading a stored `diffFromPrev`, which is `null` on round 1.
3. **Feedback re-enters at `REVISING`**, and the resulting round's `parentId` points at the round the user was looking at, which may not be the last.
4. **`diffFromPrev` is computed against the parent**, not the array-previous — `applyFeedback` may branch.
5. **The pipeline constructs every `meta`** (§7.5): fresh `id`/`createdAt`, `parentId`, current `round`, and `repairs: 0`/`repairedRows: []` on derived docs.

Plus: `run()` calls `HarnessConfigSchema.parse(cfg)` on entry; the draft is round 1 and `maxRounds` bounds critiques; an empty filtered issue list skips `REVISING` unconditionally; two unparseable critiques stop with `critic-failed`, never `no-high-severity`.

**Four things Wave 2d's read-ahead assigned to this wave.** The schema permits each; nothing else instructs them, and no later wave can add a field if they are missed.

- **Add `onAttempt` to `draft()`'s deps (spec A9) — this is why `src/main/draft.ts` is in this wave's row.** `draftFailures` is an array but `DraftRejectedError` carries only the last attempt, so attempt 1's raw output was unrecoverable. Two rejections with the same defect mean the prompt is wrong; two with different defects mean the model is unstable — keeping only the second makes those indistinguishable, which is the whole diagnostic purpose of the field. Add `onAttempt?: (f: DraftFailure) => void`, fire it once per **rejected** attempt only, pass a collector from the pipeline, and emit a `state` event per attempt so the status bar can say "retrying draft" rather than appearing to hang through a second full generation. `DraftRejectedError`'s signature stays as-is. Wave 6's existing tests must keep passing — the hook is optional.

- **A draft-rejected run must mirror its reason into `SessionHistory.error`.** §6.7 words `error` as "why a run failed, when it wasn't a draft", so a draft rejection currently leaves `stopReason: null` **and** `error: null`, with the reason only in `draftFailures[].reason`. Wave 13's CSV would then be blank in both columns for exactly the runs it most needs to explain, and Wave 12's status bar would show a failure with no cause. Mirror it.
- **Pin the `error` string format in this wave's own tests.** §9 keeps `code`/`message`/`endpoint` separate across IPC precisely because `ipcMain.handle` destroys them — but `SessionHistory.error` is a flat string, and after a reload it is the *only* source for §8's requirement that the status bar name the exact endpoint. Use `"<ErrorName>: <message>"` with the endpoint or model embedded, and test it.
- **Be deliberate about an aborted stage's elapsed time.** On a timeout the round was already snapshotted with `critique: null` and `timings.critiqueMs: null`. Writing the aborted elapsed ms into `critiqueMs` is permitted, but then the artifact distinguishes "critique took 480s and succeeded" from "aborted at 480s" only via `critique === null` plus `error`. Choose, and say which in a comment.
- **`PipelineEvent.round` remains `nonnegative()`** — deliberately, since events fire before round 1 exists. The 1-based invariant holds on `Round.round` and `SpriteDoc.meta.round` but **not** on the event. Do not assume `event.round >= 1`.

- [ ] **9.1** Write `tests/main/history.test.ts`: `createHistory` embeds `cfg` verbatim and sets `outcome: "failed"`; `appendRound` diffs against the **parent**; `completeRound` fills `revise` and `timings.reviseMs` on the round it names and leaves every other field untouched; `saveHistory` round-trips through `SessionHistorySchema`.
- [ ] **9.2** Write `tests/main/pipeline.test.ts` first, entirely against the stub. One test per behaviour: **the happy path produces `rounds.length === 1` and `stopReason === "no-high-severity"`** (v1's test asserted only the event sequence and would have passed against an empty history — assert the rounds); an always-high-severity critic stops at `round-cap` after exactly `maxRounds` critiques; a no-op revise stops with `empty-diff` **before** the cap; **round 1 never stops with `empty-diff`**; a high-severity issue at `confidence: 0.1` does not keep the loop running; two unparseable critiques stop with `critic-failed` and `outcome` is still `"completed"`; `applyFeedback` injects `confidence === 1.0`, records `userFeedback`, and sets `parentId` to the edited round; `DraftRejectedError` → `finalState: "FAILED"`, `outcome: "failed"`, **`draftFailures` holding BOTH attempts** with distinct `raw` values (spec A9 — one entry means the reporter is not wired), and `error` mirroring the reason; a derived doc has a fresh `id` and `repairedRows: []`; `persist` is called once per round; `run()` rejects a config with `maxRounds: 0`.
- [ ] **9.3** Run. FAIL. **9.4** Implement `history.ts` then `pipeline.ts`. **9.5** Run. PASS.
- [ ] **9.6** Save the happy-path event trace to `captures/2026-07-28-wave-9-event-trace.txt`.

- [x] **9.7 — inherited from Wave 8. DONE in `56f6189`, before Wave 9 dispatched.** Wave 8's three surviving mutants are closed and `tests/main/revise.test.ts` is **no longer in this wave's row**. Recorded here because the falsy-zero finding generalizes:

  **Falsy zero is a named defect class in this codebase, not a coincidence.** It has now near-missed twice — Wave 4's `pickCriticBackground` did not count index 0 as *used* (returning `#000000` as the most-distant background for a black-outlined sprite, i.e. spec §4.5's vanishing silhouette reintroduced by the function written to prevent it), and Wave 8's `place_pixel` would have treated `index: 0` as absent under any falsy check. Index 0 is `#000000` in pico-8 and `#140c1c` in db16 — the outline colour of most sprites, so it is the *worst* entry to lose. **Every later wave should probe it explicitly:** any code branching on a palette index, a round number, a coordinate, a turn count or a length needs a zero case.

- [ ] **9.8** Commit.

**Acceptance criteria:**
1. `npm test` green; every stop reason has a dedicated test.
2. **A run converging on its first critique yields `rounds.length === 1`** — reviewer executes this and inspects the array, not the event stream.
3. `Round.lint` and `Round.critique` describe the **same** doc as `Round.doc` — reviewer verifies the lint report matches a fresh `lint(round.doc)`.
4. Round 1 does not stop with `empty-diff`.
5. Filter-then-evaluate: one `severity: "high", confidence: 0.1` issue stops with `no-high-severity` on round 1.
6. Two unparseable critiques stop with `critic-failed`, not `no-high-severity`.
7. Derived docs carry a fresh `id`, correct `parentId`, and `repairedRows: []`.
8. **After a revised round, `rounds[i].revise.turns` and `rounds[i].timings.reviseMs` are populated** — not `null`. Reviewer runs a two-round scenario and inspects round 0. This is the check that catches the two-phase lifecycle being skipped, which would silently empty three bench columns.
9. **A history persisted mid-run reads `outcome: "failed"`.** Only a genuinely completed run flips it to `"completed"` — an interrupted run is a failed run, and §11's first bar reads this field.
10. `acceptedRound` stores `Round.round` (1-based), not the array index it was called with. **Assert on the `SessionHistory` returned by `accept(0)` directly, not only on a `saveHistory` round-trip.** The schema rejects `acceptedRound: 0` at parse time, so an implementation that stores the raw index and validates only on save turns an off-by-one into a save error at the end of a multi-minute run — far from its cause, and only on the path that persists.
11. The whole suite runs with Ollama stopped.
12. Event trace committed showing the real state sequence.
13. Only Wave 9 whitelist files touched.

---

## Wave 10 — Electron shell, build, IPC, Playwright

**Goal:** The app boots, the renderer reaches the pipeline, and there is a **build**. Minimal UI.

**Wave 10 must first make the project buildable at all.** v1 had no build step in 14 waves and no `main` field; electron-vite throws `No entry point found for electron app`, and Playwright's `_electron.launch()` attaches to a built app rather than a dev server.

- `package.json` gains `"main": "./out/main/index.mjs"`, `"dev": "electron-vite dev"`, `"build": "electron-vite build"`.
- **The preload must build as CJS.** `"type": "module"` makes electron-vite emit ESM for preload too, and Electron will not load an ESM preload in a sandboxed renderer — `window.api` is `undefined` and the symptom points at the wrong layer entirely. Pin `output: { format: "cjs", entryFileNames: "[name].cjs" }` and point `webPreferences.preload` at `index.cjs`. **Do not "fix" this with `sandbox: false`.**
- Playwright moves here from Wave 11, because Wave 10's own evidence requirement is a screenshot and an implementer has no other way to take one.

```ts
interface Api {
  listModels(): Promise<string[]>
  getModels(): Promise<{ generator: string; critic: string }>
  bindModel(role: "generator" | "critic", model: string): Promise<void>
  getConfig(): Promise<HarnessConfig>
  getPalettes(): Promise<Palette[]>
  run(input: { prompt; size; paletteId }): Promise<Result<SessionHistory>>
  applyFeedback(feedback: string, roundIndex: number): Promise<Result<SessionHistory>>
  accept(roundIndex: number): Promise<Result<SessionHistory>>
  setPixel(roundIndex: number, x: number, y: number, ch: string): Promise<Result<{ doc: SpriteDoc; lint: LintReport }>>
  exportPng(roundIndex: number, scale: 1|4|8|16): Promise<Result<string>>
  getSessionPath(): Promise<string>
  onEvent(cb: (e: PipelineEvent) => void): () => void
}
type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string; endpoint?: string }
```

Every addition here closes an audit blocker: `bindModel`/`getModels` (model pickers had no wire), `accept` (`DONE` was unreachable), `setPixel` (hand edits never reached main, so exports silently omitted them), `getConfig` (the filmstrip needs `maxRounds`), `getSessionPath` (Wave 14 must open the session JSON).

**`Result<T>` rather than rejection** — `ipcMain.handle` serializes a rejection into a plain `Error` and destroys its fields, discarding the very `endpoint` that spec §9's unreachable-Ollama message is about.

**Main owns the session.** `ipc.ts` holds a module-level `currentSession: SessionHistory | null`, written by `run`/`applyFeedback`/`accept`/`setPixel`. Every round-indexed method resolves against it.

- [ ] **10.1** `package.json`: `main`, `dev`, `build`, `@playwright/test`. `electron.vite.config.ts`: three-target config with the CJS preload pin.
- [ ] **10.2** Write `tests/main/ipc.test.ts` first (with `vi.mock("electron")` — outside Electron, `require("electron")` resolves to a path string): every `Api` method **except `onEvent`** maps to a registered `ipcMain.handle` channel; `onEvent` maps to one `webContents.send` channel; the union is exactly the `Api` keys. *(v1's test asserted `onEvent` was a `handle` channel, which it can never be — the test failed against a correct implementation.)*
- [ ] **10.3** Run. FAIL.
- [ ] **10.4** Implement `src/main/index.ts`, `ipc.ts`, `preload/index.ts`, and a minimal `App.tsx` (prompt, Generate, `<pre>` of rows). **`export-png` registers a handler that throws `not-implemented`** — `src/main/export.ts` is a Wave 13 file, and Wave 10's own test requires every `Api` key registered.
- [ ] **10.5** `npm run build`, then `e2e/boot.spec.ts` launches Electron, generates one sprite against real Ollama, and captures `screenshots/2026-07-28-wave-10-boot.png` programmatically.
- [ ] **10.6** Commit.

**Acceptance criteria:**
1. `npm run build` exits 0 and produces `out/main/index.mjs` and `out/preload/index.cjs`.
2. `npx playwright test` launches the app; **`window.api` is defined** — the direct check for the ESM-preload trap.
3. Screenshot committed showing real generated rows, not an empty box.
4. `contextIsolation: true`, `nodeIntegration: false`, `sandbox` left at its default.
5. The preload exposes exactly the `Api` keys.
6. A failed `listModels` returns `{ ok: false, endpoint }` rather than rejecting.
7. `npm test` still green.
8. Only Wave 10 whitelist files touched.

---

## Wave 11 — Canvas, palette, manual editing (visual gate V1)

```ts
export interface EditorState {
  history: SessionHistory | null; currentRound: number
  activeIndex: string; activeIssueId: string | null
  state: PipelineState; stopReason: StopReason | null; config: HarnessConfig | null
}
```

`PipelineState` and `StopReason` come from `@shared/schema` (moved there in Wave 2c) — never from `@main/pipeline`, which would pull `node:http` into the renderer bundle.

**Manual edits go through `Api.setPixel`.** The renderer sends the edit and receives the updated doc plus a fresh lint report; it does not mutate locally. **An edit to the last round mutates it; an edit to an earlier round appends a new round parented to the one edited** — mutating an earlier round in place would invalidate every later round's `diffFromPrev`, and the filmstrip is defined as replaying those diffs.

**`Canvas.tsx` renders `activeIssueId`'s region with a highlight class.** Wave 12 asserts this behaviour but may not create `Canvas.tsx`, so it is built here.

- [ ] **11.1** State via `useSyncExternalStore` + a module store — no new dependency. Add `jsdom` and `@testing-library/react`; select the environment with a per-file `// @vitest-environment jsdom` docblock, since `vitest.config.ts` is out of whitelist and node is correct for every other suite.
- [ ] **11.2** Write `tests/renderer/Canvas.test.tsx` first: a 16×16 doc renders 256 cells; a transparent cell carries the empty-cell class; clicking a cell calls `Api.setPixel` with the right coords and active index; a cell inside `activeIssueId`'s region carries the highlight class.
- [ ] **11.3** Run. FAIL. **11.4** Implement `Canvas.tsx`, `PaletteBar.tsx`, `store.ts`; wire into `App.tsx`. **11.5** Run. PASS.
- [ ] **11.6** `npm run build && npx playwright test e2e/canvas.spec.ts` — click a swatch, click a cell, assert the colour changed **and that a re-read from main reflects it**. Capture `screenshots/2026-07-28-wave-11-canvas.png`.
- [ ] **11.7** Commit.

**Acceptance criteria:**
1. `npm test` and `npm run build && npx playwright test` both green.
2. E2E screenshot committed showing a painted cell.
3. **A hand edit is visible to main** — reviewer paints, then calls `exportPng` and confirms the edit is present. This is the check that catches the v1 silent-divergence defect.
4. Canvas renders at all three sizes.
5. **Visual gate V1** — a design reviewer judges the screenshot against `design/2026-07-28-editor-layout-b.html` on canvas dominance, checkerboard legibility, and swatch affordance.
6. Only Wave 11 whitelist files touched.

---

## Wave 12 — Full layout (visual gate V2)

- [ ] **12.1** Write `e2e/loop.spec.ts` first: a real generation adds a filmstrip frame per round; clicking an issue highlights its region; clicking a frame changes the canvas; the gate appears at `AWAITING_USER`; **the dock shows lint output**; **Accept records the round and the status bar reads `DONE`**; the model pickers change `getModels()`.
- [ ] **12.2** Run. FAIL.
- [ ] **12.3** Implement `PromptBar`, `ModelPickers`, `CritiqueDock` (critique **and** lint), `Filmstrip`, `GateBar` (feedback, Accept, Export), `StatusBar`; subscribe to `onEvent`.
  - **The dock renders whenever a critique exists**, including a converged one showing "no high-severity issues" plus the lint block (ruling R2 — the ratified prototype, not v1's spec §8).
  - Filmstrip pending frames come from `getConfig().maxRounds`.
  - Status bar reads state and stop reason from `SessionHistory`, so they survive a reload.
- [ ] **12.4** Run. PASS.
- [ ] **12.5** Capture `-wave-12-full.png` (populated, mid-loop), `-wave-12-empty.png` (**first-run: no sprite, empty filmstrip, no dock**), `-wave-12-gate.png`.
- [ ] **12.6** Commit.

**Acceptance criteria:**
1. `npm run build && npx playwright test` green.
2. All three screenshots committed **including the empty/first-run state** — a design whose depth comes from content collapses when empty, and gating only the happy state is a known failure mode.
3. The dock appears whenever a critique exists and shows the lint block.
4. Twin confidence bars render; `0.91/0.40` is visually distinguishable from `0.91/0.95`.
5. The status bar names the stop reason that actually fired, read from the persisted history.
6. **Interaction contract** — a fresh reviewer drives the live app as a first-run user and a returning user and files every dead end. An element that renders but affords nothing is a defect. Model pickers and Accept are the two most likely to be inert.
7. **Visual gate V2** — design reviewer judges all three screenshots against the ruled design. `-wave-12-empty.png` is judged against **written criteria, not the prototype**, since the prototype has no empty state (it loads with the fox already drawn).
8. Only Wave 12 whitelist files touched.

---

## Wave 13 — PNG export + benchmark runner

```ts
export async function exportPng(doc: SpriteDoc, scale: 1|4|8|16, outPath: string): Promise<string>
```

`Api.exportPng` opens `dialog.showSaveDialog` on the main window and resolves to the chosen absolute path, or `""` on cancel. v1 never said where the PNG went; "dialog" appeared zero times in either document.

Bench: `"bench": "tsx bench/run.ts"` (add `tsx`; add `bench/**` to `tsconfig.json`'s include, which is otherwise never typechecked). Ten prompts from spec §11, pinned at **`size: 32`, `paletteId: "pico-8"`**.

CSV columns: `prompt, size, palette, generator, critic, ok, error, repairs, repairPct, rounds, stopReason, orphanCount, paletteUsed, symmetryScore, draftMs, critiqueMs, reviseMs, totalMs, reviseTurns, hitCap`.

**`totalMs` is wall-clocked around the `run()` call, not summed from `Round.timings`.** No field anchors a run's total: summing the per-round timings yields **0** for a draft-rejected run — exactly the row whose duration you most want — and omits retry and orchestration time. This does not conflict with AC3, which forbids deriving *per-stage* timings from events; per-stage still comes from `Round.timings`.

`ok` and `error` exist because spec §11's first bar is "completes without crash" and v1's CSV had no way to express the failure it was measuring.

- [ ] **13.1** Write `tests/main/export.test.ts` first: `exportPng(doc32, 8, path)` writes 256×256; scale 3 rejected. **13.2** Run. FAIL. **13.3** Implement; wire the Export button and the IPC handler, replacing Wave 10's `not-implemented` stub. **13.4** Run. PASS.
- [ ] **13.5** Implement `bench/run.ts` and `bench/prompts.ts`; run the full 10-prompt bench against real models.
- [ ] **13.6** Save CSV to `captures/2026-07-28-wave-13-bench.csv` and one exported PNG to `screenshots/2026-07-28-wave-13-export.png`. Commit.

**Acceptance criteria:**
1. `npm test` green; `npm run typecheck` now covers `bench/`.
2. Bench CSV committed with 10 real rows, non-zero `totalMs`, and a valid `stopReason` or `error` per row.
3. Timings come from `Round.timings`, not from the bench wall-clocking events.
4. Exported PNG committed at the declared scale with correct dimensions.
5. Bench runs headless — no Electron, no window.
6. Only Wave 13 whitelist files touched.

---

## Wave 14 — Final human review gate

A **human** gate. Pausing here is the designed outcome.

| # | Feature | Spec | Exercised by |
|---|---|---|---|
| 1 | NL prompt → pixel art | §7.4 | Fresh prompt, generate, see a sprite |
| 2 | Canvas 16/32/64 | §2 | One sprite at each size |
| 3 | Curated palettes | §6.1a | `pico-8` and `gameboy` (4-colour) |
| 4 | Deterministic linter | §6.5 | Hand-place an orphan; **confirm the dock's lint block updates** |
| 5 | Critique with regions | §6.4 | Click an issue; region highlights correctly |
| 6 | Split confidence | §6.4 | Find a low-`suggestConfidence` issue; `suggest` withheld |
| 7 | Bounded revise loop | §6.6 | Watch pixels change; **confirm `Round.revise.turns` ≤ cap** |
| 8 | Auto-converge ≤3 rounds | §7.2 | Status bar's stop reason matches `SessionHistory.stopReason` |
| 9 | User feedback loop | §7.3 | Feedback at the gate runs another round; `Round.userFeedback` records it |
| 10 | Accept any round | §9 | Scrub back, accept; `acceptedRound` records it |
| 11 | Manual editing | §2 | Paint by hand |
| 12 | PNG export | §2 | Export at 8×, open the file — **including hand edits from #11** |
| 13 | Model pickers | §2 | Swap the critic; confirm via `meta.criticModel` on the next round |
| 14 | Version history | §6.7 | Session JSON at `getSessionPath()` round-trips and embeds `config` |

- [ ] **14.1** Run all 14 live. Record results to `captures/2026-07-28-wave-14-e2e.txt`.
- [ ] **14.2** Screenshot each to `screenshots/2026-07-28-wave-14-<n>-<feature>.png`.
- [ ] **14.3** Measure spec §11's bars against the Wave 13 CSV, reading each from the field §11 names.
- [ ] **14.4** **Escalate to the human** with results and the provisional bar for ruling.
- [ ] **14.5** Patch the spec with a `docs(spec):` commit recording measured values in place of §11 and §12's guesses.

**Acceptance criteria:**
1. All 14 exercised live with committed evidence.
2. §11's five objective bars measured with real numbers, each from its named field.
3. The human has ruled on the subjective bar.
4. Spec patched so the doc at HEAD is more honest than the one we started with.

---

## Self-review

**Spec coverage.** §5.1–5.2 → W10; §6.1–6.1a → W1; §6.2–6.3 → W2/W2c/W6; §6.4 → W7; §6.5 → W2c/W3; §6.6 → W8; §6.7–6.9 → W2c/W5/W9; §7.1–7.5 → W9; §8 → W11/W12; §9 → every wave's error paths + W12; §10 → every wave's tests + W5's live smoke + W7's captured critic output; §11 → W13 bench + W14; §12 → W14.5.

**What v1's self-review missed, and why.** It checked internal consistency and found contradictions. It could not find *absences* — a field no producer sets, an acceptance criterion nothing can satisfy, a build step nobody wrote — because the author of a plan cannot see what they failed to write. Four of the first five defects in execution were absences. This v2 exists because an independent trace of declared inputs back to actual producers is a different activity, and only that found the other eighty.

**Consequence for the remaining waves.** Each dispatch brief instructs the implementer to read ahead to its consumers and report anything in its own output that will not serve them. Three of the five Wave 1–2 defects came from exactly that instruction. It is the highest-yield line in a brief and it is not optional.
