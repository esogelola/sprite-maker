/**
 * `main/models.ts` — spec §6.8, plan Wave 5 task 5.5.
 *
 * The registry has three methods and only one of them is interesting. `list()`
 * delegates and `roles()` reads, but **`bind()` writes through to the live
 * `HarnessConfig`**, and there are two ways to get that wrong that a naive test
 * cannot tell apart from success:
 *
 * 1. Writing to registry-local state. `roles()` then reports the new model, the
 *    picker looks right, and the pipeline goes on calling the old one — while
 *    the config serialized into `SessionHistory` names a model the run never
 *    used, which defeats the entire reason §6.8 records it. Every assertion here
 *    is therefore against `cfg`, not against `roles()`.
 * 2. Decorating `cfg.models` with a key that is not `generator` or `critic`.
 *    Wave 2d made `ModelsSchema` strict, so the damage does not appear at the
 *    call site — it appears at the *next* `HarnessConfigSchema.parse`, which is
 *    `run()`'s entry check, one user action later.
 */

import { describe, expect, it } from "vitest";

import { createModelRegistry, MODEL_ROLES } from "@main/models";
import { DEFAULT_HARNESS_CONFIG, HarnessConfigSchema } from "@shared/schema";
import type { HarnessConfig } from "@shared/schema";

import { createStubClient } from "../stubs/ollama";

/** A fresh, schema-valid config — the object a real `run()` would be handed. */
function config(): HarnessConfig {
  return HarnessConfigSchema.parse({});
}

describe("createModelRegistry — roles", () => {
  it("reports the config's default bindings", () => {
    const cfg = config();
    const registry = createModelRegistry(createStubClient({}), cfg);

    expect(registry.roles()).toEqual({
      generator: "qwen3:8b",
      critic: "qwen3-vl:8b-instruct-q4_K_M",
    });
  });

  it("reports an overridden binding rather than the schema default", () => {
    const cfg = HarnessConfigSchema.parse({ models: { generator: "qwen3:4b", critic: "c" } });
    const registry = createModelRegistry(createStubClient({}), cfg);

    expect(registry.roles()).toEqual({ generator: "qwen3:4b", critic: "c" });
  });

  it("reads the config live, so a bind made elsewhere is visible", () => {
    const cfg = config();
    const registry = createModelRegistry(createStubClient({}), cfg);

    cfg.models = { ...cfg.models, generator: "qwen3:4b" };

    expect(registry.roles().generator).toBe("qwen3:4b");
  });

  it("hands back a copy, so bind() stays the only write path", () => {
    const cfg = config();
    const registry = createModelRegistry(createStubClient({}), cfg);

    registry.roles().critic = "smuggled-in";

    expect(cfg.models.critic).toBe("qwen3-vl:8b-instruct-q4_K_M");
  });

  it("names exactly the two roles §6.8 defines", () => {
    expect([...MODEL_ROLES]).toEqual(["generator", "critic"]);
  });
});

describe("createModelRegistry — bind", () => {
  it("writes through to the live HarnessConfig the pipeline will receive", () => {
    // Wave 5 acceptance criterion 4. Asserted on `cfg` and not on `roles()`,
    // because a registry-local write satisfies `roles()` and nothing else.
    const cfg = config();
    createModelRegistry(createStubClient({}), cfg).bind(
      "critic",
      "qwen3-vl:30b-a3b-instruct-q4_K_M",
    );

    expect(cfg.models.critic).toBe("qwen3-vl:30b-a3b-instruct-q4_K_M");
  });

  it("binds the generator without disturbing the critic", () => {
    const cfg = config();
    createModelRegistry(createStubClient({}), cfg).bind("generator", "qwen3:4b");

    expect(cfg.models).toEqual({
      generator: "qwen3:4b",
      critic: "qwen3-vl:8b-instruct-q4_K_M",
    });
  });

  it("leaves the rest of the config untouched", () => {
    const cfg = config();
    createModelRegistry(createStubClient({}), cfg).bind("critic", "c");

    expect({ ...cfg, models: undefined }).toEqual({ ...DEFAULT_HARNESS_CONFIG, models: undefined });
  });

  it("leaves the config parseable by the strict schema", () => {
    // The failure this catches is silent at the call site: a decorated
    // `cfg.models` throws at `run()`'s entry re-parse, one user action later and
    // nowhere near the picker that caused it.
    const cfg = config();
    createModelRegistry(createStubClient({}), cfg).bind("critic", "qwen3-vl:32b");

    const reparsed = HarnessConfigSchema.parse(cfg);
    expect(reparsed.models).toEqual({ generator: "qwen3:8b", critic: "qwen3-vl:32b" });
  });

  it("replaces the models object rather than editing it in place", () => {
    // The plan pins the spread for a reason beyond avoiding a stray key: a
    // `models` reference taken by someone else — a history snapshot built with
    // `{ ...cfg }`, which shares the nested object — must not be editable from
    // behind by a later picker click. Replacing the reference means yesterday's
    // snapshot still describes yesterday's run.
    const cfg = config();
    const before = cfg.models;

    createModelRegistry(createStubClient({}), cfg).bind("critic", "qwen3-vl:32b");

    expect(cfg.models).not.toBe(before);
    expect(before.critic).toBe("qwen3-vl:8b-instruct-q4_K_M");
  });

  it("adds no key to models beyond the two the schema admits", () => {
    const cfg = config();
    const registry = createModelRegistry(createStubClient({}), cfg);
    registry.bind("critic", "a");
    registry.bind("generator", "b");

    expect(Object.keys(cfg.models).sort()).toEqual(["critic", "generator"]);
  });

  it("survives repeated binds of the same role", () => {
    const cfg = config();
    const registry = createModelRegistry(createStubClient({}), cfg);
    registry.bind("critic", "one");
    registry.bind("critic", "two");
    registry.bind("critic", "three");

    expect(cfg.models.critic).toBe("three");
    expect(HarnessConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it("does not leak into a config parsed separately", () => {
    const mine = config();
    const theirs = config();
    createModelRegistry(createStubClient({}), mine).bind("critic", "mine-only");

    expect(theirs.models.critic).toBe("qwen3-vl:8b-instruct-q4_K_M");
  });

  it("does not poison DEFAULT_HARNESS_CONFIG", () => {
    const cfg = config();
    createModelRegistry(createStubClient({}), cfg).bind("generator", "not-the-default");

    expect(DEFAULT_HARNESS_CONFIG.models).toEqual({
      generator: "qwen3:8b",
      critic: "qwen3-vl:8b-instruct-q4_K_M",
    });
  });

  it("rejects an unknown role rather than decorating the config", () => {
    // Reachable from IPC, where the role arrives as untrusted data and
    // TypeScript's guarantee has already been spent.
    const cfg = config();
    const registry = createModelRegistry(createStubClient({}), cfg);

    expect(() => registry.bind("judge" as never, "m")).toThrow(RangeError);
    expect(Object.keys(cfg.models).sort()).toEqual(["critic", "generator"]);
  });

  it("rejects an empty model name", () => {
    // `ModelsSchema` requires `min(1)`, so an empty binding would sail through
    // `bind` and throw at the next parse instead.
    const registry = createModelRegistry(createStubClient({}), config());
    expect(() => registry.bind("critic", "")).toThrow(RangeError);
  });

  it("rejects a whitespace-only model name", () => {
    const registry = createModelRegistry(createStubClient({}), config());
    expect(() => registry.bind("critic", "   ")).toThrow(RangeError);
  });

  it("leaves the previous binding in place when it rejects", () => {
    const cfg = config();
    const registry = createModelRegistry(createStubClient({}), cfg);
    expect(() => registry.bind("critic", "")).toThrow(RangeError);
    expect(cfg.models.critic).toBe("qwen3-vl:8b-instruct-q4_K_M");
  });
});

describe("createModelRegistry — list", () => {
  it("delegates to the client", async () => {
    const stub = createStubClient({ models: ["qwen3:8b", "llama3.2:latest"] });
    const registry = createModelRegistry(stub, config());

    expect(await registry.list()).toEqual(["qwen3:8b", "llama3.2:latest"]);
    expect(stub.calls).toEqual([{ method: "listModels", model: "" }]);
  });

  it("does not cache — a model pulled mid-session shows up", async () => {
    // §9 has the pickers list only installed models; a cached first answer would
    // keep a freshly pulled model invisible until restart.
    let installed = ["qwen3:8b"];
    const registry = createModelRegistry(
      { ...createStubClient({}), listModels: async () => [...installed] },
      config(),
    );

    expect(await registry.list()).toEqual(["qwen3:8b"]);
    installed = ["qwen3:8b", "qwen3-vl:32b"];
    expect(await registry.list()).toEqual(["qwen3:8b", "qwen3-vl:32b"]);
  });

  it("propagates an unreachable client rather than reporting no models", async () => {
    const stub = createStubClient({ models: new Error("boom") });
    const registry = createModelRegistry(stub, config());

    await expect(registry.list()).rejects.toThrow("boom");
  });
});
