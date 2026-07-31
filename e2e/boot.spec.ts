/**
 * The app boots, the renderer reaches the pipeline, and a real sprite comes
 * back — plan Wave 10, acceptance criteria 2, 3 and 4.
 *
 * This is the only test in the project that runs the *whole* system: a built
 * Electron app, a real preload across the context bridge, a real Ollama, and
 * real models. Everything else is Vitest against a scripted client.
 *
 * Three assertions carry the wave:
 *
 * **1. `window.api` is defined.** The direct check for the ESM-preload trap.
 * `package.json` declares `"type": "module"`, so electron-vite emits ESM for the
 * preload unless pinned — and Electron will not load an ESM preload in a
 * sandboxed renderer. There is no error and no warning: `window.api` is simply
 * `undefined`, and the symptom points at the `contextBridge` call rather than at
 * the build. If this fails, look at `electron.vite.config.ts` and at
 * `webPreferences.preload` in `src/main/index.ts` before anywhere else — and do
 * not "fix" it with `sandbox: false`.
 *
 * **2. The window's real `webPreferences`.** Read out of the *main process* via
 * `app.evaluate`, not inferred from the source. `contextIsolation: true` and
 * `nodeIntegration: false` are asserted, and `sandbox` is asserted to still be
 * Electron's own default — which is the check that catches the wrong fix for
 * assertion 1, since disabling the sandbox also makes a missing `window.api` go
 * away.
 *
 * **3. The rows are a real grid.** Asserted as a shape — 16 lines of 16
 * characters drawn from `.` and `0`-`f` — and then as *not blank*. "Not empty" is
 * not enough: `App.tsx`'s placeholder is not empty either, and §6.3 explicitly
 * tolerates a draft that repairs down to a fully transparent canvas, which would
 * photograph exactly like a success.
 *
 * **Two things this spec deliberately does not do.**
 *
 * It does not wait for the run to converge. The rounds after the first belong to
 * Wave 12's `e2e/loop.spec.ts` ("a real generation adds a filmstrip frame per
 * round"); gating Wave 10's boot evidence on them would make it hostage to model
 * latency, and §6.8's revise cap alone permits 40 model calls per round. Round
 * 1's snapshot arrives on the `round` event (§7.1) precisely so a surface has
 * something to show long before `run()` resolves at the gate, and that is what is
 * captured here.
 *
 * It does not depend on the generator being lucky. A draft can still come back
 * fully transparent (§6.3 charges that as repairs and tolerates it), so the
 * *capture*
 * retries — a whole cold boot per attempt — rather than committing whichever
 * artifact the first roll of the dice produced. The assertion is not weakened by
 * this: every attempt producing nothing still fails, and says so.
 *
 * The app is launched with `args: ["."]`, so it boots through `package.json`'s
 * `main` field. That is deliberate: the missing `main` field *was* blocker 1, and
 * launching `out/main/index.mjs` directly would leave it unverified.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

import { warmModel } from "./provider";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCREENSHOT = fileURLToPath(
  new URL("../docs/superpowers/specs/screenshots/2026-07-29-wave-10-boot.png", import.meta.url),
);
const CAPTURE = fileURLToPath(
  new URL("../docs/superpowers/specs/captures/2026-07-29-wave-10-boot.txt", import.meta.url),
);

/** Must match `App.tsx`'s `SIZE`, which Wave 12 replaces with a picker. */
const SIDE = 16;

/** The grid `App.tsx` renders, in §6.1's encoding. */
const GRID = new RegExp(`^[.0-9a-f]{${SIDE}}(\\n[.0-9a-f]{${SIDE}}){${SIDE - 1}}$`);

/** Cold boots allowed before an all-transparent draft is called a failure. */
const ATTEMPTS = 4;

/**
 * §6.8's default generator binding, warmed before the app is launched.
 *
 * Spelled here rather than read from the running app because the warm-up has to
 * happen *before* `electron.launch` — see `warmModel`. The duplication is not
 * left to drift: the value is asserted against `getModels()` once the app is up,
 * so a changed default fails loudly instead of silently un-warming the test.
 *
 * **This is an Ollama tag** — A16. The same weights on LM Studio are
 * `qwen3-vl-8b-instruct`, so on a machine where detection resolves LM Studio the
 * app's default binding names a model that server does not have.
 * `e2e/provider.ts`'s preflight is what turns that from a 404 four minutes into
 * a generation into a message at the top of the run naming the provider, the
 * URL and what that server actually has.
 */
const GENERATOR = "qwen3-vl:8b-instruct-q4_K_M";

/**
 * Every key the preload must expose, spelled out rather than imported.
 *
 * An e2e that imported `PRELOAD_CHANNELS` would assert the implementation
 * against itself. `tests/main/ipc.test.ts` pins that table against
 * `main/ipc.ts`; this list is the outside-in check that the surface the renderer
 * actually receives is the one the plan specified.
 */
const API_KEYS = [
  "accept",
  "applyFeedback",
  "bindModel",
  "exportPng",
  "getConfig",
  "getModels",
  "getPalettes",
  "getProvider",
  "getSession",
  "getSessionPath",
  "listModels",
  "onEvent",
  "run",
  "setPixel",
  "setProvider",
];

/**
 * One cold boot: assert the surface, generate, and capture if a sprite appeared.
 *
 * Returns the painted-cell count, or `0` when the draft repaired down to
 * nothing. Every *boot-level* failure throws, so a retry can only ever be about
 * the sprite.
 */
async function bootAndGenerate(attempt: number): Promise<number> {
  // A16: whichever provider the app is about to resolve, not a hardcoded Ollama.
  const resolved = await warmModel(GENERATOR);

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: ["."], cwd: REPO_ROOT });

    // Main-process output, so an Ollama or pipeline failure is diagnosable from
    // the test log rather than only from a screenshot of an empty box.
    app.process().stdout?.on("data", (d: Buffer) => process.stdout.write(`[main] ${d}`));
    app.process().stderr?.on("data", (d: Buffer) => process.stderr.write(`[main] ${d}`));

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // -- assertion 1: the ESM-preload trap ---------------------------------
    const apiType = await page.evaluate(() => typeof (window as { api?: unknown }).api);
    expect(
      apiType,
      "window.api is undefined — the preload did not run. Check that " +
        "out/preload/index.cjs exists and that webPreferences.preload points at it.",
    ).toBe("object");

    const keys = await page.evaluate(() =>
      Object.keys((window as unknown as { api: Record<string, unknown> }).api).sort(),
    );
    expect(keys).toEqual(API_KEYS);

    const types = await page.evaluate(() => {
      const api = (window as unknown as { api: Record<string, unknown> }).api;
      return Object.keys(api).map((k) => typeof api[k]);
    });
    expect(new Set(types)).toEqual(new Set(["function"]));

    // -- assertion 2: the window's real webPreferences ---------------------
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      // `getLastWebPreferences` is present on `WebContents` at runtime in
      // Electron 43 but absent from its `.d.ts`. The cast is narrow and names
      // exactly the three fields the acceptance criterion is about; the
      // alternative — inferring the posture from renderer-side symptoms —
      // cannot distinguish `sandbox: true` from `sandbox: false` at all.
      const last = (
        win.webContents as unknown as {
          getLastWebPreferences(): Record<string, unknown> | null;
        }
      ).getLastWebPreferences();
      return {
        contextIsolation: last?.contextIsolation,
        nodeIntegration: last?.nodeIntegration,
        sandbox: last?.sandbox,
      };
    });
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    // Electron's own default, never set by us. `false` here means someone
    // "fixed" a missing `window.api` by switching off the isolation the preload
    // exists to preserve.
    expect(prefs.sandbox, "sandbox must be left at Electron's default").toBe(true);

    // -- assertion 3: a real generation ------------------------------------
    /**
     * The grid, read off the canvas.
     *
     * Wave 11 replaced Wave 10's `<pre data-testid="rows">` with a real
     * canvas, so the sprite is now a grid of cells carrying `data-x`,
     * `data-y` and `data-ch`. Reassembling the rows from those attributes
     * keeps this test asserting on the *sprite* rather than on whichever
     * element happens to render it — the same helper `canvas.spec.ts` uses.
     */
    const rowsText = async (): Promise<string> =>
      (
        await page.evaluate(() => {
          const grid = document.querySelector('[data-testid="canvas"]');
          if (grid === null) return [];
          const out: string[] = [];
          for (const cell of Array.from(grid.querySelectorAll("[data-x]"))) {
            const y = Number(cell.getAttribute("data-y"));
            out[y] = (out[y] ?? "") + (cell.getAttribute("data-ch") ?? "?");
          }
          return out;
        })
      ).join("\n");

    const status = page.getByTestId("state");

    await expect(status).toHaveText(/IDLE/);
    expect(await rowsText()).not.toMatch(GRID);

    // The model `warmModel` loaded has to be the model the run will call, or the
    // warm-up is a no-op nobody notices. This is what keeps `GENERATOR` honest,
    // and it exercises `getModels` across the bridge at the same time. The
    // *availability* half of that claim is A16's preflight above, which has
    // already asserted the resolved provider actually has this model.
    const bound = await page.evaluate(() =>
      (
        window as unknown as { api: { getModels(): Promise<{ generator: string }> } }
      ).api.getModels(),
    );
    expect(
      bound.generator,
      `the app's default generator binding is not ${GENERATOR}, so the warm-up ` +
        `against ${resolved.provider} at ${resolved.baseUrl} loaded the wrong model`,
    ).toBe(GENERATOR);

    // A16: the app resolved a provider on its own, and the row says which. If it
    // disagrees with the provider this spec warmed, everything after here is
    // measuring a different server.
    const view = await page.evaluate(() =>
      (
        window as unknown as {
          api: { getProvider(): Promise<{ ok: boolean; value?: { provider: string; baseUrl: string } }> };
        }
      ).api.getProvider(),
    );
    expect(view.ok).toBe(true);
    expect(view.value?.provider).toBe(resolved.provider);
    expect(view.value?.baseUrl).toBe(resolved.baseUrl);

    await page.getByTestId("prompt").fill("a sitting red fox, front facing");
    await page.getByTestId("generate").click();

    /**
     * Round 1's snapshot, delivered by the `round` event as soon as the draft has
     * been linted and critiqued.
     *
     * The rows are checked *before* the error surfaces, because a run that fails
     * after round 1 was snapshotted still has a grid to show and that is the
     * artifact this test wants. Only when the placeholder is still on screen does
     * a reported failure become the polled value, so a draft that never produced
     * a document says so instead of timing out with "no sprite yet".
     */
    const progress = async (): Promise<string> => {
      const text = await rowsText();
      if (GRID.test(text)) return text;
      const reported = [
        ...(await page.getByTestId("error").allTextContents()),
        ...(await page.getByTestId("history-error").allTextContents()),
      ].join(" | ");
      return reported.length > 0
        ? `no round was ever snapshotted; the pipeline reported: ${reported}`
        : text;
    };

    await expect
      .poll(progress, {
        message: `attempt ${attempt}: no ${SIDE}×${SIDE} grid ever reached the renderer`,
        timeout: 5 * 60 * 1000,
        intervals: [2000],
      })
      .toMatch(GRID);

    const grid = await rowsText();
    const painted = grid.replace(/[\n.]/g, "");
    if (painted.length === 0) return 0;

    await mkdir(dirname(SCREENSHOT), { recursive: true });
    await page.screenshot({ path: SCREENSHOT });

    const sessionPath = await page.evaluate(() =>
      (window as unknown as { api: { getSessionPath(): Promise<string> } }).api.getSessionPath(),
    );

    await mkdir(dirname(CAPTURE), { recursive: true });
    await writeFile(
      CAPTURE,
      [
        "Wave 10 — e2e/boot.spec.ts, live run against a local model server",
        `captured: ${new Date().toISOString()}`,
        `provider: ${resolved.provider} at ${resolved.baseUrl} (${resolved.source})`,
        `cold boots attempted: ${attempt} of ${ATTEMPTS}`,
        `webPreferences: ${JSON.stringify(prefs)}`,
        `window.api keys: ${keys.join(", ")}`,
        `generator: ${bound.generator}`,
        `status bar at capture: ${(await status.textContent()) ?? ""}`,
        `session directory: ${sessionPath}`,
        `painted cells: ${painted.length} of ${SIDE * SIDE}`,
        `palette indices used: ${[...new Set(painted)].sort().join("")}`,
        "",
        grid,
        "",
      ].join("\n"),
      "utf8",
    );

    return painted.length;
  } finally {
    await app?.close();
  }
}

test("boots, exposes window.api, and generates a real sprite", async () => {
  const blanks: number[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const painted = await bootAndGenerate(attempt);
    if (painted > 0) return;
    blanks.push(attempt);
  }
  throw new Error(
    `the generator repaired down to a fully transparent ${SIDE}×${SIDE} canvas on ` +
      `all ${blanks.length} attempts — nothing was drawn, so there is no sprite to capture`,
  );
});
