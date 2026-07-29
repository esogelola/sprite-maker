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

**4.4 — VLMs are weak on raw low-resolution input.** A 32×32 image passed to a vision encoder is resampled to 224–448 px and arrives as a blur. Two mitigations are built into the critique stage: nearest-neighbour upscale to ~512 px (preserving hard edges), and passing the **index grid as text alongside the image**. The image supplies gestalt ("does this read as a fox?"); the text supplies coordinates. Asking a VLM to derive `(11,6)` from pixels alone is where this design would otherwise fail.

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
| `shared/schema.ts` | Zod schemas: `SpriteDoc`, `CritiqueReport`, `LintReport`, `HarnessConfig`. Single source of truth for every contract. | — |
| `shared/palettes.ts` | Curated palette library. Pure data. | — |
| `shared/grid.ts` | Pure grid math: parse/serialize rows, `setPixel`, bounds checks, diff two grids. No I/O. | schema |
| `main/ollama.ts` | Thin Ollama client: `generate`, `chatWithTools`, `vision`. The only place HTTP happens. | — |
| `main/models.ts` | Model registry — enumerates installed models via `/api/tags`, binds roles. Backs the pickers. | ollama |
| `main/render.ts` | Grid → PNG buffer. Nearest-neighbour upscale, optional coordinate overlay. Serves both critique and export. | grid |
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

### 6.1 Row encoding

One character per pixel: `.` = transparent, `0`–`f` = palette index 0–15.

**Lowercase only.** `A`–`F` are rejected, not folded. Admitting both cases would give one pixel two spellings, which silently breaks row equality, `diff`, the empty-diff stop condition, and §10's golden-file byte comparison — four failures whose common cause would be invisible at each site.

```
"................"
".....0000000...."
"....011111100..."
"...01122222110.."
```

The single-hex-character encoding caps the palette at **16 opaque colors plus transparent**. This is not a limitation to be worked around — it is the constraint that makes output look like pixel art rather than a downsampled photo. It also makes a row's character count equal its pixel count, so length validation is trivial, and `.` reads as visually empty in raw model output and in logs.

### 6.1a Palette library

Each palette carries **4 to 16 entries** — 16 is the ceiling imposed by the encoding, not a requirement. Bundled set:

| id | Entries | Note |
|---|---|---|
| `pico-8` | 16 | Fantasy-console standard |
| `db16` | 16 | DawnBringer 16 |
| `aap-16` | 16 | AAP-16 by Adigun Polack |
| `nes-16` | 16 | Curated 16-color subset of the 54-color NES master palette |
| `gameboy` | 4 | Original DMG green ramp |

A palette with fewer than 16 entries simply makes indices beyond its length invalid; `shared/grid.ts` rejects them like any other off-palette index.

### 6.2 `SpriteDoc`

```ts
{
  schemaVersion: 1,
  id: string,                    // uuid
  createdAt: string,             // ISO 8601
  prompt: string,                // raw user request
  intent: {
    subject: string,             // "red fox, sitting"
    style?: string,              // "16-bit RPG"
    facing?: "front" | "side" | "three-quarter",
    notes?: string
  },
  size: { w: 16|32|64, h: 16|32|64 },
  palette: { id: string, colors: string[] },   // hex, index 0..15
  rows: string[],                // exactly h strings of exactly w chars
  meta: {
    generatorModel: string,
    criticModel: string,
    round: number,
    repairs: number,
    repairedRows: number[],        // amendment A1 — see below
    parentId: string | null
  }
}
```

`id` is a UUID by convention and is **not** format-validated: hand-built test fixtures need to carry readable ids, and enforcing the format buys no safety. `createdAt` *is* validated as ISO 8601.

**Amendment A1 — `meta.repairedRows`.** The original §6.2 omitted this field. It is required: §6.5's `row-repaired` warning is defined per repaired row, and which rows were repaired is knowable only at parse time — it is unrecoverable from the finished grid, because a repaired row is indistinguishable from a row the model got right. The field carries a `[]` default, so a document written to the original §6.2 shape still parses.

### 6.3 Row repair

`qwen3:8b` emits rows of the wrong length routinely, not occasionally — especially at 64×64. This is treated as expected input:

| Defect | Repair |
|---|---|
| Row too short | Pad right with `.` |
| Row too long | Truncate |
| Too few / too many rows | Pad with empty rows / truncate |
| Invalid character | Map to `.` |

Every repair increments `meta.repairs`, which is the honest quality signal for the draft. If repairs exceed `repairRejectThreshold` (default 20% of cells), the draft is rejected and retried once with the specific misalignment described back to the model. A sprite needing 300 repairs is noise; accepting it silently would make the critic chase problems the generator caused.

### 6.4 `CritiqueReport`

```ts
{
  readsAs: string,               // "a red fox, though the ears are ambiguous"
  matchesIntent: boolean,
  overall: 1|2|3|4|5,
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

The two confidence fields are deliberately separate. The valuable cell is high `confidence` with low `suggestConfidence`: *something is definitely wrong here, but my proposed fix is a guess — solve it yourself.* Collapsing them into a single number destroys exactly that signal.

- Issues below `confidenceFloor` are dropped before the revise stage sees them, so the agent does not spend turns on the critic's hallucinations.
- Issues above `confidenceFloor` but below `suggestConfidenceFloor` are passed **without** their `suggest` text, leaving the fix to the agent's judgement.

`suggest` is advisory by design. If it were authoritative we would be building a fully deterministic orchestrator, not an agentic revision stage.

### 6.5 `LintReport`

Pure functions over the grid, zero inference:

```ts
{
  errors: LintWarning[],         // schema violations — block the round; see A2
  warnings: [{
    code: "orphan-pixel" | "unused-palette-entry" | "low-contrast"
        | "outline-gap" | "row-repaired",
    cells: [[x, y], ...],
    message: string
  }],
  metrics: {
    coverage: number,            // fraction non-transparent
    paletteUsed: number,
    orphanCount: number,
    symmetryScore: number        // 0..1 horizontal mirror similarity
  }
}
```

This is where per-cell scoring actually lives — relocated from the VLM to where it is computable. Each code has one definition, and the implementation may not invent others:

| Code | Definition |
|---|---|
| `orphan-pixel` | A **non-transparent** cell whose four orthogonal neighbours are all transparent. Diagonal-only attachment still counts as orphaned; that is the shape that reads as noise at sprite scale. |
| `outline-gap` | A transparent cell with non-transparent cells on **opposite** orthogonal sides (left and right, or above and below). Detects a hole through which fill leaks into the background. |
| `low-contrast` | Two palette indices used as orthogonal neighbours somewhere in the sprite whose relative luminance differs by less than 0.08. Reported once per index pair, not per cell. |
| `unused-palette-entry` | A palette index that never appears in `rows`. Informational — it lowers `paletteUsed`, and a sprite using 3 of 16 entries is usually flat. |
| `row-repaired` | Emitted once per row that section 6.3 had to repair, carrying that row's cells. Surfaces generator failure rather than sprite failure. |

`symmetryScore` is the fraction of non-transparent cells whose mirror about the **vertical centre axis** holds the same index. It is a reported metric, never an error — plenty of good sprites are deliberately asymmetric.

**Amendment A2 — `errors` element shape.** The original §6.5 wrote `errors: [...]` without defining an element, leaving each implementer to invent one. `errors` and `warnings` now share the `LintWarning` shape — `{ code, cells, message }` — and differ only in which list they land in. One type, one renderer, and an error can point at offending cells exactly as a warning does.

### 6.6 Revise-stage tools

```ts
place_pixel(x: number, y: number, index: number | ".")   // "." clears to transparent
fill_row(y: number, x0: number, x1: number, index)        // cheap horizontal runs
done(summary: string)                                     // agent signals completion
```

Capped at `maxReviseTurns`. Every call routes through `shared/grid.ts`. A rejected call returns an error string to the agent rather than throwing, so the agent can correct itself; the attempt still counts against the cap.

### 6.7 `SessionHistory`

```ts
{
  sessionId: string,
  config: HarnessConfig,         // serialized on every run — see 6.8
  rounds: [{
    round: number,
    doc: SpriteDoc,
    critique: CritiqueReport | null,
    lint: LintReport,
    diffFromPrev: [{ x, y, from, to }]
  }]
}
```

Persisted as JSON alongside the sprite. This satisfies the version-control requirement, backs the round filmstrip in the UI, and gives the stop condition its cheapest signal: an empty `diffFromPrev` means the revise stage ran and changed nothing.

### 6.8 `HarnessConfig`

```ts
{
  maxRounds:              number   // default 3
  maxReviseTurns:         number   // default 40
  maxDraftRetries:        number   // default 1
  repairRejectThreshold:  number   // default 0.20
  confidenceFloor:        number   // default 0.30
  suggestConfidenceFloor: number   // default 0.50
  stopOnNoHighSeverity:   boolean  // default true
  criticUpscale:          number   // default 16 → 32×32 renders to 512×512
  callTimeoutMs:          number   // default 120000
  models: { generator: string, critic: string }
}
```

**The config is serialized into `SessionHistory` on every run.** Without that, two benchmark runs cannot be compared — a difference in output might come from the change under test or from a limit that was altered and forgotten.

## 7. Pipeline and control flow

### 7.1 State machine

```
IDLE ──start(prompt, size, palette)──► DRAFTING
                                          │
        ┌── repairs > threshold ──────────┤
        │   && retries remain             │ ok
        └──────────► DRAFTING             ▼
                                       LINTING ──errors──► FAILED
                                          │ ok
                                          ▼
                                     CRITIQUING
                        ┌─────────────────┼─────────────────┐
             no high-sev│      round ≥    │                 │ issues remain
             issues     │      maxRounds  │                 ▼
                        ▼                 ▼             REVISING
                   AWAITING_USER ◄────────┘        (≤ maxReviseTurns)
                     │        ▲                          │
              accept │        │ feedback                 │ done() / cap
                     ▼        │                          ▼
                   DONE       └──────────── snapshot round, empty diff?
                                              │                │
                                      no ─────┘                └── yes ──► AWAITING_USER
                                      (round+1 → LINTING)
```

Every transition emits a typed event over IPC so the UI shows live progress rather than a spinner.

### 7.2 Stop conditions

**Ordering matters and is not optional:** the confidence filters from 6.4 are applied to the issue list *first*, and stop conditions are evaluated on the **filtered** list. A high-severity issue the critic reported at `confidence: 0.1` is discarded, and therefore does not keep the loop running.

Three independent conditions, each catching a different failure:

1. **No high-severity issues** (after filtering) — the intended success path.
2. **Round cap** — bounds worst-case latency.
3. **Empty diff** — the revise stage ran and changed nothing. Without this, a critic reporting an issue the agent cannot fix burns every round, every time.

### 7.3 User feedback

At the gate, user feedback is injected as a **synthetic high-severity issue** with `confidence: 1.0` and `suggestConfidence: 0.0`, re-entering the machine at `REVISING`. Agent feedback and user feedback then travel one code path, so there is a single loop to build, test and debug rather than two.

### 7.4 Prompt strategy

- **Draft** — system prompt carries encoding rules, canvas dimensions, and the palette as an indexed table, plus two short worked examples. Prefixed `/no_think`: qwen3's thinking mode roughly doubles the 30 s draft for no benefit on a formatting-constrained task.
- **Critique** — the upscaled PNG, the raw row text, and the intent. Image for gestalt, text for coordinates.
- **Revise** — the filtered issue list, the current grid as text, and the three tools.

## 8. User interface

Canvas-centric layout, validated as an interactive prototype during design.

```
┌──────────────────────────────────────────────────────────┐
│ [prompt............] [Generate] [32▾] [pico-8▾] [models▾] │
├────────────────────────────────────┬─────────────────────┤
│                                    │  CRITIQUE · round 2 │
│            pixel canvas            │  ┌────────────────┐ │
│         (dominant, zoomable)       │  │ left eye reads │ │
│                                    │  │ as a smudge    │ │
│                                    │  │ conf .91 ▓▓▓▓  │ │
│           palette swatches         │  │ sugg .40 ▓▓    │ │
│                                    │  └────────────────┘ │
├────────────────────────────────────┴─────────────────────┤
│ [draft] [r1] [r2] [r3]              [Accept] [Export PNG] │
├──────────────────────────────────────────────────────────┤
│ ● AWAITING_USER — no high-severity issues · 3 rounds      │
└──────────────────────────────────────────────────────────┘
```

- **Canvas dominates.** Manual editing uses the active palette color and routes through `shared/grid.ts`.
- **Round filmstrip along the bottom.** Each frame is built by applying that round's `diffFromPrev` to the previous round, so the history being scrubbed *is* the data model. This makes rounds spatially comparable in a way a sidebar list does not.
- **Critique dock appears only when issues exist**, keeping the canvas dominant during manual editing when the critic has nothing to say. Clicking an issue highlights its region on the canvas.
- **Confidence rendered as twin bars**, so the high-confidence/low-suggest-confidence case is visible at a glance.
- **Status bar** names the current state and the stop condition that fired.

## 9. Error handling

*Not yet reviewed — scrutinise this section.*

| Failure | Response |
|---|---|
| Ollama unreachable | Status bar names the exact endpoint; Generate disabled; explicit retry. No silent fallback. |
| Bound model not installed | Pickers list only installed models, so this is mostly prevented. If a model disappears mid-session, fail the round naming the model and the `ollama pull` command that fixes it. |
| Draft repairs over threshold | Retry once with the misalignment described back to the model; on second failure enter `FAILED` with the raw model output preserved in history for debugging. |
| Critic returns non-JSON or schema-invalid output | Reprompt once with the validation error appended. On second failure, treat the round as "no issues" and advance to `AWAITING_USER`. A broken critic must not destroy a valid sprite. |
| Critic returns an out-of-bounds region | Clamp to canvas and warn. If the region lies entirely outside, drop the issue. |
| Revise agent emits an invalid tool call | Return an error string to the agent so it can self-correct; the attempt counts against the turn cap. |
| Revise agent hits the turn cap without `done()` | Accept whatever edits landed, snapshot the round, continue. The empty-diff condition handles the degenerate case. |
| Revise agent makes the sprite worse | **Any round may be accepted, not only the last.** The filmstrip is the mitigation — the user scrubs back and accepts an earlier round. |
| Model call exceeds `callTimeoutMs` | Abort via `AbortController`, fail the round with elapsed time shown. |
| App closes mid-run | `SessionHistory` is written after each round, so at most one round is lost. |

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

| Criterion | Bar |
|---|---|
| Completes without crash | 10 / 10 |
| Median `meta.repairs` | < 5% of cells |
| Linter errors on final sprite | 0 / 10 |
| Converges before the round cap | ≥ 5 / 10 |
| Human rating ≥ 3/5 | ≥ 6 / 10 *(provisional)* |

The first four are objective and should hold. The fifth is subjective, and it is the one that determines whether the critic is earning its runtime — if a 7B VLM turns out too weak to critique pixel art usefully, that shows up here, and the response is to try `qwen3-vl:30b-a3b` before redesigning the loop.

## 12. Provisional decisions

Recorded so they are revisited rather than inherited:

- **Critic criteria were designed before observing real failure modes.** The recommendation during brainstorming was to ship generation first and design the critic against real output; the decision was to spec the full MVP in one pass. The severity thresholds, `confidenceFloor`, and `suggestConfidenceFloor` defaults are therefore first guesses to be tuned with `npm run bench`.
- **`maxRounds: 3`** is a latency-driven guess (~90 s worst case), not an empirical optimum.
- **The 16-color cap** follows from single-hex-character encoding. Raising it means changing the encoding.
- **`qwen3-vl:8b-instruct` as default critic** — untested on this task. The 30b-a3b upgrade path exists precisely because 8B may prove insufficient.

## 13. Deferred work, in intended order

1. **Reference image input** — user-supplied reference PNG compared against the sprite by the critic. Explicitly the first thing to build after the MVP works.
2. Sprite sheet generation — walk cycle first.
3. Character editing (clothes, armor) — try the existing feedback loop before building anything new; it may already work.
4. Hosted model adapters behind the existing client interface.
