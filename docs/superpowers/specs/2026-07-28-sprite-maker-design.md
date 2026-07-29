# Sprite Maker — Design Spec

**Date:** 2026-07-28
**Status:** Ratified through Section 4 (architecture, data model, control flow, UI). Sections 9–11 (error handling, testing, acceptance) are written but not yet reviewed.
**Repo:** `~/dev/sprite-maker`

---

## 1. What this is

A desktop app that turns a natural-language request ("pixel art red fox, sitting") into real pixel art, then improves it through an automated critique loop before handing it to the user for final judgement.

Two models do the work, both local, both Qwen 3, both served by Ollama:

- a **generator** that writes the sprite as a palette-indexed character grid, and
- a **vision critic** that looks at the rendered result and reports what's wrong with it.

A deterministic orchestrator sequences the rounds; the user gates the result. The distinguishing property is that every revision round is preserved and comparable, so the improvement loop is inspectable rather than magic.

## 2. Scope

### In (MVP)

- Electron desktop app with an in-app pixel editor
- Canvas sizes 16×16, 32×32, 64×64
- Curated palette library; agent selects a palette, then emits indices only
- NL prompt → structured intent → first draft in a single inference
- Deterministic linter (orphan pixels, outline gaps, palette coverage, symmetry)
- Vision critique producing issue-level findings with regions, severity, and two confidence scores
- Bounded agentic revision loop using `place_pixel` / `fill_row`
- Auto-converge for up to 3 rounds, then a user gate that accepts or feeds back
- Manual pixel editing on the grid
- PNG export at a chosen scale factor
- Model pickers for generator and critic roles
- Per-round version history with diffs
- Headless benchmark runner

### Out (deferred)

- **Reference image input** — the user's designated **first feature after the MVP works**. A user-supplied reference PNG that the critic compares the sprite against. Deferred because it is a separate data path, needs a different critic prompt design, and puts a second image in every vision call.
- Sprite sheet / walk-cycle animation
- Character editing (clothes, armor) — may fall out of the feedback loop at no extra cost
- Hosted (non-local) model adapters
- Multi-sprite projects, tilesets, palettes authored in-app

## 3. Verified constraints

Measured on the target machine (Apple M2 Max, 32 GB), not estimated:

| Fact | Value |
|---|---|
| `qwen3:8b` throughput | **28.4 tok/s** (600 tok in 21.1 s, q4_K_M) |
| `qwen3-omni` / `qwen2.5-omni` on Ollama | **Not available** — both 404 |
| `qwen3-vl` on Ollama | Available: 2b / 4b / 8b / 30b-a3b / 32b / 235b, instruct + thinking, q4/q8/bf16 |
| API keys in environment | None (no NVIDIA/NGC, HuggingFace, Anthropic, OpenAI) |
| Toolchain | Node **22.15.0** (see A3), Python 3.10.4, Go 1.23.5 |

**Amendment A3 — Node floor.** `electron@43` declares `engines.node >= 22.12.0` and `electron-vite@5` wants `^20.19.0 || >=22.12.0`; the machine's default 22.9.0 satisfies neither, and the Electron binary postinstall failed under it. Pinned to 22.15.0 via a committed `.nvmrc`. `package.json` carries `engines.node >= 22.12`.

**Model role bindings (defaults):**

| Role | Model | Footprint |
|---|---|---|
| Generator | `qwen3:8b` | 5.2 GB |
| Critic | `qwen3-vl:8b-instruct-q4_K_M` | ~6 GB |
| Critic upgrade path | `qwen3-vl:30b-a3b-instruct-q4_K_M` — MoE, 3B active, runs near-4B speed at near-30B quality | ~18 GB |

`qwen3-vl` also handles text-only prompts, so both roles can be bound to it to eliminate model-swap stalls. That is a config change, not a code change.

## 4. Corrections to the original brief

Four things in the original concept do not survive contact with the constraints. Each is replaced rather than dropped.

**4.1 — Pixel-by-pixel placement cannot be the primary draw path.** A 32×32 sprite at ~60% opacity is ~600 `place_pixel` calls at ~35 tokens each: ~21,000 output tokens, ~12 minutes of generation at 28.4 tok/s, *per draft*. Context grows past 20k tokens, and an 8B q4 model loses spatial coherence long before pixel 600. Replaced by: batch whole-canvas emission for the draft (one inference, ~750 tokens, ~30 s), with `place_pixel` retained as the **revision** path, where ~20 edits cost ~25 s and per-pixel control is worth its price.

**4.2 — The vision model cannot produce a per-pixel score.** For 32×32 that is 1024 judgements from a model that sees a resampled thumbnail; it would emit a plausible-looking matrix with no grounding, at ~4000 output tokens (~2.5 min) per review. Replaced by a split: the **VLM** returns issue-level findings with bounding regions, and the **deterministic linter** produces genuine per-cell findings. An orphan pixel is a decidable property — a cell whose eight neighbours all differ — computable in microseconds with zero hallucination risk.

**4.3 — "NVIDIA Omni" does not map to a real product for this use.** *Omni* is Alibaba's any-to-any family (text/image/audio/video in, text+speech out); NVIDIA serves vision models through NIM. Resolved to `qwen3-vl`: vision is the only modality this project needs, and Omni's audio/speech capacity would be paid-for weight that never runs.

**4.4 — VLMs are weak on raw low-resolution input.** A 32×32 image passed to a vision encoder is resampled to 224–448 px and arrives as a blur. Three mitigations are built into the critique stage: nearest-neighbour upscale to ~512 px (preserving hard edges), passing the **index grid as text alongside the image**, and compositing transparency onto a flat background (below). The image supplies gestalt ("does this read as a fox?"); the text supplies coordinates. Asking a VLM to derive `(11,6)` from pixels alone is where this design would otherwise fail.

**4.5 — Transparency composites to black, erasing silhouettes.** Verified empirically against `qwen3-vl:8b-instruct-q4_K_M`; capture at `captures/2026-07-29-transparency-vlm-probe.txt`. Shown a half-transparent, half-opaque-black image, the model reported *"No visible differences; both halves are identical black backgrounds."* Transparent and `#000000` are not merely hard to tell apart — they are indistinguishable to the encoder.

This is the common case, not an edge case: `pico-8` index 0 is `#000000` and `db16` index 0 is `#140c1c`, so a black-outlined sprite on transparency — the standard pixel-art idiom — loses its entire silhouette boundary. And the silhouette is exactly what §4.4 assigns the image to judge.

**The critic's image composites transparency onto a computed flat colour**, chosen per sprite for maximum luminance distance from the palette entries that sprite actually uses. Computed rather than fixed: `nes-16` and `db16` both carry mid-greys, so a hardcoded grey background would reintroduce the erased boundary for any sprite using them — the same defect, less often, which is the harder kind to notice.

The background never appears in the exported PNG. Export preserves alpha; only the critique path composites.

## 5. Architecture

### 5.1 Process split

```
main/       Node context. Owns Ollama HTTP, the agent harness, the linter,
            PNG encoding, disk I/O. No CORS, no sandbox, full filesystem access.
renderer/   React + TypeScript + Vite. Pure presentation and input. Holds no
            pipeline logic — renders SpriteDoc and dispatches intents.
shared/     Zod schemas, palette library, pure grid math. Imported by both.
```

The harness lives in `main/` for a reason beyond CORS avoidance: **it makes the entire pipeline testable without Electron.** `main/` is plain TypeScript modules, so Vitest imports `pipeline.ts` directly, injects a stub Ollama client, and asserts on state transitions — no window, no IPC, no display. A pipeline exercisable only by clicking through a running app is a pipeline that stops being tested.

### 5.2 Module map

| Module | Responsibility | Depends on |
|---|---|---|
| `shared/schema.ts` | Zod schemas: `SpriteDoc`, `CritiqueReport`, `LintReport`, `HarnessConfig`, `Round`, `SessionHistory`. Also `PipelineState`, `StopReason` and `PipelineEvent` — these are consumed by preload and renderer, and a value import of `main/pipeline` from the renderer bundle would pull `node:http` in behind it. Single source of truth for every contract. | — |
| `shared/palettes.ts` | Curated palette library. Pure data. | — |
| `shared/grid.ts` | Pure grid math: parse/serialize rows, `setPixel`, bounds checks, diff two grids. No I/O. | schema |
| `main/ollama.ts` | Thin Ollama client: `generate`, `chatWithTools`, `vision`. The only place HTTP happens. | — |
| `main/models.ts` | Model registry — enumerates installed models via `/api/tags`, binds roles. Backs the pickers. | ollama |
| `main/render.ts` | Grid → PNG buffer. Nearest-neighbour upscale only. Serves both critique and export. | grid |
| `main/lint.ts` | Deterministic checks → `LintReport`. Zero inference. | grid, schema |
| `main/draft.ts` | Build draft prompt → generator → parse and repair rows → `SpriteDoc`. | ollama, grid |
| `main/critique.ts` | Build vision prompt (image + grid text) → critic → validated `CritiqueReport`. | ollama, render |
| `main/revise.ts` | The bounded agentic loop. Tools: `place_pixel`, `fill_row`, `done`. | ollama, grid |
| `main/history.ts` | Per-round snapshots and diffs. | grid |
| `main/pipeline.ts` | The state machine. Sequences rounds, evaluates stop conditions, emits events. | all above |
| `main/ipc.ts` | Typed IPC surface — the only thing the renderer can reach. | pipeline, models |
| `bench/run.ts` | Headless benchmark runner. | pipeline |

Two boundaries carry the most weight:

- **`main/ollama.ts` is the sole HTTP boundary.** Every other module accepts a client interface. This is what makes stub-driven tests possible and what makes a future hosted adapter a one-file change.
- **`shared/grid.ts` is pure.** Every pixel mutation in the system passes through it, so an agent's `place_pixel` and a user's mouse click hit identical, identically-tested code. Bounds violations and off-palette indices are rejected in exactly one place.

## 6. Data model and contracts

> **v2 — 2026-07-29.** Sections 6–9 were rewritten after a three-part consistency audit found 18 blockers, 46 defects and 21 friction items across Waves 3–14. See `2026-07-29-consistency-audit-findings.md` for the full ledger and the four human rulings (R1–R4) that shaped this revision. Amendments A1–A5 from the v1 text are folded in rather than appended.

### 6.1 Row encoding

One character per pixel: `.` = transparent, `0`–`f` = palette index 0–15.

```
"................"
".....0000000...."
"....011111100..."
"...01122222110.."
```

**Lowercase only.** `A`–`F` are rejected, not folded. Admitting both cases would give one pixel two spellings, which silently breaks row equality, `diff`, the empty-diff stop condition, and §10's golden-file byte comparison — four failures whose common cause would be invisible at each site.

The single-hex-character encoding caps the palette at **16 opaque colors plus transparent**. This is not a limitation to work around — it is the constraint that makes output look like pixel art rather than a downsampled photo.

### 6.1a Palette library

Each palette carries **4 to 16 entries** — 16 is the ceiling imposed by the encoding, not a requirement.

| id | Entries | Note |
|---|---|---|
| `pico-8` | 16 | Fantasy-console standard |
| `db16` | 16 | DawnBringer 16 |
| `aap-16` | 16 | AAP-16 by Adigun Polack |
| `nes-16` | 16 | Curated 16-color subset of the 54-color NES master palette |
| `gameboy` | 4 | Original DMG green ramp |

Palettes are **frozen singletons** — objects, colour arrays and the registry itself. They are handed to the agent, the linter, the renderer and the UI, and a mutation anywhere would corrupt every consumer.

Indices beyond a palette's length are caught in three distinct places, and the distinction matters (§6.3): `setPixel`/`fillRow` **throw** on the mutation path, `normalize` **repairs** on the draft path, and `SpriteDocSchema` **refuses** on the parse path.

### 6.2 `SpriteDoc`

```ts
{
  schemaVersion: 1,
  id: string,                    // uuid by convention; not format-validated
  createdAt: string,             // ISO 8601, validated
  prompt: string,
  intent: {
    subject: string,
    style?: string,
    facing?: "front" | "side" | "three-quarter",
    notes?: string
  },
  size: { w: 16|32|64, h: 16|32|64 },   // square only — see below
  palette: { id: string, colors: string[] },
  rows: string[],                // exactly h strings of exactly w chars
  meta: {
    generatorModel: string,
    criticModel: string,
    round: number,
    repairs: number,
    repairedRows: number[],
    parentId: string | null
  }
}
```

**`size` is square.** `SizeSchema` is a union of the three square literals, not two independent unions — `{ w: 16, h: 64 }` must not parse. The v1 shape admitted nine sizes while every consumer assumed three.

**Who owns `meta`.** The pipeline (§7.5), and nobody else. `revise()` returns a `Grid`, not a `SpriteDoc`, precisely so that no stage can produce a document with inherited identity. A derived document gets a fresh `id` and `createdAt`, `parentId` set to the document it derives from, `round` set by the pipeline, and **`repairs: 0` with `repairedRows: []`** — those describe what the *generator* did at draft time and are false about any later round.

**`repairedRows`** is required because §6.5's `row-repaired` warning is defined per repaired row, and which rows were repaired is knowable only at parse time: once the grid exists, a repaired row is indistinguishable from one the model got right.

### 6.3 Row repair

`qwen3:8b` emits malformed rows routinely, not occasionally — especially at 64×64. This is expected input, not an error:

| Defect | Repair |
|---|---|
| Row too short | Pad right with `.` |
| Row too long | Truncate |
| Too few / too many rows | Pad with empty rows / truncate |
| Invalid character | Map to `.` |
| Index at or beyond the palette length | Map to `.` |
| No parseable output at all | Treat as `rows: []`, which the above charges as `w × h` repairs |

Every repair increments `meta.repairs` and adds its row to `meta.repairedRows`.

**The threshold is an unbounded ratio.** Reject when `repairs / (w × h) > repairRejectThreshold`. `repairs` is **not** a percentage and is not bounded by 1.0: a model returning 100 rows for a 16×16 canvas charges `(100 − 16) × 16 = 1344` against 256 cells — 525% — even when all 16 surviving rows are pristine. The rejection is correct there; the arithmetic must not assume a ratio ≤ 1.

On rejection the draft is retried once, with the specific defects named back to the model. **The retry prompt distinguishes defect kinds** — "row 4 used index 9 but this palette has 4 colours" is a different instruction from "row 4 was 12 characters, expected 16", and `repairedRows` alone cannot tell the model which mistake it made.

A second rejection produces `DraftRejectedError`, whose raw output is preserved in `SessionHistory.draftFailures` (§6.7).

### 6.4 `CritiqueReport`

```ts
{
  readsAs: string | null,        // null when degraded
  matchesIntent: boolean,
  overall: 1|2|3|4|5|null,       // null when degraded — never invented
  degraded: boolean,             // true when the critic could not be parsed
  issues: [{
    id: string,
    region: [x0, y0, x1, y1],
    severity: "high" | "medium" | "low",
    issue: string,
    suggest: string,             // advisory hint — NOT applied verbatim
    confidence: number,          // 0..1 — is the PROBLEM real?
    suggestConfidence: number    // 0..1 — is THIS FIX correct?
  }]
}
```

The two confidence fields are deliberately separate. The valuable cell is high `confidence` with low `suggestConfidence`: *something is definitely wrong here, but my proposed fix is a guess — solve it yourself.* Collapsing them into one number destroys exactly that signal.

**Filtering** (`filterIssues`) drops issues below `confidenceFloor` entirely, and blanks `suggest` on issues above it but below `suggestConfidenceFloor`. `suggest` is advisory by design; if it were authoritative we would be building a deterministic orchestrator, not an agentic revise stage.

**Critique repairs, mirroring §6.3.** The draft path has a whole repair table for model sloppiness; the critique path had only reject-and-reprompt-once, so a critic emitting perfectly good issues while omitting `id` failed the entire report twice and became a permanent silent no-op. Before validation:

| Defect | Repair |
|---|---|
| Missing `id` | Synthesize from the issue's index |
| Missing `suggest` | `""`, with `suggestConfidence: 0` |
| Missing `matchesIntent` | `true` |
| Region partly out of canvas | Clamp to canvas bounds |
| Region reversed (`x0 > x1`) | Normalize |
| Region entirely outside | Drop the issue |
| Missing `region` or `confidence` | Drop the issue |

**Clamping happens on the raw JSON, before schema validation.** `Coord` is non-negative, so a region like `[-5, -5, 3, 3]` — the most common VLM error — would otherwise fail the schema, consume the single reprompt, and degrade the whole report.

Only genuinely unparseable output triggers a reprompt. A second failure yields `{ degraded: true, overall: null, readsAs: null, issues: [] }`. **The degraded flag is not cosmetic:** without it the pipeline reports `no-high-severity` and tells the user the sprite passed a critique that never ran, and an invented `overall` pollutes every bench-derived quality metric.

### 6.5 `LintReport`

Pure functions over the grid, zero inference:

```ts
{
  warnings: [{
    code: "orphan-pixel" | "unused-palette-entry" | "low-contrast"
        | "outline-gap" | "row-repaired",
    cells: [[x, y], ...],
    indices?: number[],          // which palette index/pair this concerns
    message: string
  }],
  metrics: {
    coverage: number,            // fraction non-transparent
    paletteUsed: number,
    orphanCount: number,
    symmetryScore: number        // 0..1
  }
}
```

**There is no `errors` field, and no `LINTING → FAILED` edge** (ruling R3). `lint()` receives an already-validated `SpriteDoc`; amendment A4 made every structural violation `errors` could have described unrepresentable before `lint()` is called. A dead branch that Wave 9 must implement and cannot test is worse than no branch.

`indices` exists so consumers do not have to regex free text to learn which palette entry a warning concerns.

Each code has one definition and one cardinality. The implementation may not invent others:

| Code | Definition | Cardinality | `cells` | `indices` |
|---|---|---|---|---|
| `orphan-pixel` | A **non-transparent** cell whose four orthogonal neighbours are all transparent. Out-of-canvas counts as transparent. Diagonal attachment does not rescue it | One warning total | Every orphan cell | — |
| `outline-gap` | A transparent cell with non-transparent cells on **opposite** orthogonal sides (left and right, or above and below) | One warning total | Every gap cell | — |
| `low-contrast` | Two **distinct** palette indices (`i < j`) used as orthogonal neighbours whose WCAG relative luminance differs by `< 0.08`. Transparent cells participate in no pair | One warning **per index pair** | Every cell of either index orthogonally adjacent to the other | `[i, j]` |
| `unused-palette-entry` | A palette index never appearing in `rows` | One warning **per unused index** | `[]` | `[i]` |
| `row-repaired` | One per row in `meta.repairedRows` | One warning **per row** | That row's cells | — |

The `i < j` and transparent-exclusion clauses are load-bearing: `i === j` has Δluminance 0, so without them every filled sprite reports low-contrast against itself, and `charIndex('.')` is `-1`, so `colors[-1]` is `undefined` and the luminance parser crashes on the first sprite with a transparent neighbour — that is, all of them.

Relative luminance uses the standard sRGB formula: linearize each channel (`c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`), then `0.2126R + 0.7152G + 0.0722B`. **Do not reimplement it with rounding.** `gameboy` indices 2 and 3 sit at Δ = 0.0794 against the 0.08 threshold — a 0.8% margin, and the canary for any change to this formula.

**Amendment A7 — the formula lives in `shared/color.ts`.** "Do not reimplement it" is a rule that placement can quietly break. Wave 3 shipped `relativeLuminance` from `main/lint.ts`, which is correct code in a location that guarantees the defect: **`main/*` is unreachable from the renderer bundle**, since a value import drags `node:http` in behind it — the same reason §5.2 moved `PipelineState` and friends into `shared/`. The first time the UI needs contrast (swatch borders, a legible canvas overlay), it cannot import `@main/lint`, so someone writes a second copy. `shared/color.ts` owns the formula and the `0.08` threshold, and `lint.ts`, `render.ts`, `pickCriticBackground` and the renderer all import from there. Wave 4 relocates it.

`symmetryScore` is the fraction of non-transparent cells whose mirror about the **vertical centre axis** holds the same index. **A sprite with no non-transparent cells scores 1** — a blank canvas is trivially symmetric. Without this, an all-transparent sprite yields `0/0 = NaN`, which fails the schema bounds and serializes to `null`, surfacing as an opaque round-trip failure two stages from its cause. It is reachable: a model returning 16 rows of dots gets there with `repairs === 0`.

`symmetryScore` is reported, never a warning — plenty of good sprites are deliberately asymmetric.

### 6.6 Revise-stage tools

```ts
place_pixel(x: number, y: number, index: number | ".")   // "." clears
fill_row(y: number, x0: number, x1: number, index)        // x1 inclusive
done(summary: string)
```

Capped at `maxReviseTurns`. Every call routes through `shared/grid.ts`. A rejected call returns an error **string** to the agent rather than throwing, so it can correct itself; the attempt still counts against the cap.

**Numeric strings are coerced before validation.** A model routinely emits JSON `"3"` where the contract says `3`; uncoerced, that is a technically-correct rejection of well-formed intent, and it burns turns.

**A turn with zero tool calls counts against the cap** and injects a `user` nudge naming the three tools. This is the most common qwen3 tool-loop behavior, and it was previously undefined: counting only tool-firing turns spins forever on an identical message array, while exiting silently means the cap is not honoured.

**The revise stage binds to `models.generator`.** `HarnessConfig.models` has two roles and three stages consume models; this pins the third. Its system prompt carries `/no_think` — 40 turns each emitting a reasoning block is the single largest latency risk in the design.

`revise()` returns a `Grid` plus `{ turns, hitCap, summary }`. It does **not** return a `SpriteDoc` — see §6.2 on `meta` ownership.

### 6.7 `SessionHistory` and `Round`

```ts
Round {
  round: number,                       // 1-based; the draft is round 1
  doc: SpriteDoc,
  lint: LintReport,                    // of THIS doc
  critique: CritiqueReport | null,     // raw, unfiltered — of THIS doc
  filteredIssues: Issue[],             // what the revise stage actually received
  diffFromPrev: PixelDiff[] | null,    // null on the first round
  userFeedback: string | null,
  revise: { turns: number, hitCap: boolean, summary: string } | null,
  timings: { draftMs: number|null, critiqueMs: number|null, reviseMs: number|null }
}

SessionHistory {
  schemaVersion: 1,                    // staleness detection — see below
  sessionId: string,
  config: HarnessConfig,               // serialized on every run
  rounds: Round[],
  draftFailures: { attempt: number, raw: string, repairs: number, reason: string }[],
  stopReason: StopReason | null,
  finalState: PipelineState,
  outcome: "completed" | "failed",
  error: string | null,                // why a run failed, when it wasn't a draft
  acceptedRound: number | null         // Round.round, 1-based — not an array index
}
```

**`error` exists because `draftFailures` covers only draft rejection.** An `OllamaTimeoutError` during `CRITIQUING` is not a draft failure, and nothing else could hold it — so a persisted history could not say why it failed, while §8 specifies the status bar to read failure state from exactly that artifact.

**`schemaVersion` and a strict `HarnessConfigSchema` together close the staleness hole.** §6.8 exists so two benchmark runs can be compared; but a lenient config schema silently drops an unrecognized key and substitutes the current default, so an artifact from an older run would re-parse claiming limits it never used — "a difference might come from the change under test or from a limit that was altered and forgotten," which is the sentence §6.8 uses to justify itself. Strict parsing makes a stale artifact fail loudly, and `schemaVersion` says which shape it was written against.

Several of these fields exist because their absence was a defect:

- **`critique` is raw and `filteredIssues` is separate.** Storing only the filtered report destroys the data needed to tune `confidenceFloor` — and §12 says those floors are first guesses to be tuned by the bench. Storing only the raw report shows the UI `suggest` text the agent never received, and the renderer cannot filter for itself because `filterIssues` lives in main. Both.
- **`diffFromPrev` is nullable**, `null` on the first round. Non-nullable made "first round" and "revise changed nothing" the same value, and §6.7's v1 prose pointed the stop condition straight at the stored field — so a literal implementation stopped every run after the draft with a bogus `empty-diff`.
- **`diffFromPrev` is computed against the round's `parent`, not the array-previous.** `applyFeedback(roundIndex)` may branch from any round; diffing against the last array element compares the wrong baseline.
- **`userFeedback`** — §1 claims every revision round is preserved and comparable, but the user's own words lived only in a transient `Issue[]`. The session JSON could not answer "what did the user ask for at round 2?"
- **`revise.turns` / `hitCap` / `summary`** — `hitCap` was dead as specified, since §9 made both outcomes behaviourally identical. But "did the agent exhaust its turns" is exactly what the bench exists to surface, and `summary` is the agent's own account of what it did, the most legible per-round artifact in the system.
- **`timings`** — the prototype renders elapsed time and the bench CSV requires four timing columns; nothing recorded any.
- **`draftFailures`** — a rejected draft has no valid `SpriteDoc`, so it cannot be a `Round`. It also happens *before* round 1 exists, so calling it a round would be a lie the schema then has to accommodate everywhere.
- **`stopReason` / `finalState` / `outcome`** — `StopReason` existed only on a transient event, so the status bar lost it on reload, the bench could not fill its own CSV column, and there was no representable value for a failed run at all.
- **`acceptedRound`** — the global constraint "any round may be accepted, not only the last" was implemented by no wave and recorded in no field.

The history is persisted after every round via a `persist` callback on `PipelineDeps` — a callback rather than a path, so `pipeline.ts` stays Electron-free and the stub-driven tests stay disk-free.

**A `Round` is written in two phases, and this is not optional.** Ruling R2 snapshots the round at the top of each iteration — but `revise` and `timings.reviseMs` describe a stage that has not run yet. So the round is pushed with `revise: null` and `reviseMs: null` (which is what makes a converging first critique still yield `rounds.length === 1`), and then **replaced in place once the revise transition completes**, followed by a second `persist`.

Buffering the round until after revision is foreclosed three ways: R2 requires a snapshot on *every* iteration, so deferring reintroduces `rounds: []` when `REVISING` times out into `FAILED`; the `round` `PipelineEvent` is the only source of a mid-run filmstrip frame during the longest stage; and the bench reads `reviseMs` and `hitCap` from `Round`, not from wall-clocked events.

Without the second phase, `revise` and `reviseMs` are permanently `null` on every round — which makes `turns`, `hitCap` and `summary` dead exactly as they were before the audit added them, and silently empties three of the bench's CSV columns.

**`outcome` reads `"failed"` until the run genuinely completes.** `persist` fires after every round, so an in-progress history must not claim success — a crash mid-run would otherwise leave an artifact reporting `"completed"`, and §11's first acceptance bar reads that exact field. An interrupted run *is* a failed run.

**`acceptedRound` stores `Round.round` (1-based), not an array index.** `Api.accept(roundIndex)` speaks the renderer's 0-based array position; the persisted field names the round.

### 6.8 `HarnessConfig`

```ts
{
  maxRounds:              number   // default 3 — bounds the number of CRITIQUES
  maxReviseTurns:         number   // default 40
  maxDraftRetries:        number   // default 1
  repairRejectThreshold:  number   // default 0.20
  confidenceFloor:        number   // default 0.30
  suggestConfidenceFloor: number   // default 0.50
  stopOnNoHighSeverity:   boolean  // default true
  criticTargetPx:         number   // default 512 — target, not multiplier
  callTimeoutMs:          number   // default 120000, scaled by canvas area
  models: { generator: string, critic: string }
}
```

**`criticTargetPx` replaces `criticUpscale`.** §4.4 asks for an upscale to *approximately 512px*; a fixed multiplier of 16 gives 16×16 → 256px and 64×64 → **1024px**, the latter downsampled back by the vision encoder at several times the image-token cost. Compute `scale = max(1, floor(criticTargetPx / size.w))`.

**`callTimeoutMs` scales with canvas area.** The effective timeout is `callTimeoutMs × (w × h) / (32 × 32)`. A 64×64 draft is 4,096 grid characters plus intent JSON at the measured 28.4 tok/s — comfortably into three digits of seconds, so a flat 120s would abort legitimate drafts.

**`run()` re-parses its config on entry.** The schema's guards are worthless if a caller can hand-build `{...DEFAULT_HARNESS_CONFIG, maxRounds: 0}` and bypass them.

The config is serialized into `SessionHistory` on every run. Without that, two benchmark runs cannot be compared — a difference might come from the change under test or from a limit that was altered and forgotten.

### 6.9 Ollama client contract

```ts
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  tool_calls?: ToolCall[]        // assistant side
  tool_call_id?: string          // tool side
}
interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
interface ChatTurn { content: string; toolCalls: ToolCall[] }

interface OllamaClient {
  listModels(): Promise<string[]>
  generate(req: { model, system?, prompt, options?, format?, signal? }): Promise<string>
  vision(req: { model, system?, prompt, images: Buffer[], options?, format?, signal? }): Promise<string>
  chatWithTools(req: { model, messages, tools, options?, signal? }): Promise<ChatTurn>
}
```

**`ChatMessage.tool_calls` is required for the revise loop to function at all.** To continue a tool conversation the loop must append the assistant's turn *including the call it made*, then the tool results. Ollama's chat template renders `tool_calls` off the assistant message; without it the tool results arrive unmoored and the model re-issues calls it has already made, burning the turn cap.

**`vision` takes `options` and `format`.** Without them the critic cannot be seeded or temperature-controlled, which makes the bench — the instrument that exists to tune the confidence floors — non-reproducible no matter what the config records. `format: "json"` is also the cheapest available mitigation for malformed critique output.

Errors: `OllamaUnreachableError(endpoint)`, `OllamaTimeoutError(model, elapsedMs)`.

---

## 7. Pipeline and control flow

### 7.1 State machine

```
IDLE ──start──► DRAFTING ──repairs over threshold, retries remain──┐
                    │  │                                            │
                    │  └────────────────◄───────────────────────────┘
                    │
                    ├── repairs over threshold, no retries ──► FAILED
                    ├── timeout / unreachable ───────────────► FAILED
                    ▼
                 LINTING  (pure; cannot fail — see §6.5)
                    ▼
                CRITIQUING ── timeout / unreachable ─────────► FAILED
                    ▼
            ┌── SNAPSHOT ROUND ──┐   Round = { doc, lint(doc), critique(doc),
            │   (always, every   │            filteredIssues, diffFromPrev }
            │    iteration)      │
            └─────────┬──────────┘
                      ▼
              evaluate stop conditions on the FILTERED issue list
                      │
        ┌─────────────┼──────────────┬──────────────────┐
        │             │              │                  │
   no high-sev   round ≥        critic degraded    high-severity
   issues        maxRounds                         issues remain
        │             │              │                  │
        ▼             ▼              ▼                  ▼
   AWAITING_USER ◄────┴──────────────┘              REVISING
        │    ▲                                    (≤ maxReviseTurns)
        │    │                                          │
 accept │    │ feedback                                 │ done() / cap
        │    │                                          ▼
        ▼    │                                   diff(before, after)
      DONE   │                                          │
             │                              ┌───────────┴───────────┐
             │                        empty │                       │ changed
             │                              ▼                       ▼
             └──────────────────────► AWAITING_USER           round + 1 → LINTING
                                            ▲                       
                                            │ timeout ──────► FAILED
```

Four things changed from v1, each because the v1 diagram was wrong:

1. **The snapshot moved to the top of every iteration** (ruling R2). In v1 it sat only on the `REVISING` exit, so a run converging on its first critique returned `rounds: []` — nothing to export, accept, render or measure. It also meant a `Round` held a post-revise `doc` beside a pre-revise `lint` and `critique`, so the dock would highlight issue regions against pixels that had already changed.
2. **`empty-diff` is evaluated on the revise transition**, as `diff(docBefore, docAfter)` — never by reading a stored `diffFromPrev`.
3. **The feedback edge points `AWAITING_USER → REVISING`.** v1 drew it pointing *into* `AWAITING_USER`, and drew no edge at all for the transition §7.3 describes.
4. **Failure edges exist.** v1 drew `FAILED` reachable only from `LINTING` — the one stage that cannot fail — while §9 required failure from three stages that had no edge.

The stop predicates are mutually exclusive and evaluated in the order listed. In v1 a single medium-severity issue satisfied both "no high-sev issues" and "issues remain".

Every transition emits a typed event. **`REVISING` emits per-turn progress** — it is the longest stage, and without it §7.1's promise of live progress holds for state changes only while the 40-turn loop shows a single static label.

### 7.2 Stop conditions

**Ordering is not optional:** the confidence filters (§6.4) apply first, and the stop conditions evaluate on the **filtered** list. A high-severity issue the critic reported at `confidence: 0.1` is discarded and does not keep the loop running.

| Reason | Trigger |
|---|---|
| `no-high-severity` | Zero high-severity issues after filtering — the intended success path |
| `round-cap` | `round >= maxRounds` |
| `empty-diff` | The revise stage ran and changed nothing. Catches a critic reporting an issue the agent cannot fix, which would otherwise burn every round |
| `critic-failed` | Two consecutive unparseable critiques. **Distinct from `no-high-severity`** — without it a broken critic reports success and the user is told the sprite passed a critique that never ran |

An **empty filtered issue list skips `REVISING` unconditionally**, including when `stopOnNoHighSeverity` is false. There is nothing for the agent to do and no prompt that would make sense.

### 7.3 User feedback

At the gate, feedback is injected as a **synthetic high-severity issue** with `confidence: 1.0` and `suggestConfidence: 0.0`, re-entering at `REVISING`. Agent feedback and user feedback then travel one code path, so there is a single loop to build, test and debug.

The synthetic issue survives its own filter by construction: `confidence: 1.0` clears any floor, and blanking a `suggest` that is already `""` is a no-op, so `filterIssues` is idempotent on it.

Feedback is recorded in `Round.userFeedback`, and the resulting round's `parentId` points at the round the user was looking at — which may not be the last one.

### 7.4 Prompt strategy

- **Draft** — encoding rules, canvas dimensions, the palette as an indexed table, two short worked examples. Prefixed `/no_think`. The model must emit `{ intent: { subject, … }, rows: [...] }`; `parseDraft` never throws, and unparseable output degrades to `rows: []`, which §6.3 charges as `w × h` repairs and routes into the existing retry path.
- **Critique** — the upscaled PNG, the raw row text, and the intent. Image for gestalt, text for coordinates. `format: "json"`.
- **Revise** — the filtered issue list, the current grid as text, three tools. Prefixed `/no_think`.

### 7.5 Round numbering and `meta` ownership

**The draft is round 1**, and `maxRounds` bounds the number of **critiques** — so `maxRounds: 3` yields at most 3 critiques and 2 revise passes. v1 pinned neither, and the two readings differ by a whole revise pass.

**The pipeline constructs every `SpriteDoc.meta`.** `draft()` produces the first document; every later document is assembled by the pipeline from the `Grid` that `revise()` returns, with a fresh `id` and `createdAt`, `parentId` pointing at its source, the current `round`, and `repairs: 0` / `repairedRows: []`.

Inheriting `meta` was a real defect in v1: every round shared one `id`, `parentId` was permanently `null` so the lineage field was inert, and `repairedRows` propagated forward so `row-repaired` re-fired on rounds where the agent had already fixed those rows.

---

## 8. User interface

Canvas-centric layout, validated as an interactive prototype during design and ratified by the user. The prototype at `docs/superpowers/specs/design/2026-07-28-editor-layout-b.html` is the design lock.

```
┌──────────────────────────────────────────────────────────┐
│ [prompt............] [Generate] [32▾] [pico-8▾] [models▾] │
├────────────────────────────────────┬─────────────────────┤
│                                    │  CRITIQUE · round 2 │
│            pixel canvas            │  ┌────────────────┐ │
│         (dominant)                 │  │ left eye reads │ │
│                                    │  │ as a smudge    │ │
│                                    │  │ conf .91 ▓▓▓▓  │ │
│           palette swatches         │  │ sugg .40 ▓▓    │ │
│                                    │  └────────────────┘ │
│                                    │  LINT · 2 orphans   │
├────────────────────────────────────┴─────────────────────┤
│ [draft] [r1] [r2] [r3]              [Accept] [Export PNG] │
├──────────────────────────────────────────────────────────┤
│ ● AWAITING_USER — no high-severity issues · 3 rounds      │
└──────────────────────────────────────────────────────────┘
```

- **Canvas dominates.** Manual editing uses the active palette colour and routes through `shared/grid.ts`. Editing is a **main-process operation** — the renderer sends the edit and receives the updated document and a fresh lint report. A renderer-local edit would be invisible to export, history and the critic, which in v1 meant hand-editing then exporting produced a PNG without the edits and without an error.
- **An edit to the last round mutates it. An edit to an earlier round appends a new round** parented to the one edited. Mutating an earlier round in place would invalidate every later round's `diffFromPrev`, and the filmstrip is defined as replaying those diffs.
- **Round filmstrip along the bottom.** Frames are built by replaying `diffFromPrev`, so the history being scrubbed *is* the data model. Rounds not yet run render as pending placeholders, which requires `maxRounds` — available via `getConfig()`.
- **The critique dock renders whenever a critique exists** (ruling R2), including a converged one, which shows "no high-severity issues" plus the lint block. v1's spec said the dock hides when there are no issues; the ratified prototype disagreed, and a converged run would have looked identical to one that never critiqued. The prototype wins.
- **The dock renders `Round.lint`** alongside the critique. v1 built a whole deterministic linter whose output reached no surface.
- **Confidence renders as twin bars**, so the high-confidence / low-suggest-confidence case is visible at a glance.
- **Clicking an issue highlights its region** on the canvas.
- **Accept** records `acceptedRound` and transitions to `DONE`. Any round may be accepted, not only the last.
- **Status bar** names the current state and the stop reason that fired, both read from `SessionHistory` so they survive a reload.
- **When Ollama is unreachable**, Generate is disabled and the status bar names the exact endpoint. No silent fallback.

---

## 9. Error handling

| Failure | Response |
|---|---|
| Ollama unreachable | Status bar names the exact endpoint; Generate disabled; explicit retry. Errors cross IPC as a result envelope, not a rejection — `ipcMain.handle` destroys the error's own fields, which would have discarded the endpoint the message is about |
| Bound model not installed | Pickers list only installed models. If one disappears mid-session, fail the round naming the model and the `ollama pull` command that fixes it |
| Draft repairs over threshold | Retry once with the specific defects named by kind; on second failure enter `FAILED` and record the raw output in `SessionHistory.draftFailures` |
| Draft output unparseable | Not an error — degrades to `rows: []`, which §6.3 charges as `w × h` repairs and routes into the retry path above |
| Critique missing optional fields | Repaired per §6.4, not rejected |
| Critique unparseable | Reprompt once. On second failure, `degraded: true` with `overall: null`, and the run stops with `critic-failed` — never reported as success |
| Critique region out of bounds | Clamped on the raw JSON before validation; dropped if entirely outside |
| Revise emits an invalid tool call | Error string returned to the agent so it can self-correct; counts against the cap |
| Revise turn with zero tool calls | Counts against the cap; a nudge naming the three tools is injected |
| Revise hits the cap without `done()` | Accept whatever edits landed, snapshot, continue. `hitCap` is recorded on the round |
| Revise makes the sprite worse | **Any round may be accepted, not only the last.** The filmstrip is the mitigation |
| Model call exceeds the scaled `callTimeoutMs` | Abort via `AbortController`; `OllamaTimeoutError(model, elapsedMs)`; the round enters `FAILED` with elapsed time shown |
| App closes mid-run | History is persisted after every round via `PipelineDeps.persist`, so at most one round is lost |

## 10. Testing

*Not yet reviewed — scrutinise this section.*

**Pure unit tests, no model required.** `shared/grid.ts` (bounds rejection, parse/serialize round-trip, diff correctness), `shared/palettes.ts` (every palette holds 4–16 valid, non-duplicate hex colors), `main/lint.ts` (each warning code exercised against hand-built fixtures, per the definitions in 6.5), and row repair as a table-driven suite covering short rows, long rows, invalid characters, and wrong row counts.

**Contract tests.** Zod schemas reject malformed `CritiqueReport` payloads. Fixtures are captured from real model output rather than hand-written, so the tests fail when real models drift.

**Pipeline tests with a stub Ollama client.** This is the payoff of the `main/`-holds-the-harness decision. A scripted stub returns canned drafts and critiques, and the tests assert: all three stop conditions fire correctly, retry-on-repairs works, an invalid critic response degrades to `AWAITING_USER`, the turn cap is enforced, and user feedback enters as a synthetic high-severity issue. Zero inference; runs in milliseconds.

**Golden-file tests for `render.ts`.** Grid → PNG byte comparison at a fixed scale factor.

**Live smoke test, opt-in and tagged.** One real `qwen3:8b` draft plus one real `qwen3-vl` critique, asserting only that the outputs validate against their schemas — never on content. Excluded from the default `npm test` because it needs Ollama running and takes roughly a minute.

**Benchmark runner.** `npm run bench` executes N prompts × M configs headlessly and emits CSV: repairs, rounds to convergence, which stop condition fired, lint metrics, and wall-clock per stage. Not a test — the quality instrument. Roughly 80 lines, enabled by the Electron-free harness.

## 11. Acceptance criteria

*Not yet reviewed — and partly provisional by necessity. The human-rating bar in particular cannot be calibrated until we have seen real output; expect to revise it once the first twenty sprites exist.*

A fixed eval set of ten prompts (flower, dog, sword, tree, house, fox, chest, potion, knight, fish) run end to end at 32×32:

| Criterion | Bar | Measured from |
|---|---|---|
| Completes without crash | 10 / 10 | `SessionHistory.outcome === "completed"` |
| Median `meta.repairs` | < 5% of cells | `rounds[0].doc.meta.repairs / (w × h)` |
| Zero **structural** lint warnings on the final sprite | 10 / 10 | `rounds.at(-1).lint.warnings.filter(w => STRUCTURAL_LINT_CODES.includes(w.code)).length === 0` |
| Converges before the round cap | ≥ 5 / 10 | `stopReason === "no-high-severity"` |
| Critic actually ran | 10 / 10 | `stopReason !== "critic-failed"` |
| Human rating ≥ 3/5 | ≥ 6 / 10 *(provisional)* | the human |

Every objective bar names the persisted field it is read from. In v1 three of them were unmeasurable from the artifact: `outcome` and `stopReason` did not exist, and "linter errors" referred to a `LintReport.errors` field that nothing could ever populate (§6.5) — so the bar would have read `0/10` unconditionally and told us nothing.

**Amendment A6 — structural vs advisory lint codes.** The v2 rewrite of the row above replaced one unmeasurable bar with another. It read "zero lint **warnings of severity**", filtering on a severity field that `LintWarning` does not have and never had. Worse, the unfiltered form is not merely imprecise but always false: `low-contrast` and `unused-palette-entry` fire on essentially every real sprite. Measured during Wave 3 — a structurally perfect 32×32 pico-8 sprite emits **14 warnings** with zero orphans and zero gaps, and even a sprite using all sixteen indices still emits 6, because **pico-8 itself contains 15 sub-threshold index pairs**. Every bundled 16-colour palette is in the same position.

The five codes split in two, and the split is exported from `shared/schema.ts` as `STRUCTURAL_LINT_CODES` so that §7, §11, the bench and the human gate all filter identically rather than each hardcoding two strings:

| Class | Codes | Meaning |
|---|---|---|
| **Structural** | `orphan-pixel`, `outline-gap` | Defects in the sprite. These gate acceptance |
| **Advisory** | `low-contrast`, `unused-palette-entry`, `row-repaired` | Facts about the palette's shape or the draft's provenance, not faults in the sprite. Reported, never gating |

A single `warnings.length` cannot express this bar, so the bench emits **per-code counts as separate columns** rather than one total.

The `critic-failed` bar is new and matters most: without it, a run where the critic never parsed reports `no-high-severity` and scores as a *success* on the convergence bar.

The last row is subjective, and it is the one that determines whether the critic is earning its runtime — if a 7B VLM turns out too weak to critique pixel art usefully, that shows up here, and the response is to try `qwen3-vl:30b-a3b` before redesigning the loop.

## 12. Provisional decisions

Recorded so they are revisited rather than inherited:

- **Critic criteria were designed before observing real failure modes.** The recommendation during brainstorming was to ship generation first and design the critic against real output; the decision was to spec the full MVP in one pass. The severity thresholds, `confidenceFloor`, and `suggestConfidenceFloor` defaults are therefore first guesses to be tuned with `npm run bench`.
- **`maxRounds: 3`** is a guess, not an empirical optimum — and v1 defended it as "~90 s worst case", which was wrong by more than an order of magnitude. Re-derived: 3 critiques × (a 512px vision call, plus a revise loop of up to 40 tool-calling turns at ~35 output tokens each at the measured 28.4 tok/s) is **several minutes**, not ninety seconds. There is no `maxTotalMs`, so the round cap is the only wall-clock bound in the design. This also sets the bench's runtime — 10 prompts × M configs — and should be re-derived from real timings once `Round.timings` has data.
- **The 16-color cap** follows from single-hex-character encoding. Raising it means changing the encoding.
- **`qwen3-vl:8b-instruct` as default critic** — untested on this task. The 30b-a3b upgrade path exists precisely because 8B may prove insufficient.

## 13. Deferred work, in intended order

1. **Reference image input** — user-supplied reference PNG compared against the sprite by the critic. Explicitly the first thing to build after the MVP works.
2. Sprite sheet generation — walk cycle first.
3. Character editing (clothes, armor) — try the existing feedback loop before building anything new; it may already work.
4. Hosted model adapters behind the existing client interface.
