/**
 * Playwright — plan Wave 10.
 *
 * Playwright moves here from Wave 11 because Wave 10's own evidence requirement
 * is a screenshot of a real generation, and an implementer has no other way to
 * take one.
 *
 * **`_electron.launch()` attaches to a BUILT app, not a dev server.** Every spec
 * under `e2e/` therefore requires `npm run build` to have run first; there is no
 * `webServer` block to start one, because there is no server.
 *
 * The timeouts are the interesting part. A real `qwen3:8b` draft followed by up
 * to three `qwen3-vl` critiques and as many bounded revise loops is measured in
 * **minutes** (spec §12), so a default 30-second test timeout would report a
 * working pipeline as a hang. `expect` keeps a much shorter default, because a
 * *UI* assertion that takes 30 seconds really is broken — the long waits are
 * spelled out at their call sites instead.
 *
 * `outputDir` goes under `out/`, which `.gitignore` already covers: traces and
 * failure screenshots are debris, and the one artifact worth committing is
 * written deliberately to `docs/superpowers/specs/screenshots/`.
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  /** A live draft-and-critique loop against local models. See the header. */
  timeout: 20 * 60 * 1000,
  expect: { timeout: 30 * 1000 },
  /** One Electron app and one Ollama at a time — both are exclusive resources. */
  workers: 1,
  fullyParallel: false,
  /** A flaky live model is a finding, not something to paper over with a retry. */
  retries: 0,
  reporter: [["list"]],
  outputDir: "./out/playwright",
});
