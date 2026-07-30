/**
 * The sprite, visible — plan Wave 11, acceptance criteria 3, 4, 7 and 8.
 *
 * This is the wave's evidence, and it is deliberately one test rather than
 * several. The question the user asked cannot be answered by a unit test and
 * cannot be answered by a single screenshot: *"I do think the reviser messes up
 * the sprite, but only 1 way to confirm and that's when I can see it visually."*
 * Answering it needs one real generation, rendered in colour, at every round it
 * produced, from the same session — so the three PNGs this writes are comparable
 * frames of one sprite rather than three unrelated pictures.
 *
 * Four things are asserted against a live run:
 *
 * **1. The canvas renders the round the filmstrip selects.** Read back out of the
 * DOM as §6.1 characters and compared against `getSession().rounds[i].doc.rows`,
 * cell for cell. A canvas wired to the last round passes every screenshot and
 * fails this.
 *
 * **2. The rounds are not all the same picture.** Without it, assertion 1 is
 * vacuous on a session whose revise stage changed nothing, and the screenshots
 * would be three copies of one frame presented as a comparison.
 *
 * **3. A hand edit reaches main.** The click goes through `Api.setPixel`, and the
 * check is a fresh `Api.getSession()` — the artifact, not the reply. §8's v1
 * defect was precisely an edit that lived in renderer state: "hand-editing then
 * exporting produced a PNG without the edits **and without an error**."
 *
 * **4. `window.api.getSession` exists on the bridge at all**, which is the Wave 11
 * addition to the preload surface.
 *
 * Like `e2e/boot.spec.ts` this attaches to a **built** app (`npm run build`
 * first — there is no dev server), warms the generator before launching because
 * a cold 6 GB load eats a 16×16 canvas's whole per-call budget (§6.8, A12), and
 * retries the *generation* rather than committing whichever roll of the dice the
 * first attempt produced. The retry here is about round count: §7.2 stops a run
 * the moment a critique converges or a revise pass changes nothing, so a
 * three-round session is a thing this pipeline produces often but not always, and
 * three rounds is what the acceptance criterion asks to see.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const shot = (name: string): string =>
  fileURLToPath(
    new URL(`../docs/superpowers/specs/screenshots/2026-07-30-wave-11-${name}.png`, import.meta.url),
  );

const CAPTURE = fileURLToPath(
  new URL("../docs/superpowers/specs/captures/2026-07-30-wave-11-rounds.txt", import.meta.url),
);

/** The prompt the user ran. Wave 12 adds the size and palette pickers. */
const PROMPT = "a dog standing";

/** Must match `App.tsx`'s `SIZE`. */
const SIDE = 16;

/**
 * §6.8's default for **both** roles (amendment A10), warmed before launch.
 *
 * Asserted against `getModels()` once the app is up, so a changed default fails
 * loudly rather than silently un-warming the run. **Only this model is loaded** —
 * the 19 GB `qwen3-vl:30b-a3b` would evict it and the machine has no room for
 * both.
 */
const MODEL = "qwen3-vl:8b-instruct-q4_K_M";

/** Rounds the acceptance criterion asks to compare. */
const WANTED_ROUNDS = 3;

/** Generations allowed before a short session is reported rather than retried. */
const ATTEMPTS = 3;

/** A bright, unmistakable `pico-8` entry for the hand edit — index 8, `#ff004d`. */
const PAINT_INDEX = "8";

interface RoundJson {
  round: number;
  doc: { rows: string[]; palette: { id: string } };
  lint: { metrics: { coverage: number; paletteUsed: number; orphanCount: number; symmetryScore: number } };
  critique: { overall: number | null; readsAs: string | null } | null;
  diffFromPrev: Array<unknown> | null;
  revise: { turns: number; hitCap: boolean; summary: string } | null;
  timings: { draftMs: number | null; critiqueMs: number | null; reviseMs: number | null };
}

interface SessionJson {
  sessionId: string;
  rounds: RoundJson[];
  stopReason: string | null;
  finalState: string;
  outcome: string;
  error: string | null;
  acceptedRound: number | null;
}

/** The half of `window.api` this spec drives from inside the page. */
interface BridgedApi {
  getSession(): Promise<{ ok: boolean; value?: SessionJson | null }>;
  getModels(): Promise<{ generator: string; critic: string }>;
}

/**
 * Load the generator into Ollama before the app starts.
 *
 * Fixture setup, not the thing under test — and run before `electron.launch`
 * rather than after, because a model load is minutes of heavy memory pressure and
 * holding an idle Electron app open across it cost `boot.spec.ts` a renderer.
 */
async function warmModel(): Promise<void> {
  const ollama = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const response = await fetch(`${ollama}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt: "hi",
      stream: false,
      think: false,
      options: { num_predict: 1 },
    }),
  });
  expect(response.ok, `could not reach Ollama at ${ollama} to warm ${MODEL}`).toBe(true);
}

/**
 * The canvas, read back out of the DOM in §6.1's encoding.
 *
 * Deliberately reconstructed from `data-ch` on the cells rather than from the
 * document: this is the assertion that the *rendered* grid is the selected
 * round's, and reading it from the same object the expectation comes from would
 * assert nothing at all.
 */
async function canvasRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const grid = document.querySelector('[data-testid="canvas"]');
    if (grid === null) return [];
    const rows: string[] = [];
    for (const cell of Array.from(grid.querySelectorAll("[data-x]"))) {
      const y = Number(cell.getAttribute("data-y"));
      rows[y] = (rows[y] ?? "") + (cell.getAttribute("data-ch") ?? "?");
    }
    return rows;
  });
}

async function session(page: Page): Promise<SessionJson | null> {
  const result = await page.evaluate(() =>
    (window as unknown as { api: BridgedApi }).api.getSession(),
  );
  expect(result.ok, "getSession answered a failure envelope").toBe(true);
  return result.value ?? null;
}

/** Painted-cell count, so "the model drew nothing" is distinguishable from success. */
const painted = (rows: string[]): number => rows.join("").replace(/\./g, "").length;

test("renders a real generation round by round, and paints a cell into the session", async () => {
  // Three cold generations plus three rounds each, against a local 8B model on a
  // 16×16 canvas: §12 measures one run in minutes, and the config permits 40
  // model calls per revise pass.
  test.setTimeout(45 * 60 * 1000);

  let best = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const rounds = await runOnce(attempt);
    best = Math.max(best, rounds);
    if (rounds >= WANTED_ROUNDS) return;
  }

  throw new Error(
    `no generation produced ${WANTED_ROUNDS} rounds in ${ATTEMPTS} attempts (best: ${best}). ` +
      "§7.2 stops a run on a converged critique or an empty diff, so this is a short " +
      "session rather than a broken one — but the round-by-round comparison the wave " +
      "asks for needs three frames of one sprite.",
  );
});

/**
 * One cold boot: generate, scrub every round, paint a cell, capture.
 *
 * Returns the round count. Captures are written on the attempt that reaches
 * `WANTED_ROUNDS`, so a short session is retried rather than photographed.
 */
async function runOnce(attempt: number): Promise<number> {
  await warmModel();

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: ["."], cwd: REPO_ROOT });
    app.process().stdout?.on("data", (d: Buffer) => process.stdout.write(`[main] ${d}`));
    app.process().stderr?.on("data", (d: Buffer) => process.stderr.write(`[main] ${d}`));

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // -- assertion 4: the Wave 11 addition to the bridge --------------------
    const hasGetSession = await page.evaluate(
      () => typeof (window as unknown as { api: Record<string, unknown> }).api.getSession,
    );
    expect(hasGetSession, "window.api.getSession is missing from the preload surface").toBe(
      "function",
    );
    expect(await session(page), "a fresh main process holds no session").toBeNull();

    // The model `warmModel` loaded has to be the model the run will call.
    const bound = await page.evaluate(() =>
      (window as unknown as { api: BridgedApi }).api.getModels(),
    );
    expect(bound.generator).toBe(MODEL);
    expect(bound.critic).toBe(MODEL);

    // The empty state: no canvas until there is something to draw.
    await expect(page.getByTestId("empty")).toBeVisible();

    // -- the generation -----------------------------------------------------
    await page.getByTestId("prompt").fill(PROMPT);
    await page.getByTestId("generate").click();

    // `run()` resolves at the gate (§12), which is minutes away; the Generate
    // button re-enables when it does. Polled on the button rather than on a state
    // string so a FAILED run ends the wait instead of timing out.
    await expect
      .poll(async () => page.getByTestId("generate").isEnabled(), {
        message: `attempt ${attempt}: the run never resolved`,
        timeout: 12 * 60 * 1000,
        intervals: [3000],
      })
      .toBe(true);

    const history = await session(page);
    expect(history, "the run produced no session at all").not.toBeNull();
    const rounds = history!.rounds;

    const frames = page.getByTestId("frame");
    await expect(frames).toHaveCount(rounds.length);
    if (rounds.length < WANTED_ROUNDS) return rounds.length;

    // -- assertion 1: the canvas renders the SELECTED round -----------------
    const rendered: string[][] = [];
    for (let i = 0; i < rounds.length; i++) {
      await frames.nth(i).click();
      // The frame the user clicked is the frame that is marked.
      await expect(frames.nth(i)).toHaveAttribute("aria-current", "true");
      await expect
        .poll(async () => (await canvasRows(page)).join("\n"), {
          message: `the canvas never showed round ${i + 1}`,
          timeout: 10 * 1000,
        })
        .toBe(rounds[i].doc.rows.join("\n"));

      const grid = await canvasRows(page);
      expect(grid).toHaveLength(SIDE);
      rendered.push(grid);

      await mkdir(dirname(shot("round-1")), { recursive: true });
      await page.screenshot({ path: shot(`round-${i + 1}`) });
    }

    // -- assertion 2: they are not all the same picture ---------------------
    const distinct = new Set(rendered.map((g) => g.join("\n")));
    expect(
      distinct.size,
      "every round rendered identically, so scrubbing the filmstrip proves nothing",
    ).toBeGreaterThan(1);

    // -- assertion 3: a hand edit reaches main ------------------------------
    // The last round, so §8's rule 4 mutates in place rather than appending — a
    // new round would be a second thing to explain in the same screenshot.
    const last = rounds.length - 1;
    await frames.nth(last).click();
    await expect(frames.nth(last)).toHaveAttribute("aria-current", "true");

    await page.getByTestId("swatch").nth(Number(PAINT_INDEX) + 1).click();
    await expect(page.getByTestId("swatch").nth(Number(PAINT_INDEX) + 1)).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The empty cell nearest the middle: a mark the user can find in a screenshot
    // without being told where to look, and one that replaces nothing.
    const spot = await page.evaluate((side: number) => {
      const centre = (side - 1) / 2;
      let best: { x: number; y: number; d: number } | null = null;
      for (const cell of Array.from(document.querySelectorAll("[data-testid='canvas'] [data-x]"))) {
        if (cell.getAttribute("data-transparent") !== "true") continue;
        const x = Number(cell.getAttribute("data-x"));
        const y = Number(cell.getAttribute("data-y"));
        const d = (x - centre) ** 2 + (y - centre) ** 2;
        if (best === null || d < best.d) best = { x, y, d };
      }
      return best;
    }, SIDE);
    expect(spot, "the sprite has no empty cell to paint into").not.toBeNull();

    await page.locator(`[data-testid="canvas"] [data-x="${spot!.x}"][data-y="${spot!.y}"]`).click();

    // The artifact, not the reply: a renderer-local edit passes a DOM assertion
    // and fails this one.
    await expect
      .poll(
        async () => {
          const current = await session(page);
          return current?.rounds[last].doc.rows[spot!.y][spot!.x] ?? "?";
        },
        { message: "the painted cell never reached the session main holds", timeout: 15 * 1000 },
      )
      .toBe(PAINT_INDEX);

    const afterEdit = await session(page);
    expect(afterEdit!.rounds, "editing the last round must not append one").toHaveLength(
      rounds.length,
    );
    expect((await canvasRows(page))[spot!.y][spot!.x]).toBe(PAINT_INDEX);

    await page.screenshot({ path: shot("canvas") });

    // -- the numbers beside the pictures ------------------------------------
    await mkdir(dirname(CAPTURE), { recursive: true });
    await writeFile(
      CAPTURE,
      [
        "Wave 11 — e2e/canvas.spec.ts, live run against local Ollama",
        `captured:   ${new Date().toISOString()}`,
        `attempt:    ${attempt} of ${ATTEMPTS}`,
        `prompt:     "${PROMPT}"  ${SIDE}x${SIDE}  palette ${rounds[0].doc.palette.id}`,
        `models:     generator ${bound.generator} / critic ${bound.critic}`,
        `session:    ${afterEdit!.sessionId}`,
        `outcome:    ${afterEdit!.outcome} · ${afterEdit!.finalState} · stopReason ${String(
          afterEdit!.stopReason,
        )}`,
        `error:      ${String(afterEdit!.error)}`,
        `hand edit:  index ${PAINT_INDEX} at (${spot!.x}, ${spot!.y}) on round ${rounds.length}`,
        "",
        "Per round — the numbers the screenshots should be read against.",
        "",
        ...rounds.flatMap((r, i) => {
          const m = r.lint.metrics;
          return [
            `round ${r.round}`,
            `  painted        ${painted(rendered[i])} of ${SIDE * SIDE}`,
            `  coverage       ${m.coverage.toFixed(3)}`,
            `  symmetry       ${m.symmetryScore.toFixed(3)}`,
            `  palette used   ${m.paletteUsed}`,
            `  orphans        ${m.orphanCount}`,
            `  critique       ${
              r.critique === null
                ? "none"
                : `${String(r.critique.overall)}/5 — ${String(r.critique.readsAs)}`
            }`,
            `  diffFromPrev   ${r.diffFromPrev === null ? "null (no parent)" : `${r.diffFromPrev.length} cells`}`,
            `  revise         ${
              r.revise === null
                ? "did not run"
                : `${r.revise.turns} turns, hitCap ${String(r.revise.hitCap)} — "${r.revise.summary}"`
            }`,
            `  timings ms     draft ${String(r.timings.draftMs)} critique ${String(
              r.timings.critiqueMs,
            )} revise ${String(r.timings.reviseMs)}`,
            "",
            ...rendered[i],
            "",
          ];
        }),
      ].join("\n"),
      "utf8",
    );

    return rounds.length;
  } finally {
    await app?.close();
  }
}
