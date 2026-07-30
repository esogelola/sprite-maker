/**
 * The build — plan Wave 10, blockers 1 and 2.
 *
 * Three targets, three module systems, and one of them is load-bearing in a way
 * that is invisible until the app is running:
 *
 * **The preload is pinned to CJS.** `package.json` declares `"type": "module"`,
 * and electron-vite reads that to decide the preload's format too — so without
 * the pin below it emits ESM. **Electron will not load an ESM preload in a
 * sandboxed renderer.** There is no error, no warning and no failed require: the
 * script simply never runs, `window.api` comes back `undefined`, and the symptom
 * points squarely at the `contextBridge` call, which is correct. The two-line
 * `output` block below is the whole fix; `sandbox: false` also makes the symptom
 * go away and is not the fix — it turns off the isolation the preload exists to
 * preserve. `src/main/index.ts` points `webPreferences.preload` at the `.cjs`
 * this produces.
 *
 * Everything else is electron-vite's default discovery: `src/main/index.ts`,
 * `src/preload/index.ts` and `src/renderer/index.html` are found by convention,
 * and main is emitted as `out/main/index.mjs` — the path `package.json`'s `main`
 * field names, without which electron-vite throws
 * `No entry point found for electron app`.
 *
 * `esbuild.jsx: "automatic"` on the renderer buys React 19's JSX transform
 * without `@vitejs/plugin-react`. The plugin's contribution is Fast Refresh,
 * which a built app that Playwright launches does not use.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  main: {
    resolve: { alias: { "@shared": r("./src/shared"), "@main": r("./src/main") } },
    build: {
      rollupOptions: {
        input: r("./src/main/index.ts"),
        // `.mjs`, because `package.json`'s `main` field names
        // `./out/main/index.mjs` and Electron resolves that path literally.
        // electron-vite already emits ES here (it reads `"type": "module"`), but
        // it only renames the entry to `.mjs` when the entry is discovered by
        // convention — an explicit `input` keeps rollup's `[name].js` default,
        // and a `main` field pointing at a file that was never written is
        // blocker 1 wearing a different hat.
        output: { entryFileNames: "[name].mjs", chunkFileNames: "[name]-[hash].mjs" },
      },
    },
  },
  preload: {
    resolve: { alias: { "@shared": r("./src/shared") } },
    build: {
      rollupOptions: {
        input: r("./src/preload/index.ts"),
        // Blocker 2. `format` is what Electron actually requires; the extension
        // is what makes the requirement legible at the `webPreferences.preload`
        // path, so a future edit that points at `index.mjs` is obviously wrong.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: r("./src/renderer"),
    resolve: { alias: { "@shared": r("./src/shared") } },
    esbuild: { jsx: "automatic" },
    build: { rollupOptions: { input: r("./src/renderer/index.html") } },
  },
});
