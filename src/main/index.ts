/**
 * The Electron entry point — spec §5.1; plan Wave 10, blockers 1 and 2.
 *
 * `package.json`'s `"main": "./out/main/index.mjs"` names the file electron-vite
 * builds from this one. Without that field electron-vite throws
 * `No entry point found for electron app` and nothing is built at all, which is
 * how this project reached Wave 10 with 1125 passing tests and no window.
 *
 * Three things here are security-relevant and each is checked by Wave 10's
 * acceptance criteria:
 *
 * - **`contextIsolation: true`** — the preload's `contextBridge` is the only
 *   thing the renderer can reach (§5.1).
 * - **`nodeIntegration: false`** — the renderer holds no pipeline logic and needs
 *   no Node.
 * - **`sandbox` is left at its default**, deliberately unset. A missing
 *   `window.api` is an ESM-preload problem (see below); `sandbox: false` makes
 *   that symptom disappear by turning off the isolation the preload exists to
 *   preserve, which is why the plan names it as the wrong fix.
 *
 * **The preload is `index.cjs`, not `index.mjs`.** `package.json` says
 * `"type": "module"`, so electron-vite would emit ESM for the preload too, and
 * Electron will not load an ESM preload in a sandboxed renderer — silently.
 * `electron.vite.config.ts` pins `format: "cjs"`; this path is the other half of
 * that pin, and a `.mjs` here is a `window.api` of `undefined`.
 *
 * Paths are resolved from `import.meta.url` rather than `__dirname`, which does
 * not exist in the ESM bundle electron-vite emits for main.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, app, shell } from "electron";

import { registerIpc } from "@main/ipc";
import { createOllamaClient } from "@main/ollama";
import { HarnessConfigSchema } from "@shared/schema";

/** Relative to `out/main/`, which is where this file runs from once built. */
const fromOut = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** Blocker 2 — `.cjs`, and `electron.vite.config.ts` is what makes it one. */
const PRELOAD = fromOut("../preload/index.cjs");
const RENDERER_HTML = fromOut("../renderer/index.html");

/**
 * The live config, shared by reference with the model registry.
 *
 * `bindModel` writes through to this object (`models.ts`), so a rebind reaches
 * the next `run` *and* the `HarnessConfig` serialized into its `SessionHistory`.
 * Parsed rather than spread from `DEFAULT_HARNESS_CONFIG` so this process starts
 * from a value the strict schema has actually accepted.
 */
const config = HarnessConfigSchema.parse({});

let win: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: "#14161c",
    title: "Sprite Maker",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // `sandbox` is intentionally absent — see the header.
    },
  });

  // Shown on `ready-to-show` rather than immediately, so the first paint is the
  // app rather than a white rectangle.
  window.on("ready-to-show", () => window.show());

  // A local-first app has no reason to navigate anywhere; anything that tries
  // goes to the user's browser instead of replacing the editor.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer !== undefined && devServer.length > 0) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(RENDERER_HTML);
  }

  return window;
}

void app.whenReady().then(() => {
  registerIpc({
    client: createOllamaClient(process.env.OLLAMA_BASE_URL),
    config,
    // Outside the repo on purpose: sessions are user data, not build output, and
    // §9 has one written after every round.
    sessionDir: join(app.getPath("userData"), "sessions"),
    // A getter, because handlers are registered before the window exists and an
    // event can fire after it is destroyed.
    renderer: () => (win === null || win.isDestroyed() ? null : win.webContents),
  });

  win = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS included: this is a single-window editor, and leaving a dockless,
  // windowless process running is what makes `_electron.launch()` hang on the
  // next e2e run.
  app.quit();
});
