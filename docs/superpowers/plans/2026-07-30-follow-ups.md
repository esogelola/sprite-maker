# Follow-ups — Waves 13, 14, and the open questions

**Date:** 2026-07-30
**State at writing:** 46 commits, 1501 tests, `tsc` clean. Waves 1–12 shipped. The app builds, boots, generates, critiques, revises, guards, and lets the user accept any round.

This document is the handoff. It carries the two unbuilt waves at full implementation detail, and — more importantly — the open questions the measurements raised, so whoever picks this up inherits the evidence rather than the optimism.

---

## Read this first: what is actually true about the product

Four things are measured, captured in `docs/superpowers/specs/captures/`, and load-bearing for anything built next.

**1. The harness works. The generator mostly does not.** 1501 tests, a state machine with three stop conditions, deterministic linting, a regression guard, an IPC layer with a single-flight session, and a UI that renders all of it honestly. None of that is in question. What is in question is whether a locally-runnable model can draw a recognisable 16×16 sprite. `captures/2026-07-30-reference-experiment.png` is the clearest evidence: without an exemplar, three seeds of "a dog standing" produced blue triangles and green stripes — **no animal at all**.

**2. Revision is net-negative and correctly suppressed.** Measured across 5 seeds with the real critique on the real failing sprite (`captures/2026-07-30-revise-tool-measurement.txt`): mean Δsymmetry was negative in **every** configuration. Shape operations made it six times worse; showing the model the canvas between turns also made it worse. Amendment A14's guard now discards regressions — and **8 of 9 live sessions end `revise-regressed` after round 1**. Of 11 sessions observed, **none had a round better than its draft**. The tool works as *generate → judge → keep*. It does not work as *iterate*.

**3. The critic diagnoses well and scores badly.** Its issues are correct and correctly localised ("legs too short and disconnected", regions landing on real cells, honest `suggestConfidence: 0.20`). But `overall` ran 1 → 4 → 3 while symmetry fell monotonically 0.913 → 0.493 → 0.441. It is **anti-correlated** with every deterministic metric. §7.2 stops on issue severity, not on `overall`, so nothing in the control flow depends on it — but nothing should start to.

**4. Every measurement before amendment A13 is n=1 against unquantified variance.** No stage passed `options` at all, so there was no seed and no temperature anywhere. A13 fixed it and proved seeding works on this hardware — but note the correction in `captures/2026-07-30-wave-8b-determinism.txt`: **a bench sweeping seeds to estimate variance must not do it at temperature 0**, because greedy decoding never consults the RNG and two seeds produce identical bytes.

---

## Wave 13 — PNG export and the benchmark runner

**Goal:** the tool produces a file you can use, and the quality instrument exists.

### Scope table

| New files | Modified files |
|---|---|
| `src/main/export.ts`, `bench/run.ts`, `bench/prompts.ts`, `tests/main/export.test.ts` | `package.json`, `tsconfig.json`, `src/main/ipc.ts`, `src/renderer/components/GateBar.tsx`, `src/shared/schema.ts` |

`schema.ts` reopens once more for `STRUCTURAL_LINT_CODES` — see the blocker below.

### Blocker to clear first

**Spec amendment A6's `STRUCTURAL_LINT_CODES` was ratified and never shipped.** §11's acceptance bar reads "zero structural lint warnings", and the split exists because `low-contrast` and `unused-palette-entry` fire on essentially every real sprite — a structurally perfect 32×32 pico-8 sprite emits 14 warnings, and even one using all sixteen indices emits 6, because pico-8 itself contains 15 sub-threshold pairs. A bar written as `warnings.length === 0` reads 0/10 unconditionally.

Wave 12's dock hit this and could not classify warnings without a local hardcoding — precisely the second copy A6 exists to forbid. Export the set from `shared/schema.ts`:

```ts
export const STRUCTURAL_LINT_CODES = ["orphan-pixel", "outline-gap"] as const;
```

Then §11, the bench CSV and Wave 14's gate all filter identically.

### Build

**`src/main/export.ts`**

```ts
export async function exportPng(doc: SpriteDoc, scale: 1|4|8|16, outPath: string): Promise<string>
```

`toPng(doc, scale)` already exists and is golden-file tested. **Omit the background argument** — export must preserve alpha; only the critique path composites (§4.5).

`Api.exportPng` opens `dialog.showSaveDialog` on the main window and resolves to the chosen absolute path, or `""` on cancel. Wave 10 registered a `not-implemented` stub for exactly this; replace it. **`toPng` accepts any positive integer scale**, so Wave 13 must validate the `1|4|8|16` union at runtime itself — the union is compile-time only.

**`bench/run.ts`** — `"bench": "tsx bench/run.ts"`. Add `tsx`; add `bench/**` to `tsconfig.json`'s `include`, which currently omits it so `npm run typecheck` skips the whole directory.

Ten prompts from §11 (flower, dog, sword, tree, house, fox, chest, potion, knight, fish), pinned at `size: 32`, `paletteId: "pico-8"`.

CSV columns:
```
prompt, size, palette, generator, critic, seed, temperature, ok, error,
repairs, repairPct, rounds, stopReason,
orphanCount, outlineGapCount, lowContrastPairs, unusedEntries,
paletteUsed, symmetryScore, coverage,
draftMs, critiqueMs, reviseMs, totalMs, reviseTurns, hitCap
```

Four things that are not obvious:

- **`totalMs` is wall-clocked around the `run()` call**, not summed from `Round.timings`. Summing gives 0 for a draft-rejected run — the row whose duration matters most — and omits retry and orchestration time. Per-stage timings still come from `Round.timings`.
- **Per-code lint counts, not one total.** See the A6 blocker.
- **Warm the model before the first row.** Cold start is 15.7s against 5.9s warm for identical bytes (`captures/2026-07-30-wave-8b-determinism.txt`), and it is not proportional to canvas area.
- **`revise-regressed` will dominate `stopReason`.** 8 of 9 sessions. Do not treat it as an error column.

### Acceptance

1. `npm test` green; `npm run typecheck` now covers `bench/`.
2. Bench CSV committed with 10 real rows, non-zero `totalMs`, and a valid `stopReason` or `error` per row.
3. Exported PNG committed at the declared scale with correct dimensions and **alpha preserved**.
4. Scale 3 rejected at runtime, not merely by the type.
5. Bench runs headless — no Electron, no window.
6. `STRUCTURAL_LINT_CODES` exported and consumed by the bench, the dock and §11.

---

## Wave 14 — the final human gate

A **human** gate. Pausing here is the designed outcome, not a failure.

| # | Feature | Spec | Exercised by |
|---|---|---|---|
| 1 | NL prompt → pixel art | §7.4 | Fresh prompt, generate, see a sprite |
| 2 | Canvas 16/32/64 | §2 | One sprite at each size |
| 3 | Curated palettes | §6.1a | `pico-8` and `gameboy` (4-colour) |
| 4 | Deterministic linter | §6.5 | Hand-place an orphan; confirm the dock's lint block updates |
| 5 | Critique with regions | §6.4 | Click an issue; the region highlights correctly |
| 6 | Split confidence | §6.4 | Find a low-`suggestConfidence` issue; confirm `suggest` is withheld |
| 7 | Bounded revise loop | §6.6 | Watch pixels change; confirm `Round.revise.turns` ≤ cap |
| 8 | Auto-converge ≤3 rounds | §7.2 | Status bar's stop reason matches `SessionHistory.stopReason` |
| 9 | User feedback loop | §7.3 | Feedback at the gate runs another round; `Round.userFeedback` records it |
| 10 | Accept any round | §9 | Scrub back, accept; `acceptedRound` on disk |
| 11 | Manual editing | §2 | Paint by hand |
| 12 | PNG export | §2 | Export at 8×, open the file — **including hand edits from #11** |
| 13 | Model pickers | §2 | Swap the critic; confirm via `meta.criticModel` on the next round |
| 14 | Version history | §6.7 | Session JSON at `getSessionPath()` round-trips and embeds `config` |
| **15** | **Regression guard** | **§7.2 A14** | **Confirm a `revise-regressed` run kept the better document** |

Feature 15 is new since the plan was written and is the one most worth a human eye: it fires in most sessions.

### Then measure §11 honestly

| Criterion | Bar | Read from |
|---|---|---|
| Completes without crash | 10/10 | `outcome === "completed"` |
| Median `meta.repairs` | < 5% of cells | `rounds[0].doc.meta.repairs / (w×h)` |
| Zero **structural** lint warnings | 10/10 | filter by `STRUCTURAL_LINT_CODES` |
| Converges before the round cap | ≥ 5/10 | `stopReason === "no-high-severity"` |
| Critic actually ran | 10/10 | `stopReason !== "critic-failed"` |
| Human rating ≥ 3/5 | ≥ 6/10 *(provisional)* | the human |

**Expect the convergence bar to fail.** `revise-regressed` is now the most common stop reason, and it is neither convergence nor failure. §11 was written before A14 existed and needs a sixth row, or a redefinition of what convergence means when the correct outcome is "the draft was already the best round".

The final act is a `docs(spec):` commit replacing §11 and §12's guesses with measured values.

---

## Open questions — in the order I would take them

### 1. Do references teach an idiom, or only supply an answer? *(~2 minutes)*

The cheapest unanswered question, and the user's own hypothesis.

`captures/2026-07-30-reference-experiment.txt` shows that supplying a hand-built dog and asking for a dog produces **verbatim copies** — every metric identical, grids byte-identical. That is the correct lazy answer, not evidence about transfer. It also showed the image channel adding nothing over a text grid, at double the latency.

**The test:** show the dog reference, ask for a **cat**. A well-formed cat in the reference's idiom means references work and the fix is a curated exemplar library. Another dog means the mechanism is retrieval, and references are a dead end for craft.

Harness: `captures/2026-07-30-reference-experiment.txt` describes it; the script is a small edit away from the one that produced the contact sheet.

### 2. Is the gap craft or capability?

`qwen3-vl:30b-a3b-instruct-q4_K_M` produced the only genuinely good sprite in the whole project — a 16×16 fox with ears, eyes, body and legs, in 4.5s. It is 19 GB against the 8B's 6 GB, and the development machine sits at ~24% free memory with the app running.

If (1) says references are retrieval, model capability is the remaining lever and this is the experiment. Run the same 5-seed harness against the 30B on the §11 prompt set. **Do not do this while the machine is in use** — it swaps hard.

### 3. Should the revise stage run at all?

It is now safe and still useless: guarded, net-negative, and suppressed in 8 of 9 sessions. Options, in increasing honesty:

- leave it (costs minutes per run for a round that is nearly always discarded)
- default `maxRounds: 1` and make iteration explicitly opt-in
- remove the stage and keep draft → critique → user gate

This is a product decision, not a technical one. The measurement is unambiguous; what to do about it is not.

### 4. Cancellation

Flagged independently by Waves 8 and 9. `revise()` takes no `signal`, so a run in flight cannot be stopped — only the per-call area-scaled `callTimeoutMs` bounds it, and a 3-round run is minutes. Neither implementer invented one, correctly: threading a signal from the renderer through IPC into the loop is a design decision, not a patch. Wave 12's gate bar is where the Stop button would live.

### 5. Smaller, recorded

- **`orphan-pixel` finds detached pixels, not detached components.** §6.5 counts a cell whose four orthogonal neighbours are transparent, so two adjacent detached cells rescue each other — Wave 11's floating yellow bar scores `orphanCount: 0`. The A14 guard's orphan check never fired across six live transitions; symmetry and coverage do the work.
- **A rejected feedback pass loses the user's words.** `userFeedback` attaches to the round the feedback produced, and a guarded rejection produces none.
- **A rejected round never enters the history**, so §6.7's "any round may be accepted" is narrowed — the user cannot choose a round the guard discarded.
- **`SessionHistory.schemaVersion` was not bumped** when A13 added `seed` and `temperature`. A pre-A13 artifact re-parses claiming `temperature: 0.6`, a limit that run never used — exactly the staleness §6.8 exists to prevent.

---

## How this project was built

Worth knowing, because the process is why the findings above exist rather than being discovered by a user.

Every wave ran as: implementer subagent → **independent** reviewer subagent → commit. Reviewers were briefed to try to reject, and told which mutants the implementer had already run so they would probe elsewhere. Implementers mutation-tested their own suites before submitting, which moved most coverage work out of the review cycle.

That found, among others: a palette singleton that was mutable behind a test that could never fail; a `normalize` acceptance criterion that was simply wrong in the plan, which an implementer refused to conform to; a state machine that returned zero rounds on its own success path; an IPC race that told the user their Accept had worked when it had not; and a `format` spelling that type-checked and silently did nothing.

The single highest-yield instruction in any brief was **"read ahead to the waves that consume your output and report anything that will not serve them."** Four of the first five spec defects came from that line. The whitelist that keeps reviews tractable also makes each wave blind to its consumers, and read-ahead is what buys the sight back.

The second highest-yield was **"falsy zero is a named defect class here."** It near-missed six times, always on the value that mattered most: index 0 is `#000000`, the standard outline colour; `roundIndex: 0` is the first round and the most common accept target; `temperature: 0` is what a bench run sets.
