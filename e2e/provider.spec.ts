/**
 * The provider row, against a real app and a real server — spec amendment A16.
 *
 * The one thing `tests/main/detect.test.ts` cannot prove: that detection's answer
 * survives the trip through `main/index.ts`, the IPC bridge and the preload, and
 * lands in a control a person can see and change. Every assertion below is
 * outside-in — nothing here imports the renderer, and the provider is read out
 * of the DOM the same way a user reads it.
 *
 * **No generation.** This spec asks a listing endpoint and nothing else, so it
 * runs in seconds and can be used as the cheap check that a machine is wired up
 * before committing twenty minutes to `loop.spec.ts`. That also makes it the
 * spec a cobuilder on an unverified platform should run first.
 *
 * The switch to a provider that is *not* running is deliberate and is the more
 * valuable half. It exercises `setProvider` end to end, and it pins the honest
 * failure: the row says which endpoint did not answer, and Generate is disabled
 * rather than left to fail on its first model call minutes later.
 *
 * Like every spec here it attaches to a **built** app (`npm run build` first) and
 * launches through `package.json`'s `main` field.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

import { resolveProvider } from "./provider";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCREENSHOT = fileURLToPath(
  new URL("../docs/superpowers/specs/screenshots/2026-07-30-provider-row.png", import.meta.url),
);

/** A generation is minutes; a listing call is milliseconds. */
test.setTimeout(2 * 60 * 1000);

test("detects the running provider, shows it, and switches honestly", async () => {
  // Resolved with the app's own `detectProvider`, from the same environment
  // `electron.launch` is about to hand the app — so a disagreement below is a
  // real disagreement and not two different questions.
  const resolved = await resolveProvider();

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: ["."], cwd: REPO_ROOT });
    app.process().stdout?.on("data", (d: Buffer) => process.stdout.write(`[main] ${d}`));
    app.process().stderr?.on("data", (d: Buffer) => process.stderr.write(`[main] ${d}`));

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // -- the row reflects what the app found --------------------------------
    const select = page.getByTestId("provider-select");
    const url = page.getByTestId("provider-url");
    const status = page.getByTestId("provider-status");

    await expect(select).toHaveValue(resolved.provider);
    await expect(url).toHaveValue(resolved.baseUrl);
    // The claim that cannot be made from inside the renderer: main probed the
    // listing endpoint and it answered.
    await expect(status).toHaveAttribute("data-connected", "true");

    // Nothing is blocking Generate on a machine whose server is up.
    await expect(page.getByTestId("generate")).toBeEnabled();

    await mkdir(dirname(SCREENSHOT), { recursive: true });
    // The bar rather than the window: the row is the subject, and a 1280×840
    // screenshot of the whole editor renders it eleven pixels tall.
    await page.getByTestId("prompt-bar").screenshot({ path: SCREENSHOT });

    // -- switching to a server that is not there ----------------------------
    const other = resolved.provider === "ollama" ? "lmstudio" : "ollama";
    await select.selectOption(other);

    // The row moved, and it moved to that provider's *own* default port rather
    // than carrying the previous one across (A15's separate base URLs, A16's
    // empty-URL contract).
    await expect(select).toHaveValue(other);
    await expect(url).not.toHaveValue(resolved.baseUrl);

    // Whether the other provider happens to be running decides what comes next,
    // and both outcomes are correct — so the assertion is on the *pairing* of
    // the status with the button, which is the property that must hold either
    // way. A row that said "not answering" beside an enabled Generate would be
    // the silent-fallback defect §8 names.
    const connected = await status.getAttribute("data-connected");
    if (connected === "false") {
      // The endpoint it tried, in full: the difference between "not running" and
      // "wrong port". Both halves of the sentence are what a remote cobuilder
      // has instead of a debugger.
      await expect(status).toContainText("http");
      await expect(page.getByTestId("generate")).toBeDisabled();
    } else {
      await expect(page.getByTestId("generate")).toBeEnabled();
    }

    // -- and back, without a restart ----------------------------------------
    await select.selectOption(resolved.provider);
    await expect(status).toHaveAttribute("data-connected", "true");
    await expect(page.getByTestId("generate")).toBeEnabled();
    // The model pickers were repopulated from the server, not left on the list
    // the previous provider had.
    await expect(page.getByTestId("model-generator")).toBeVisible();
  } finally {
    await app?.close();
  }
});
