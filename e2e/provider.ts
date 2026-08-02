/**
 * Which model server the e2e specs talk to — spec amendment A16.
 *
 * Until A16 every spec here opened with the same line:
 *
 * ```ts
 * const ollama = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
 * ```
 *
 * and then POSTed Ollama's native `/api/generate` to warm the model. On the
 * machine these tests were written on that is correct. On the machine of the
 * person the LM Studio provider was written *for* it is wrong twice: the URL is
 * a port nothing is listening on, and the endpoint does not exist. The failure
 * arrives as *"could not reach Ollama"* from a test suite whose whole purpose is
 * to tell them whether their environment works — so the one instrument they have
 * reports on an environment neither of us is in.
 *
 * This module resolves the provider **the same way the app does**, by calling
 * `detectProvider` — the same function, not a copy of its rules — and then
 * speaks to whatever it found through `LlmClient`, which is the interface that
 * makes the two providers interchangeable in the first place. A spec that warms
 * a model through this helper warms it wherever the app is about to look.
 *
 * **The preflight is the honest part.** Warming a model that the resolved
 * provider does not have is a no-op nobody notices: the run then fails on its
 * first model call, minutes later, as a 404 attributed to the pipeline. So
 * `warmModel` asserts the model is installed *there* and, when it is not, says
 * which provider was resolved, at which URL, and what that server does have.
 */

import { expect } from "@playwright/test";

import { clientFor, detectProvider, type ProviderName } from "@main/provider";
import type { LlmClient } from "@main/ollama";

export interface ResolvedProvider {
  provider: ProviderName;
  baseUrl: string;
  /** `configured` / `detected` / `fallback` — printed into every capture. */
  source: string;
  /** Speaks to whichever provider was resolved. */
  client: LlmClient;
}

/**
 * The provider these specs should use.
 *
 * `process.env` is the same environment `electron.launch` hands the app (that is
 * Playwright's default), so this resolves to the same answer the app will —
 * including an explicit `SPRITE_MAKER_PROVIDER`, which short-circuits detection
 * at both ends.
 */
export async function resolveProvider(): Promise<ResolvedProvider> {
  const resolution = await detectProvider(process.env);
  expect(
    resolution.error,
    `no model server was found for the e2e suite. ${resolution.error ?? ""}`,
  ).toBeNull();
  return {
    provider: resolution.provider,
    baseUrl: resolution.baseUrl,
    source: resolution.source,
    client: clientFor(resolution.provider, resolution.baseUrl),
  };
}

/**
 * Load `model` into whichever provider is running, before the app starts.
 *
 * Fixture setup, not the thing under test. §6.8 scales `callTimeoutMs` by canvas
 * area above a floor (A12), so a 16×16 draft gets 45s — and a generator the
 * server has evicted spends all of that being loaded back into memory rather
 * than generating, which is how a run ends with `rounds: []` and nothing to
 * capture.
 *
 * Run **before** `electron.launch` rather than between launch and Generate: a
 * model load is minutes of heavy memory pressure, and holding an idle Electron
 * app open across it cost `boot.spec.ts` its renderer once already.
 *
 * `client.generate` rather than a hand-written POST, because the two providers
 * do not share a generate endpoint and this file should not be the third place
 * that fact is written down.
 */
export async function warmModel(model: string): Promise<ResolvedProvider> {
  const resolved = await resolveProvider();

  const installed = await resolved.client.listModels().catch((error: unknown) => {
    throw new Error(
      `could not list models on ${resolved.provider} at ${resolved.baseUrl}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  });

  // The assertion that keeps the warm-up from being a no-op — and the one that
  // tells a cobuilder their default binding is an Ollama tag on an LM Studio
  // server, which is A16's stale-binding case arriving through the test suite.
  expect(
    installed,
    `${resolved.provider} at ${resolved.baseUrl} does not have '${model}'. ` +
      `It has: ${installed.join(", ") || "(nothing)"}. Either install it there, or bind a ` +
      "model this server has from the app's model pickers.",
  ).toContain(model);

  await resolved.client.generate({
    model,
    prompt: "hi",
    think: false,
    options: { num_predict: 1 },
  });

  return resolved;
}
