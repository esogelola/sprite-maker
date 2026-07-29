# Sprite Maker

An Electron desktop app that turns a natural-language prompt into pixel art.

A local **Qwen 3** model drafts the sprite as rows of encoded characters; a local
**Qwen 3 VL** vision model critiques the rendered result; a bounded agentic
revise stage edits pixels through a small tool surface. The user gates the
outcome and can accept any round, not just the last.

Everything runs locally against [Ollama](https://ollama.com). No sprite, prompt,
or image leaves the machine.

## Status

**Wave 1 of 14 — scaffold, schemas and palettes.** There is no application yet.
What exists today is the toolchain, the contract layer (`src/shared/schema.ts`)
and the bundled palette library (`src/shared/palettes.ts`), both under test.

- Design spec: `docs/superpowers/specs/2026-07-28-sprite-maker-design.md` (authoritative)
- Implementation plan: `docs/superpowers/plans/2026-07-28-sprite-maker-mvp.md`
- Ratified editor layout: `docs/superpowers/specs/design/2026-07-28-editor-layout-b.html`

## Prerequisites

- **Node 22.9+** (the Electron 43 / electron-vite 5 toolchain asks for >= 22.12;
  see "Known toolchain notes" below)
- **npm**
- **Ollama** running locally on `http://localhost:11434`

### Pull the default models

```sh
ollama pull qwen3:8b
ollama pull qwen3-vl:8b-instruct-q4_K_M
```

`qwen3:8b` is the generator and `qwen3-vl:8b-instruct-q4_K_M` is the critic.
Both bindings are defaults in `DEFAULT_HARNESS_CONFIG` and are swappable at
runtime through the model pickers once the UI lands.

## Install

```sh
npm install
```

## Running the tests

```sh
npm test          # vitest, single run
npm run test:watch
npm run typecheck # tsc --noEmit
```

The unit suite is pure and **does not require Ollama to be running**. Every
module that talks to a model takes a client interface, and `src/main/ollama.ts`
is the only place HTTP is allowed to happen.

## Concepts worth knowing before reading the code

**Row encoding.** A sprite is an array of strings, one character per pixel.
`.` is transparent and `0`–`f` is a palette index. That caps a palette at 16
opaque colors, which is the constraint that makes the output read as pixel art
rather than as a downsampled photo. It also makes a row's character count equal
its pixel count, so validation is trivial.

```
"................"
".....0000000...."
"....011111100..."
"...01122222110.."
```

**Bundled palettes.** `pico-8`, `db16` (DawnBringer 16), `aap-16`, `nes-16`
(a curated subset of the NES master palette) and `gameboy` (the 4-color DMG
green ramp). A palette shorter than 16 entries simply makes the indices past
its end off-palette.

**Split confidence.** A critique issue carries both `confidence` (is the problem
real?) and `suggestConfidence` (is my proposed fix right?). The valuable case is
high confidence with low suggest-confidence: *something is definitely wrong here,
but my fix is a guess — solve it yourself.* Issues below `confidenceFloor` are
dropped; issues above it but below `suggestConfidenceFloor` are kept with their
`suggest` text withheld.

## Layout

```
src/shared/     contracts and pure logic, imported by both processes
src/main/       harness: Ollama client, lint, render, draft/critique/revise, pipeline
src/renderer/   React UI
tests/          vitest suites, mirroring src/
docs/           spec, plan, and committed evidence artifacts
```

## Known toolchain notes

- `electron@43` and `electron-vite@5` declare `engines.node >= 22.12`, while the
  plan pins Node 22.9. `npm install` succeeds with `EBADENGINE` warnings and the
  test suite is unaffected, but the Electron dev server (Wave 10) has not yet
  been exercised on 22.9.
- TypeScript 7 removed the `baseUrl` compiler option, so the `@shared/*` and
  `@main/*` path aliases in `tsconfig.json` are written as relative paths.
