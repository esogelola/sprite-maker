/**
 * The model residency policy — spec amendment A17.
 *
 * **The problem.** §6.8 binds two roles, and §7.4 alternates between them:
 * `draft(G) → critique(C) → revise(G) → critique(C) → revise(G) → critique(C)`.
 * On the shipped configuration both roles are `qwen3-vl:8b-instruct-q4_K_M`, so
 * that alternation costs nothing. Bind two *different* models — a cobuilder on
 * Linux with LM Studio wanting a "neo" generator and a qwen critic — on a host
 * that cannot hold both, and the same loop swaps models five times a run. Each
 * swap is a cold load: **15.7 s cold against 5.9 s warm**
 * (`captures/2026-07-30-wave-8b-determinism.txt`), so ~10 s per switch and ~50 s
 * across a 3-round run, or a thrash, or an OOM.
 *
 * **Rule zero, and it comes before every heuristic here.** When
 * `models.generator === models.critic` the policy is a **no-op**: no probe, no
 * eviction, no request of any kind, whatever `modelResidency` says. That is the
 * shipped default and the common case, and it must be provably free — the test
 * for it asserts on an *empty request log*, not on a returned value.
 *
 * **What `"auto"` reads, and why it differs per provider.**
 *
 * | | signal | accuracy |
 * |---|---|---|
 * | Ollama | `size` per model from `/api/tags` — 19.6 / 6.1 / 5.2 GB observed | real numbers |
 * | LM Studio | nothing usable: OpenAI's `/v1/models` is `id, object, created, owned_by`, and LM Studio's own `/api/v0/models` carries no size either (lmstudio-js#156) | an assumption, and it says so |
 *
 * So the LM Studio path probes `/api/v0/models` once, with a short budget, reads
 * a size *if a future build reports one*, and otherwise assumes
 * `ASSUMED_MODEL_BYTES` per model — and the reason string says the number is an
 * assumption rather than a measurement. Neither the author nor the user can log
 * into the machine this runs on, so **a heuristic nobody can see is a heuristic
 * nobody can debug**: the decision and the signal behind it cross IPC and are
 * rendered beside the provider row. That is a requirement, not polish.
 *
 * **`os.freemem()` is not used and must never be.** It reported 2.1 GB free of
 * 34.4 GB total on an idle machine, because macOS excludes purgeable and cached
 * pages and Linux excludes the page cache. Keyed off it, every machine would
 * resolve sequential, always, for a reason no user could see.
 * `tests/main/residency.test.ts` greps this file for it.
 *
 * **The zeros.** `0` is a legal value on three of the inputs here and a hazard on
 * each: a headroom factor of `0` means "assume nothing fits" and
 * `factor || DEFAULT` silently restores 0.6; `os.totalmem()` returning `0` must
 * not become a budget of zero that nothing explains; and a reported model `size`
 * of `0` must not read as "this model is free", which is the one wrong answer
 * that causes the OOM this whole amendment exists to prevent. The fourth zero —
 * `keep_alive: 0`, the entire eviction mechanism — lives in `main/ollama.ts`,
 * where the request body is.
 */

import { totalmem } from "node:os";

import { LMSTUDIO_NATIVE_MODELS_PATH } from "@main/lmstudio";
import { OLLAMA_MODELS_PATH, type LlmClient } from "@main/ollama";
import { PROBE_TIMEOUT_MS, describeProbeFailure, type ProviderName } from "@main/provider";
import type { ModelResidency } from "@shared/schema";

// ---------------------------------------------------------------------------
// the constants the heuristic is made of
// ---------------------------------------------------------------------------

/**
 * How much of total RAM the two models' weights may occupy before the app calls
 * them un-co-resident.
 *
 * **A fraction of `totalmem()`, deliberately, because `freemem()` is unusable.**
 * The budget therefore has to leave room for everything the reading cannot see,
 * and the list is long: the runtime's KV cache and compute buffers (which are
 * *not* in the on-disk size and grow with context), Electron and this app, a
 * browser, an editor, and the operating system. 40 % of total for all of that is
 * not generous; it is roughly what a working desktop already uses.
 *
 * Checked against the sizes this project actually has:
 *
 * | machine | pair | budget | verdict |
 * |---|---|---|---|
 * | 16 GiB (17.2 GB) | 6.1 + 5.2 GB | 10.3 GB | **sequential** — 11.4 GB of weights plus cache plus a desktop does not fit |
 * | 32 GiB (34.4 GB) | 6.1 + 5.2 GB | 20.6 GB | **concurrent** — verified live, both resident at once |
 * | 32 GiB | 19.6 + 6.1 GB | 20.6 GB | **sequential** — 25.7 GB of weights on a 34.4 GB machine is not a pair |
 *
 * One number, exported, and the only knob. `resolveResidency` takes an override
 * so the boundary is testable without a second machine.
 */
export const MEMORY_HEADROOM = 0.6;

/**
 * What a model is assumed to weigh when nothing will say — the LM Studio path,
 * and any listing that does not answer.
 *
 * 6 GB because that is what the model this app actually ships weighs:
 * `qwen3-vl:8b-instruct-q4_K_M` is 6.14 GB by Ollama's own reckoning, and an 8B
 * at q4 is the class of model both of this project's providers are used with.
 *
 * It is an assumption and every reason string that rests on it says so. The
 * effect of the pair against `MEMORY_HEADROOM`: a machine under ~20 GB total
 * resolves sequential, and one above it concurrent — which is the right side of
 * the line for the 16 GB host this amendment was written for.
 */
export const ASSUMED_MODEL_BYTES = 6e9;

/**
 * How long an unload may take before the runner stops waiting for it.
 *
 * Deliberately **not** §6.8's `callTimeoutMs`, which is minutes: an unload is a
 * local memory operation that answered instantly in every live probe, and a
 * server that black-holes it must not stall the stage that is waiting to start.
 * Ten seconds is generous for freeing 20 GB and short enough that the failure
 * mode is "the policy did not help", not "the run hung".
 */
export const RELEASE_TIMEOUT_MS = 10_000;

/** The size fields any listing might carry. Ollama uses `size`; see below for LM Studio. */
const SIZE_KEYS = ["size", "size_bytes", "bytes"] as const;

/** How a listing entry names itself: Ollama `name`/`model`, OpenAI and LM Studio `id`. */
const ID_KEYS = ["name", "model", "id"] as const;

// ---------------------------------------------------------------------------
// the decision
// ---------------------------------------------------------------------------

/** What `"auto"` can resolve *to*. `"auto"` is a question, not an answer. */
export type ResidencyPolicy = "sequential" | "concurrent";

export interface ResidencyDecision {
  /** What the config asked for, kept so the surface can say "auto → sequential". */
  configured: ModelResidency;
  policy: ResidencyPolicy;
  /**
   * One sentence naming the **signal**, not merely the verdict.
   *
   * Built from the same values the comparison used, so it cannot drift away from
   * the branch that produced it, and it is what the provider row renders.
   */
  reason: string;
}

export interface ResidencyInput {
  provider: ProviderName;
  baseUrl: string;
  models: { generator: string; critic: string };
  configured: ModelResidency;
}

export interface ResidencyOptions {
  /**
   * Total physical memory. Defaults to `os.totalmem()`.
   *
   * Read with `??`, never `||`: `0` is a value this has to defend against rather
   * than replace, and a truthiness guard would turn "this machine reported
   * nothing" into "this machine has 34 GB".
   */
  totalMemBytes?: number;
  /** Defaults to `MEMORY_HEADROOM`. `??`, because `0` is a legal budget. */
  headroom?: number;
  /** Per-probe budget. Defaults to `PROBE_TIMEOUT_MS`. `??`, because `0` is legal. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// reading sizes off a listing
// ---------------------------------------------------------------------------

/** Two sizes and an account of where they came from — or did not. */
interface SizeReading {
  generator: number | null;
  critic: number | null;
  /** Either the endpoint that supplied them, or the reason it did not. */
  source: string;
}

/**
 * A model's size in bytes, or `null` when the entry does not carry a usable one.
 *
 * **`> 0`, and the boundary is a decision.** Ollama reports `size: 405` for
 * `deepseek-v3.1:671b-cloud` — a cloud pointer that occupies no local memory —
 * so a *small* size is a real measurement and is honoured as one. `0` is not a
 * size any local model has ever carried, and reading it as "this model is free"
 * is the single wrong answer that produces the OOM this amendment exists to
 * prevent. So `0` is treated as **absent**, the caller falls back to the assumed
 * size, and the reason string names the model it could not measure. That is an
 * explicit branch with a visible consequence, not a falsy value quietly dropped.
 */
function readSize(entry: unknown): number | null {
  if (entry === null || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  for (const key of SIZE_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function identifies(entry: unknown, model: string): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  return ID_KEYS.some((key) => record[key] === model);
}

/**
 * One bounded GET, and the array under `key`.
 *
 * Throws on anything that is not a 2xx carrying JSON — the caller turns every
 * throw into "sizes unavailable, here is why", because a listing that did not
 * answer is a reason to assume rather than a reason to fail. Nothing here can
 * take down a run: `resolveResidency` is called before a stage, not inside one.
 */
async function fetchEntries(endpoint: string, key: string, timeoutMs: number): Promise<unknown[]> {
  const response = await fetch(endpoint, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    // Cancelled rather than read: the status is the whole of the answer, and an
    // unread body holds the pooled connection open past our interest in it.
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (payload === null || typeof payload !== "object") return [];
  const entries = (payload as Record<string, unknown>)[key];
  return Array.isArray(entries) ? entries : [];
}

/** Both bound models' sizes off one listing, with a sentence for each miss. */
async function readSizes(
  endpoint: string,
  key: string,
  label: string,
  models: { generator: string; critic: string },
  timeoutMs: number,
): Promise<SizeReading> {
  let entries: unknown[];
  try {
    entries = await fetchEntries(endpoint, key, timeoutMs);
  } catch (error) {
    return {
      generator: null,
      critic: null,
      source: `${label} did not answer (${describeProbeFailure(error, timeoutMs)})`,
    };
  }

  const look = (model: string): { size: number | null; miss: string | null } => {
    const entry = entries.find((candidate) => identifies(candidate, model));
    if (entry === undefined) return { size: null, miss: `${label} does not list ${model}` };
    const size = readSize(entry);
    if (size === null) return { size: null, miss: `${label} reports no size for ${model}` };
    return { size, miss: null };
  };

  const generator = look(models.generator);
  const critic = look(models.critic);
  const misses = [generator.miss, critic.miss].filter((miss): miss is string => miss !== null);

  return {
    generator: generator.size,
    critic: critic.size,
    source: misses.length === 0 ? label : misses.join("; "),
  };
}

// ---------------------------------------------------------------------------
// wording
// ---------------------------------------------------------------------------

/** `6.1 GB`. GB as 10⁹, which is how both `ollama list` and this project count. */
function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * What a user of this provider can actually do about a sequential verdict.
 *
 * Ollama needs nothing said: `keep_alive: 0` works and this app sends it. LM
 * Studio's unload endpoint is documented but unverified and absent from older
 * builds, so the durable answer is the host app's own setting — and telling
 * someone that once, in the row, is worth more than a paragraph in a README they
 * have no reason to open.
 */
function sequentialRemedy(provider: ProviderName): string {
  return provider === "lmstudio"
    ? " — this app asks LM Studio to unload, but if that endpoint is absent set " +
        "Developer ▸ Max loaded models to 1 so its own JIT auto-evict does the same job"
    : "";
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/**
 * Which residency policy this run should use, and why — amendment A17.
 *
 * Never throws and never fails a run: every unreachable server, 404 and timeout
 * becomes an assumption with a sentence attached. The order below is the whole
 * of the control flow, and each step's cost is the point:
 *
 * 1. **One model in both roles** → `concurrent`, **zero requests**.
 * 2. **An explicit policy** → that policy, **zero requests**. The user answered
 *    the question; re-asking it over the network would attribute a run to a
 *    decision they did not make, which is the rule `detectProvider` applies to an
 *    explicit `SPRITE_MAKER_PROVIDER`.
 * 3. **`"auto"`** → one bounded listing call, then arithmetic.
 */
export async function resolveResidency(
  input: ResidencyInput,
  options: ResidencyOptions = {},
): Promise<ResidencyDecision> {
  const { configured, models, provider } = input;

  // 1. Rule zero. Before the configured policy, not after it: unloading a model
  //    you are about to load again is pure loss, and the ~10 s it costs is the
  //    thing this amendment exists to avoid paying when it is not needed.
  if (models.generator === models.critic) {
    return {
      configured,
      policy: "concurrent",
      reason:
        `generator and critic are both ${models.generator} — one model serves both roles, ` +
        "so there is nothing to unload and nothing to reload",
    };
  }

  // 2.
  if (configured === "sequential") {
    return {
      configured,
      policy: "sequential",
      reason:
        `sequential is set in the config, so ${models.generator} and ${models.critic} are ` +
        `never resident together${sequentialRemedy(provider)}`,
    };
  }
  if (configured === "concurrent") {
    return {
      configured,
      policy: "concurrent",
      reason:
        `concurrent is set in the config, so ${models.generator} and ${models.critic} both ` +
        "stay resident",
    };
  }

  // 3. `??` on all three: `0` is a legal value for each and a truthiness guard
  //    would replace the strictest possible setting with the default.
  const total = options.totalMemBytes ?? totalmem();
  const headroom = options.headroom ?? MEMORY_HEADROOM;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  // Defend, do not divide. A budget derived from a total of zero would be zero,
  // which resolves sequential for a reason that reads as a measurement.
  if (!Number.isFinite(total) || total <= 0) {
    return {
      configured,
      policy: "sequential",
      reason:
        `os.totalmem() reported ${String(total)} bytes, so no memory budget can be computed — ` +
        `assuming ${models.generator} and ${models.critic} do not fit together` +
        sequentialRemedy(provider),
    };
  }

  const budget = total * headroom;
  const percent = Math.round(headroom * 100);

  const reading =
    provider === "ollama"
      ? await readSizes(
          `${input.baseUrl}${OLLAMA_MODELS_PATH}`,
          "models",
          `Ollama ${OLLAMA_MODELS_PATH}`,
          models,
          timeoutMs,
        )
      : await readSizes(
          `${input.baseUrl}${LMSTUDIO_NATIVE_MODELS_PATH}`,
          "data",
          `LM Studio ${LMSTUDIO_NATIVE_MODELS_PATH}`,
          models,
          timeoutMs,
        );

  // Destructured, and each branch re-tests both fields rather than reusing a
  // `measured` boolean: a boolean does not narrow `number | null`, and the
  // narrowing is what keeps `gb()` from being handed a null it would print.
  const { generator: genBytes, critic: criticBytes, source } = reading;
  const combined =
    genBytes !== null && criticBytes !== null
      ? genBytes + criticBytes
      : ASSUMED_MODEL_BYTES + ASSUMED_MODEL_BYTES;

  // `>`, never `>=`: the budget is a maximum — "at most this much" — the same
  // convention `reviseRegression` uses for every bar it compares against, so a
  // pair that exactly fills the budget fits inside it.
  const policy: ResidencyPolicy = combined > budget ? "sequential" : "concurrent";
  const verb = policy === "sequential" ? "exceeds" : "fits within";
  const machine = `${percent}% of this machine's ${gb(total)}`;

  const reason =
    genBytes !== null && criticBytes !== null
      ? `${models.generator} ${gb(genBytes)} + ${models.critic} ` +
        `${gb(criticBytes)} = ${gb(combined)}, which ${verb} the ${gb(budget)} budget ` +
        `(${machine}, sizes from ${source})`
      : `model sizes are unavailable (${source}), so this assumes ` +
        `${gb(ASSUMED_MODEL_BYTES)} per model: ${gb(combined)} ${verb} the ${gb(budget)} ` +
        `budget (${machine})`;

  return {
    configured,
    policy,
    reason: policy === "sequential" ? `${reason}${sequentialRemedy(provider)}` : reason,
  };
}

// ---------------------------------------------------------------------------
// the runner — who gets evicted, and when
// ---------------------------------------------------------------------------

/**
 * Tracks which model is resident and evicts the previous one on a switch.
 *
 * One instance per run, held on `PipelineDeps`. Three properties, and each one
 * is a mutation that leaves every other test green:
 *
 * - **The model evicted is the one being *left*, never the one being entered.**
 *   The call count is identical either way, and the wrong version pays the exact
 *   cold load it was trying to avoid.
 * - **Only on an actual change.** Entering the model already resident issues
 *   nothing, which is what makes rule zero true at this layer as well as at the
 *   decision layer — a run with one model in both roles never gets here with a
 *   different model to unload.
 * - **Only under `sequential`.** Under `concurrent` this is bookkeeping.
 *
 * A failed eviction is **not fatal**. The model stays resident, which is the
 * situation the policy was trying to improve rather than a reason to throw away
 * a multi-minute run — so it is logged once and the run continues.
 */
export interface ResidencyRunner {
  readonly decision: ResidencyDecision;
  /** Call immediately before a stage that will use `model`. Never throws. */
  enter(model: string): Promise<void>;
}

export function createResidencyRunner(
  decision: ResidencyDecision,
  client: LlmClient,
): ResidencyRunner {
  let resident: string | null = null;
  let warned = false;

  return {
    decision,

    async enter(model: string): Promise<void> {
      const outgoing = resident;
      // Assigned before the release, so a failed unload still leaves the tracker
      // describing what the run is about to do rather than what it hoped to.
      resident = model;

      if (decision.policy !== "sequential") return;
      // Nothing resident yet (the first stage), or the same model twice.
      if (outgoing === null || outgoing === model) return;
      // A typed absence — a provider that cannot evict, rather than one whose
      // eviction quietly does nothing.
      if (client.release === undefined) return;

      try {
        await client.release(outgoing, AbortSignal.timeout(RELEASE_TIMEOUT_MS));
      } catch (error) {
        if (warned) return;
        warned = true;
        console.warn(
          `[sprite-maker] could not unload ${outgoing} before switching to ${model}: ` +
            `${error instanceof Error ? error.message : String(error)}. The run continues with ` +
            "both models resident; further unload failures from this run are suppressed.",
        );
      }
    },
  };
}
