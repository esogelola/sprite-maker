import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";

// Minimal, valid configuration. Wave 10 wires up the real main / preload /
// renderer entry points; until then there is no Electron application code and
// this file exists only so the toolchain is complete and typechecks.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  main: {
    resolve: { alias: { "@shared": r("./src/shared"), "@main": r("./src/main") } },
  },
  preload: {
    resolve: { alias: { "@shared": r("./src/shared") } },
  },
  renderer: {
    resolve: { alias: { "@shared": r("./src/shared") } },
  },
});
