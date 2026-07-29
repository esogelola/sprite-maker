# Consistency Audit — Findings Ledger

**Date:** 2026-07-29
**Trigger:** Four of the first five defects found during Waves 1–2 were *absences* — a schema field a later wave needed, a validation path that did not exist, an unbounded quantity assumed bounded, a missing place to store data. Each looked like nothing. A spec self-review catches contradictions; it does not catch things that were never written.
**Method:** Three independent read-only audits over Waves 3–6, 7–9 and 10–14, each tracing every declared input back to an actual producer, and every acceptance criterion forward to something that could satisfy it.
**Result:** 18 blockers, 46 defects, 21 friction items.

This ledger is the justification for the v2 spec and plan. Every finding below is either resolved in v2 or explicitly deferred with a reason.

---

## Human rulings

| # | Question | Ruling |
|---|---|---|
| R1 | How to absorb the findings | **Revise spec §6–§9 and rewrite plan Waves 3–14** in one pass, then resume at Wave 3 |
| R2 | When is a `Round` constructed | **Snapshot at the top of each iteration**, after `CRITIQUING`, before any revision. `Round.doc`, `Round.lint` and `Round.critique` all describe the same sprite. `empty-diff` moves to the revise transition, comparing `docBefore` to `docAfter` directly |
| R3 | Prototype vs spec §8 on the critique dock | **Prototype wins** — the dock renders whenever a critique exists, including a converged one. Spec §8 and Wave 12's AC are patched |
| R4 | `LintReport.errors` and the `LINTING → FAILED` edge | **Delete both.** A4 made structural violations unrepresentable before `lint()` is called |

---

## BLOCKERS

| # | Wave | Finding | Resolution in v2 |
|---|---|---|---|
| B01 | 9 | **The final round is never snapshotted.** §7.1 put `snapshot round` on the `REVISING` exit only; both stop edges from `CRITIQUING` bypass it. A run converging on the first critique returns `rounds: []` — nothing to export, accept, render or measure. Wave 9's own happy-path test asserts only the event sequence, so it passes green against an empty history | Ruling R2. Snapshot at the top of each iteration |
| B02 | 8 | **`ChatMessage` has no `tool_calls` field.** The revise loop must append the assistant's turn *including the call it made* before the tool results. Without it, results arrive unmoored and the model re-issues calls it already made, burning the 40-turn cap | `ChatMessage.tool_calls?: ToolCall[]` added in Wave 5; `ollama.ts` added to Wave 8's row |
| B03 | 9 | **`diffFromPrev` cannot distinguish "first round" from "changed nothing."** Both are `[]`, and §6.7's prose points the stop condition straight at the stored field — so a literal implementation stops every run after the draft with a bogus `empty-diff` | `diffFromPrev` becomes nullable (`null` on round 1). §7.2 states `empty-diff` is evaluated only on the revise transition, never by reading a stored round |
| B04 | 3, 7, 9, 10, 12, 13 | **No wave after Wave 1 may modify `src/shared/schema.ts`.** Amendment A2 was ratified in a `docs(spec):` commit and never implemented — the shipped schema still reads `errors: z.array(z.string())`. `draftFailures` had nowhere to land either | **Wave 2c — schema completion**, whose whitelist is the schema and its tests. All schema-shaped findings land there |
| B05 | 3 | **A2's `errors` shape is not representable.** `LintWarningSchema.code` is `z.enum(LINT_CODES)`, and those five are all *warning* codes. No legal code names a schema violation | Moot under ruling R3 — `errors` is deleted |
| B06 | 5, 6, 7, 8, 9 | **`StubScript` is named and never defined.** Called "the load-bearing test fixture for Waves 6–9", yet four waves assert against a recording surface with no declared shape, and none may modify the stub file | `StubScript`, `RecordedCall` and `StubClient` pinned literally in Wave 5; `tests/stubs/ollama.ts` added to Waves 6–9 rows |
| B07 | 5, 10, 12, 14 | **Model binding dead-ends.** `ModelRegistry.bind()` mutates registry state; `run()` reads `cfg.models`; the `Api` has no channel; Wave 12's whitelist is renderer-only. Wave 14's "swap the critic model" is unreachable | `bind` writes through to the live `HarnessConfig.models`. `Api` gains `getModels`, `bindModel`, `getConfig`. Verified via `SpriteDoc.meta.criticModel`, which already records per round |
| B08 | 3 | **`SOLID_BLOCK` cannot yield zero warnings.** `unused-palette-entry` fires for every unused index, and all five shipped palettes carry 15–25 orthogonal low-contrast pairs. "No warnings" constrains the palette, not the sprite | Fixture pinned concretely: 16×16 gameboy, four horizontal bands in index order `0, 2, 1, 3` — uses all four indices, no adjacent pair under threshold |
| B09 | 10, 11, 12, 13 | **No build step exists in 14 waves,** and `package.json` has no `main`. electron-vite throws `No entry point found for electron app`; Playwright's `_electron.launch()` attaches to a built app, not a dev server | Wave 10 adds `main`, `dev`, `build` scripts. Waves 11–13 run `npm run build && npx playwright test` |
| B10 | 10 | **`"type": "module"` yields an ESM preload,** which Electron will not load in a sandboxed renderer. `window.api` would be `undefined`, with a symptom pointing at the wrong layer | Wave 10 pins the preload build to CJS with `entryFileNames: "[name].cjs"`. Explicitly *not* fixed with `sandbox: false` |
| B11 | 5, 9, 10, 11, 12, 13 | **The scope table forbids committing the evidence the same plan requires.** Reviewers apply both "reject anything outside this row" and "reject if required evidence is absent". Only Wave 14's row lists its artifacts | Standing clause: paths under `screenshots/` and `captures/` matching the wave's number are implicitly whitelisted for every wave |
| B12 | 11, 12, 13, 14 | **Manual edits never reach the main process.** `exportPng(roundIndex, …)` resolves against main's copy, so hand-editing then exporting yields a PNG *without the edits, with no error* | Main owns the session. `Api.setPixel(roundIndex, x, y, ch)` returns the updated doc; the renderer becomes pure presentation, matching spec §5.1 |
| B13 | 12, 14 | **No `accept()` anywhere.** No `Api` method, no `acceptedRound` field, no transition into `DONE`. The global constraint "any round may be accepted" is unimplemented by every wave | `Api.accept(roundIndex)`; `SessionHistory.acceptedRound` |
| B14 | 12, 14 | **Nothing renders lint output, and a hand edit is never re-linted.** The ratified prototype has a dedicated lint block; Wave 12's component list has no lint surface; `lint()` runs only inside `pipeline.run()` | `CritiqueDock` renders `Round.lint`; `Api.setPixel` re-lints and returns the fresh report |
| B15 | 12, 13 | **`stopReason` is not persisted,** yet Wave 13's CSV has a column for it and Wave 12's status bar must name it. There is also no representable value for a failed run | `SessionHistory` gains `stopReason`, `finalState`, and `outcome`. Bench CSV gains `ok` and `error` |
| B16 | 13 | **`bench/run.ts` cannot be executed.** No TypeScript runner in `package.json`; `bench/` is outside `tsconfig.json`'s `include`; canvas size and palette are never specified | `tsx` added; `"bench": "tsx bench/run.ts"`; `size: 32`, `paletteId: "pico-8"` pinned; `tsconfig.json` added to Wave 13's row |
| B17 | 3 | Fixtures are typed but never parsed, so `SpriteDocSchema`'s runtime refinements never apply to test data | Every fixture is the return value of `SpriteDocSchema.parse`. Reviewer greps for a bare `: SpriteDoc =` annotation and finds none |
| B18 | 6 | Plan still documents the 3-argument palette-blind `normalize`, including its literal body — the authoritative spelling of the most defect-prone function in the codebase, contradicting A4 | Plan's Wave 2 block and literal body replaced with the shipped 4-argument version |

---

## DEFECTS — resolved in v2

Grouped by where they land.

### Schema (Wave 2c)

- `symmetryScore` is `0/0 = NaN` on an all-transparent sprite; NaN fails the schema bounds, and `JSON.stringify(NaN)` is `null`, so it would surface as an opaque round-trip failure two waves from its cause. **Reachable**: a model returning 16 rows of dots gets there with `repairs === 0`. → defined as `1` for a blank sprite (trivially symmetric)
- `SessionHistory` cannot record terminal state, stop reason, accepted round, or a rejected draft → `stopReason`, `finalState`, `outcome`, `acceptedRound`, `draftFailures`
- No per-round timing, yet the prototype renders elapsed time and the bench CSV requires four timing columns → `Round.timings`
- `revise()`'s `turns`, `hitCap` and `summary` are discarded. `hitCap` is dead as specified — §9 makes both outcomes identical. `summary` is the agent's own account of what it did, the most legible per-round artifact in the system → `Round.revise`
- The user's feedback *text* is stored nowhere, contradicting §1's claim that every round is preserved and comparable → `Round.userFeedback`
- `Round.critique` raw vs filtered is unspecified, and both choices break a requirement: storing filtered destroys the data needed to tune `confidenceFloor`; storing raw shows the UI `suggest` text the agent never received, and the renderer cannot filter for itself → store raw in `critique`, add `filteredIssues`
- `SizeSchema` admits nine sizes, not three (`{w:16, h:64}` parses) → square-only union
- `criticUpscale` is a fixed multiplier but §4.4 names a fixed *target*: 64×64 renders to 1024px, which the vision encoder downsamples away at several times the token cost → replaced by `criticTargetPx` (default 512)
- `LintWarning` has no machine-readable field for which index or index-pair a warning concerns, forcing consumers to regex free text → `indices?: number[]`
- `diffFromPrev` nullable (B03)

### Ollama client (Wave 5)

- `ChatMessage.tool_calls` (B02)
- `vision()` cannot set `options` or `format: "json"`, so the critic cannot be seeded or constrained — which makes Wave 13's bench, the instrument that exists to tune the confidence floors, non-reproducible regardless of what the config records
- `callTimeoutMs` and `AbortController` are orphaned: the mechanism exists on the interface, but no wave's steps or criteria assign it → `OllamaTimeoutError`, one step per consuming wave
- `chatWithTools` ships untested despite being Wave 8's only model path and the highest wire-format risk
- `callTimeoutMs: 120000` is marginal for 64×64: 4,096 grid characters at the measured 28.4 tok/s runs into three digits of seconds → scaled by canvas area

### Pipeline (Wave 9)

- Round numbering and `maxRounds` semantics never pinned: `maxRounds: 3` gives 2 revise passes 1-based, 3 zero-based → draft is round 1; `maxRounds` bounds **critiques**
- `run()` never re-parses `cfg`, so a hand-built config bypasses every schema guard
- Nobody assigns `meta.parentId`, `id`, `createdAt` or `round` on a derived doc — so every round shares one `id` and the lineage field is permanently inert → `revise()` returns a `Grid`; the pipeline owns all `meta` construction
- `meta.repairedRows` propagates into derived docs, so `row-repaired` re-fires on rounds where the agent already fixed those rows → derived docs carry `repairedRows: []`
- `applyFeedback(roundIndex)` branches the history, but `appendRound` diffs against the array-previous, so a branch compares against the wrong baseline → diff against the **parent**
- `saveHistory` is called by nobody and no wave names a directory, leaving §9's crash-safety guarantee unimplemented → `PipelineDeps.persist` callback, which keeps `pipeline.ts` Electron-free
- A broken critic degrades to zero issues and the pipeline reports `no-high-severity` — telling the user the sprite passed a critique that never ran → `"critic-failed"` stop reason
- §7.1's feedback arrow points into `AWAITING_USER` rather than out to `REVISING`; there is no drawn edge for the transition §7.3 describes
- `CRITIQUING`'s out-edges are not mutually exclusive — with one medium-severity issue both predicates are true
- No failure edge from `DRAFTING`, `CRITIQUING` or `REVISING` despite §9 requiring all three
- With `stopOnNoHighSeverity: false` and zero filtered issues, control reaches `REVISING` with an empty issue list and nothing defines the behavior → empty filtered list skips `REVISING` unconditionally
- The longest stage emits no events: `revise()` has no `onEvent`, so §7.1's promise of live progress holds for state changes only and the 40-turn revise stage is a single static `REVISING`

### Critique (Wave 7)

- `parseCritique` clamping vs schema validation order unspecified. `Coord` is non-negative, so a partly-valid region like `[-5,-5,3,3]` — the most common VLM error — fails the schema, consumes the single reprompt, and can degrade the whole report to zero issues → clamp on raw JSON before parse; normalize reversed regions
- No repair story, only reject-and-reprompt-once. A critic emitting good issues but omitting `id` fails the whole report twice and becomes a permanent silent no-op → repair step mirroring §6.3
- The degraded empty report must invent `overall` and `readsAs`, and that fabricated score lands in history polluting bench metrics → `degraded: true`, `overall: null`

### Revise (Wave 8)

- Model binding never specified — three stages consume models, `HarnessConfig.models` has two roles → revise binds to `models.generator`
- Only the draft is prefixed `/no_think`. A 40-turn revise loop each emitting a reasoning block is the single largest latency risk in the design → revise prompt carries it too
- No defined behavior for an assistant turn with zero tool calls — the most common qwen3 tool-loop behavior. Counting only tool-firing turns spins forever on an identical message array → counts against the cap, injects a nudge

### Render (Wave 4)

- `toPngWithGrid` is produced, tested by nobody, consumed by nobody. Wave 7 sends `toPng`, and §4.4's stated mitigation is the *text grid*, which Wave 7 does send → **deleted**
- Golden-file byte stability is not pinned: `pngjs: "^7.0.0"` is a caret, and step 4.5's write-then-compare passes trivially on the run that mints the file → exact version pin; test fails if the golden is absent
- Wave 4 needs a 32×32 fixture and one using index 3; Wave 3's fixture list declares no sizes and Wave 4 cannot modify it

### Lint (Wave 3)

- `low-contrast` will fire on solid regions: `i === j` has Δlum 0, and transparent cells have `charIndex('.') === -1` so `colors[-1]` is `undefined` → pairs unordered and distinct (`i < j`), transparent participates in no pair
- `cells` semantics undefined for `unused-palette-entry` (no cells by definition) and `low-contrast` (deduplicated per pair); emission cardinality undefined for `orphan-pixel` and `outline-gap` → cardinality and `cells` pinned per code
- `getPixel` throws out-of-bounds but the warning definitions need "out-of-canvas counts as transparent" (already P6; carried forward)
- gameboy indices 2 and 3 differ by Δlum **0.0794** against a 0.08 threshold — a 0.8% margin. Any rounding or reimplementation of the luminance formula flips that pair → noted as the canary; formula must not be reimplemented with rounding

### Draft (Wave 6)

- `parseDraft` has no defined behavior for unparseable output or a missing `intent`, and the prompt contract never says the model must emit an intent → prompt requires `{intent, rows}`; `parseDraft` never throws; unparseable yields `rows: []`, which `normalize` charges as `w×h` repairs, routing into the existing retry path
- `meta.repairedRows` is pinned by no acceptance criterion, and its `.default([])` means a `draft()` that forgets it parses clean while claiming zero rows were repaired — a silent, permanent failure that would make `row-repaired` fire only for fixtures and never in production

### IPC and UI (Waves 10–12)

- `exportPng` never says where the PNG goes; "dialog" appears zero times in either document → `dialog.showSaveDialog`, resolves to the chosen path or `""` on cancel
- `onEvent` is a push channel and can never be an `ipcMain.handle`, so Wave 10's test fails against a correct implementation
- `Api.exportPng` must be registered in Wave 10 but `export.ts` is a Wave 13 file → Wave 10 registers a `not-implemented` stub, stated explicitly
- Issue-region highlighting must live in `Canvas.tsx`, a Wave 11 file that Wave 12 may not touch
- Manual-edit semantics undefined, and the prototype's mutate-in-place invalidates downstream `diffFromPrev` → an edit to the last round mutates it; an edit to an earlier round appends a new round parented to it
- `PipelineState`, `StopReason` and `PipelineEvent` live in `main/pipeline.ts` but are consumed by preload and renderer; a value import pulls `node:http` into the renderer bundle → moved to `shared/`
- The filmstrip's pending frames need `maxRounds`, which the renderer cannot obtain → `Api.getConfig()`
- `OllamaUnreachableError.endpoint` is destroyed crossing `ipcMain.handle` → IPC returns a result envelope rather than rejecting
- Wave 10's own evidence artifact is not producible: it requires a screenshot but Playwright does not arrive until Wave 11 → Playwright moves to Wave 10
- `applyFeedback` drops the `history` argument, so main must hold session state — never stated

---

## Deferred, with reason

| Finding | Why deferred |
|---|---|
| A4 pinned only at 16×16 and palette sizes 4 and 16 | Real but narrow. One 32×32 off-palette fixture closes it; folded into Wave 3's fixture set rather than reopening Wave 2b |
| Prototype's palette dropdown lists `nes` not `nes-16`, omits `aap-16` and `gameboy` | Prototype is a design artifact, not a contract. Wave 12 builds from `Api.getPalettes()` |
| Spec §8 calls the canvas "zoomable"; nothing builds zoom | Out of MVP scope. Word removed from §8 rather than assigned to a wave |
| §12's "~90 s worst case" is inconsistent with the defaults | Re-derived in v2 §12 rather than defended. `maxRounds: 3` × (40 tool turns + a vision call) is minutes, not 90 s |
| No wave captures real *critic* output as a contract-test fixture | Added to Wave 7 as a capture artifact rather than a separate wave |
| `bench-results/` is gitignored while the CSV copy goes to `captures/` | Correct as-is: the working directory is scratch, the committed copy is evidence |

---

## Process findings

1. **A `docs(spec):` commit changes documentation, not code.** Amendment A2 was ratified and never implemented; the gap survived two waves and was found only by this audit. Ratifying a decision is not landing it. Every future amendment names the wave that implements it.
2. **Reviewers wrote scratch files into the repository.** Briefs said "do not fix anything, do not commit" without saying "do not write files into the repo." One reviewer left a test file behind. Brief wording tightened.
3. **Read-ahead is the highest-yield instruction in a dispatch brief.** Four of five Wave 1–2 defects came from an implementer or reviewer examining waves they were not building. The whitelist that keeps reviews tractable also makes each wave blind to whether its output serves its consumers.
4. **Absence is invisible to a self-review.** The author of a plan cannot see what they failed to write. Independent tracing of declared inputs back to actual producers is a different activity from checking internal consistency, and only the former finds missing fields.
