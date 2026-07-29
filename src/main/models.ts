/**
 * The model registry — spec §5.2, §6.8, plan Wave 5 task 5.6.
 *
 * Three methods, backing §8's role pickers. `list()` enumerates what Ollama has
 * installed, `roles()` reports the current bindings, and `bind()` changes one.
 *
 * **`bind()` writes through to the live `HarnessConfig`.** That is the whole
 * design, and the alternative — registry-local state that the pipeline reads
 * through some later synchronisation — fails twice over: the run keeps calling
 * the old model, *and* the config serialized into `SessionHistory` names a model
 * the run never used. §6.8 records that config for exactly one reason, so two
 * benchmark runs can be compared, and a config that describes a different run
 * than the one it is attached to is worse than no config at all.
 *
 * **`bind()` replaces `cfg.models` with a spread, never decorates it.** Wave 2d
 * made `ModelsSchema` strict, so an extra key does not get dropped — it throws,
 * at the *next* `HarnessConfigSchema.parse`. That parse is `run()`'s entry
 * check, which happens one user action after the picker that caused it, with
 * nothing in the message to connect the two. The role is validated at runtime
 * and not merely by type, because the pickers reach this through IPC, where
 * TypeScript's guarantee has already been spent.
 */

import type { OllamaClient } from "@main/ollama";
import type { HarnessConfig } from "@shared/schema";

/** The roles §6.8's `models` object defines. Not open for extension here. */
export const MODEL_ROLES = ["generator", "critic"] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export interface ModelRegistry {
  /** Every model Ollama currently has installed, via `/api/tags`. */
  list(): Promise<string[]>;
  /** The current role bindings — a copy, so `bind` stays the only write path. */
  roles(): HarnessConfig["models"];
  /** Rebind one role, writing through to the config a subsequent `run` receives. */
  bind(role: ModelRole, model: string): void;
}

export function createModelRegistry(client: OllamaClient, cfg: HarnessConfig): ModelRegistry {
  return {
    // Delegated, never cached: §9 has the pickers list only installed models,
    // and a cached first answer keeps a freshly pulled model invisible until
    // restart.
    list: () => client.listModels(),

    roles: () => ({ ...cfg.models }),

    bind(role: ModelRole, model: string): void {
      if (!MODEL_ROLES.includes(role)) {
        throw new RangeError(
          `unknown model role ${JSON.stringify(role)} — expected one of ` +
            `${MODEL_ROLES.map((r) => `'${r}'`).join(", ")}`,
        );
      }
      if (typeof model !== "string" || model.trim().length === 0) {
        // `ModelsSchema` requires `min(1)`, so an empty binding would otherwise
        // pass here and throw at `run()`'s re-parse. Whitespace is rejected too:
        // it satisfies the schema and 404s at Ollama.
        throw new RangeError(
          `model bound to '${role}' must be a non-empty name, got ${JSON.stringify(model)}`,
        );
      }

      // Spread then assign one known key. Nothing here can introduce a key
      // `ModelsSchema` would reject, and replacing the object rather than
      // mutating it in place means a `models` reference captured elsewhere
      // cannot be edited from behind.
      const next = { ...cfg.models };
      next[role] = model;
      cfg.models = next;
    },
  };
}
