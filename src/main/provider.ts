/**
 * Which model provider this process talks to — spec amendment A15.
 *
 * The single construction site. `main/index.ts` calls this once at startup and
 * hands the result to `registerIpc`; nothing downstream of that knows or can ask
 * which provider it got, because `LlmClient` is the whole contract.
 *
 * It is a module rather than four lines inside `index.ts` because `index.ts`
 * imports `electron` and calls `app.whenReady()` at import time, so it cannot be
 * imported by a test — and the one behaviour here that must not regress is a
 * failure: an unrecognised provider has to stop the app rather than quietly
 * start it against Ollama.
 *
 * `env` is a parameter defaulting to `process.env` for the same reason.
 */

import { createLmStudioClient } from "@main/lmstudio";
import { createOllamaClient, type LlmClient } from "@main/ollama";

/** Every legal value of `SPRITE_MAKER_PROVIDER`, and the order the error lists. */
export const PROVIDERS = ["ollama", "lmstudio"] as const;

export type ProviderName = (typeof PROVIDERS)[number];

/** The default, and the only provider verified against a live server. */
export const DEFAULT_PROVIDER: ProviderName = "ollama";

/**
 * `SPRITE_MAKER_PROVIDER` named something this build does not have.
 *
 * Its own class so the startup path can be asserted on precisely, and so the
 * message can carry the three facts a typo needs: what was asked for, what
 * exists, and which variable to fix. Thrown, never defaulted away — a run that
 * silently used Ollama when the user asked for LM Studio would produce results
 * attributed to the wrong provider, which is the one outcome worse than not
 * starting.
 */
export class UnknownProviderError extends Error {
  override readonly name = "UnknownProviderError";

  constructor(readonly requested: string) {
    super(
      `SPRITE_MAKER_PROVIDER=${JSON.stringify(requested)} is not a provider this app has — ` +
        `expected one of ${PROVIDERS.map((p) => JSON.stringify(p)).join(", ")}`,
    );
  }
}

/**
 * The client this process should use.
 *
 * Unset **and empty** both mean the default: a shell that exports
 * `SPRITE_MAKER_PROVIDER=` has not chosen a provider, and treating that as a
 * typo would make an empty environment variable fatal. Anything else that is not
 * a known name throws.
 *
 * Each provider's base URL comes from its own variable, so switching provider
 * does not silently reuse a port meant for the other one — pointing
 * `OLLAMA_BASE_URL` at LM Studio's 1234 is a mistake the app cannot detect, and
 * separate variables are what keep it from being the default experience.
 */
export function createLlmClient(env: NodeJS.ProcessEnv = process.env): LlmClient {
  const requested = env.SPRITE_MAKER_PROVIDER;
  const name = requested === undefined || requested === "" ? DEFAULT_PROVIDER : requested;

  switch (name) {
    case "ollama":
      return createOllamaClient(env.OLLAMA_BASE_URL);
    case "lmstudio":
      return createLmStudioClient(env.LMSTUDIO_BASE_URL);
    default:
      throw new UnknownProviderError(name);
  }
}
