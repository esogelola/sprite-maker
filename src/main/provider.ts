/**
 * Which model provider this process talks to — spec amendments A15 and A16.
 *
 * The single construction site. `main/index.ts` resolves the provider once at
 * startup and hands a `ProviderControl` to `registerIpc`; nothing downstream of
 * that knows which implementation it got, because `LlmClient` is the whole
 * contract.
 *
 * It is a module rather than a few lines inside `index.ts` because `index.ts`
 * imports `electron` and calls `app.whenReady()` at import time, so it cannot be
 * imported by a test — and the two behaviours here that must not regress are
 * failures: an unrecognised provider has to stop the app rather than quietly
 * start it against Ollama, and a *detection* failure has to do the opposite.
 *
 * `env` is a parameter defaulting to `process.env` for the same reason.
 *
 * **A16 — the app looks for a server before it assumes one.** A15 shipped LM
 * Studio behind `SPRITE_MAKER_PROVIDER=lmstudio`, which for the person the
 * provider was written for is the same class of workaround they were already
 * applying by hand. `detectProvider` probes both listing endpoints and picks
 * what is actually running, so a clone and `npm run dev` finds the server on the
 * machine it is running on.
 *
 * Four properties of that sweep are load-bearing, and each is a defect if it
 * flips:
 *
 * **1. An explicit `SPRITE_MAKER_PROVIDER` probes nothing.** Someone who typed
 * the variable has already answered the question, and detection that overrode
 * them would attribute a run to a provider they did not choose.
 *
 * **2. The probes are concurrent and each is bounded.** A refused connection
 * comes back instantly, which is what makes a serial, unbounded sweep look
 * correct on the machine it was written on. A firewalled port that black-holes
 * packets never comes back at all — and a startup that waits for it is a blank
 * window whose symptom points at Electron rather than at networking.
 * `PROBE_TIMEOUT_MS` is a budget of its own and deliberately nowhere near
 * §6.8's model-call timeout, which is measured in minutes.
 *
 * **3. Ollama wins when both answer.** Every capture in this project was
 * measured against Ollama; silently switching on a machine that happens to run
 * both would invalidate the comparison and leave every test green. The
 * preference is `PROVIDERS`' own order, so it cannot drift away from the order
 * the errors report.
 *
 * **4. Finding nothing is not fatal.** It falls back to the default provider,
 * records the whole diagnostic on `error`, and lets the app boot — because the
 * fix is a provider row in a window that must therefore exist. This is the exact
 * opposite of an unknown `SPRITE_MAKER_PROVIDER`, which stays a hard exit: a
 * typo in a variable cannot be corrected from inside an app that started against
 * the wrong server.
 */

import {
  createLmStudioClient,
  DEFAULT_LMSTUDIO_BASE_URL,
  LMSTUDIO_MODELS_PATH,
} from "@main/lmstudio";
import {
  createOllamaClient,
  DEFAULT_OLLAMA_BASE_URL,
  OLLAMA_MODELS_PATH,
  type LlmClient,
} from "@main/ollama";

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
  const provider = namedProvider(env) ?? DEFAULT_PROVIDER;
  return clientFor(provider, baseUrlFor(provider, env));
}

// ---------------------------------------------------------------------------
// base URLs and clients — the two things a provider name resolves to
// ---------------------------------------------------------------------------

/** Each provider's documented default, and the URL detection probes for it. */
const DEFAULT_BASE_URLS: Record<ProviderName, string> = {
  ollama: DEFAULT_OLLAMA_BASE_URL,
  lmstudio: DEFAULT_LMSTUDIO_BASE_URL,
};

/** The listing path each client already uses, reused as the probe (A16). */
const MODELS_PATHS: Record<ProviderName, string> = {
  ollama: OLLAMA_MODELS_PATH,
  lmstudio: LMSTUDIO_MODELS_PATH,
};

/** Which variable carries each provider's base URL. Named in the failure text. */
export const BASE_URL_VARS: Record<ProviderName, string> = {
  ollama: "OLLAMA_BASE_URL",
  lmstudio: "LMSTUDIO_BASE_URL",
};

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * A supplied base URL, or `null` when there is nothing there.
 *
 * **`""` is absent, not a URL.** A shell that exports `LMSTUDIO_BASE_URL=`
 * has not chosen a host, and passing the empty string through produces the
 * endpoint `"/v1/models"` — which `fetch` rejects as an invalid URL, so the
 * provider would be reported down for a reason that has nothing to do with the
 * user's server and the message would name an endpoint that is not one. The
 * same is true of a value that is only whitespace, which is what a copy-paste
 * out of a document leaves behind.
 *
 * Trailing slashes go, and nothing else does: a hostname, an IPv6 literal or a
 * LAN address is a choice, not a mistake to correct (see
 * `DEFAULT_LMSTUDIO_BASE_URL`).
 */
export function normalizeBaseUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/\/+$/, "");
}

/** The base URL for a provider: the environment's, or the documented default. */
export function baseUrlFor(provider: ProviderName, env: NodeJS.ProcessEnv): string {
  return normalizeBaseUrl(env[BASE_URL_VARS[provider]]) ?? DEFAULT_BASE_URLS[provider];
}

/** Where a provider is probed and listed. */
export function modelsEndpoint(provider: ProviderName, baseUrl: string): string {
  return `${baseUrl}${MODELS_PATHS[provider]}`;
}

/**
 * The client for one provider at one URL — the only `new client` in the app.
 *
 * Separate from `createLlmClient` because A16 constructs clients from a
 * *resolution* rather than from the environment: the environment is read once,
 * and after that the provider can change at runtime.
 */
export function clientFor(provider: ProviderName, baseUrl: string): LlmClient {
  switch (provider) {
    case "ollama":
      return createOllamaClient(baseUrl);
    case "lmstudio":
      return createLmStudioClient(baseUrl);
    default:
      // Unreachable through the type, and reachable through IPC — `setProvider`
      // validates before it gets here, and this is what catches the day it stops.
      throw new UnknownProviderError(String(provider));
  }
}

/**
 * `SPRITE_MAKER_PROVIDER` as a provider name, or `null` when it is not set.
 *
 * Unset **and empty** both mean "not set": a shell that exports
 * `SPRITE_MAKER_PROVIDER=` has not chosen a provider, and treating that as a
 * typo would make an empty environment variable fatal. Anything else that is not
 * a known name throws — including `" ollama"`, because normalising a near miss
 * teaches that the variable is fuzzy and the next value silently accepted will
 * be one that matters.
 */
function namedProvider(env: NodeJS.ProcessEnv): ProviderName | null {
  const requested = env.SPRITE_MAKER_PROVIDER;
  if (requested === undefined || requested === "") return null;
  if (!isProviderName(requested)) throw new UnknownProviderError(requested);
  return requested;
}

// ---------------------------------------------------------------------------
// detection — amendment A16
// ---------------------------------------------------------------------------

/**
 * How long one probe may take.
 *
 * 1.5s is generous for a loopback listing call — the measured local round trip
 * is single-digit milliseconds — and short enough that a black-holed port costs
 * a noticeable pause rather than a hang. It is deliberately **not** §6.8's
 * `callTimeoutMs`, which is minutes: reusing that number would turn a firewalled
 * port into a multi-minute blank window, which is the failure this whole
 * mechanism exists to avoid.
 *
 * Both probes run concurrently, so this is the cost of the whole sweep and not
 * the cost per provider.
 */
export const PROBE_TIMEOUT_MS = 1500;

/** What one candidate looked like when it was asked. */
export interface ProbeResult {
  provider: ProviderName;
  baseUrl: string;
  /** The exact URL requested — the half of the diagnostic a user can act on. */
  endpoint: string;
  up: boolean;
  /** Why not (`ECONNREFUSED`, `timed out after 1500ms`, `HTTP 404`), or `null`. */
  detail: string | null;
}

/**
 * How this process arrived at its provider.
 *
 * `"fallback"` is not a third provider — it is `"detected"` having found
 * nothing, kept the default, and written down why. It exists as its own value so
 * the status line can say *"nothing answered"* rather than claiming to have
 * detected Ollama at a port where Ollama is not running.
 */
export type ProviderSource = "configured" | "detected" | "fallback";

export interface ProviderResolution {
  provider: ProviderName;
  baseUrl: string;
  source: ProviderSource;
  /** One entry per candidate in `PROVIDERS` order. Empty when configured. */
  probes: readonly ProbeResult[];
  /** The whole diagnostic when nothing answered, else `null`. Never thrown. */
  error: string | null;
}

export interface DetectOptions {
  /**
   * Per-probe budget in milliseconds. Defaults to `PROBE_TIMEOUT_MS`.
   *
   * Read with `??`, never `||`: `0` is a legal budget — "do not wait" — and a
   * truthiness guard silently restores 1.5 seconds, which makes every timing
   * assertion in `tests/main/detect.test.ts` pass for the wrong reason.
   */
  timeoutMs?: number;
}

/**
 * Ask one candidate whether it is there.
 *
 * Never throws. A refused socket, an unparseable URL and a DNS failure all reject
 * from `fetch`, and any of them escaping would take the startup path down with
 * it — so every outcome becomes a `ProbeResult` and the sweep continues.
 *
 * `response.ok` is the whole test. Nothing is parsed: the two providers are
 * distinguished by *which path answers*, and a client that misread the envelope
 * would be a bug in the client rather than a reason to call the server absent.
 */
async function probeCandidate(
  provider: ProviderName,
  baseUrl: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const endpoint = modelsEndpoint(provider, baseUrl);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    try {
      // Discarded rather than read: the sweep wants the status line, and an
      // unread body holds the pooled connection open past the process's interest
      // in it.
      await response.body?.cancel();
    } catch {
      // The socket is going away regardless; a failure to cancel is not a fact
      // about the server.
    }
    if (!response.ok) return { provider, baseUrl, endpoint, up: false, detail: `HTTP ${response.status}` };
    return { provider, baseUrl, endpoint, up: true, detail: null };
  } catch (error) {
    return { provider, baseUrl, endpoint, up: false, detail: describeProbeFailure(error, timeoutMs) };
  }
}

/**
 * One short phrase for why a connection failed — the whole of the diagnostic.
 *
 * The errno is the sentence that matters: `ECONNREFUSED` means nothing is
 * listening and a timeout means something accepted the connection and went
 * quiet, and those send the reader to two different places — a stopped server
 * against a firewall or a wrong host.
 *
 * **The `cause` chain is walked to its message, and that was measured in the
 * built app rather than assumed.** `fetch` here is Chromium's, not undici's, and
 * its rejections do not all carry `cause.code`: a refused connection does
 * (`ECONNREFUSED`, the same as under Vitest), but a URL on Chromium's restricted
 * port list rejects with a cause whose only content is the message `"bad port"`.
 * A version that stopped at `error.message` printed the errno in the test suite
 * and the words *"fetch failed"* in the shipped app — which is the one place the
 * message is the whole of what a remote user has.
 *
 * Exported so `main/ipc.ts` says the same thing about a live connection check
 * that detection says about a probe.
 */
export function describeProbeFailure(error: unknown, timeoutMs: number): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return `timed out after ${timeoutMs}ms`;
  }
  const cause = error.cause;
  if (cause !== null && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return error.message;
}

/**
 * The sentence someone on another machine reads when nothing answered.
 *
 * It names **both** providers and **both** endpoints, because naming one tells a
 * user running LM Studio that Ollama is down — true, useless, and pointing at
 * the wrong program. The two remedies follow: start a server, or point the app
 * at one. Both are reachable from the app's own provider row, and both have an
 * environment variable for the shell, and neither is discoverable from the
 * source by the person this message is written for.
 */
function detectionFailure(probes: readonly ProbeResult[]): string {
  const tried = probes
    .map((p) => `${p.provider} at ${p.endpoint}${p.detail === null ? "" : ` (${p.detail})`}`)
    .join(" and ");
  return (
    `no model server answered — tried ${tried}. Start Ollama or LM Studio's local server, ` +
    "or set the provider and base URL in the app's provider row " +
    `(the shell equivalent is SPRITE_MAKER_PROVIDER with ${BASE_URL_VARS.ollama} / ` +
    `${BASE_URL_VARS.lmstudio})`
  );
}

/**
 * The provider this process should use — A16.
 *
 * Throws only `UnknownProviderError`, and only for a `SPRITE_MAKER_PROVIDER`
 * this build does not have. Everything else resolves, including finding nothing.
 */
export async function detectProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: DetectOptions = {},
): Promise<ProviderResolution> {
  const named = namedProvider(env);
  if (named !== null) {
    // Property 1: not one packet. The user has already answered this question.
    return {
      provider: named,
      baseUrl: baseUrlFor(named, env),
      source: "configured",
      probes: [],
      error: null,
    };
  }

  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  // Property 2. `Promise.all` preserves input order, so `probes` is in
  // `PROVIDERS` order however the network answered — which is what makes the
  // preference below a decision rather than a race.
  const probes = await Promise.all(
    PROVIDERS.map((provider) => probeCandidate(provider, baseUrlFor(provider, env), timeoutMs)),
  );

  // Property 3: the first *listed* provider that answered, never the first to
  // answer.
  const found = probes.find((probe) => probe.up);
  if (found !== undefined) {
    return {
      provider: found.provider,
      baseUrl: found.baseUrl,
      source: "detected",
      probes,
      error: null,
    };
  }

  // Property 4. The default provider at the URL it would have used anyway, so a
  // failed detection leaves exactly the app A15 shipped — plus a message.
  return {
    provider: DEFAULT_PROVIDER,
    baseUrl: baseUrlFor(DEFAULT_PROVIDER, env),
    source: "fallback",
    probes,
    error: detectionFailure(probes),
  };
}

// ---------------------------------------------------------------------------
// the live provider — one that can change without a restart
// ---------------------------------------------------------------------------

/**
 * The provider this process is using *now*.
 *
 * `registerIpc` used to take a `client` by value, which meant nothing could
 * re-resolve the provider at runtime: a switch would take effect at the next
 * restart, silently. This is the mutable cell that fixes it, and the rule that
 * comes with it is that **no consumer may cache `client()`** — `main/ipc.ts`
 * hands every consumer a late-binding wrapper for exactly that reason.
 */
export interface ProviderControl {
  /** The live client. Call it per use; never hold the result. */
  client(): LlmClient;
  /** What the surfaces render, including how the provider was chosen. */
  status(): ProviderResolution;
  /** Point the app at a provider and URL. An empty URL means that provider's default. */
  select(provider: ProviderName, baseUrl?: string): ProviderResolution;
}

export function createProviderControl(
  initial: ProviderResolution,
  factory: (provider: ProviderName, baseUrl: string) => LlmClient = clientFor,
): ProviderControl {
  let status = initial;
  let client = factory(initial.provider, initial.baseUrl);

  return {
    client: () => client,
    // A copy: `status` is handed to the renderer through IPC, and the live cell
    // is not something a caller should be able to edit from behind.
    status: () => ({ ...status, probes: [...status.probes] }),

    select(provider, baseUrl) {
      const url = normalizeBaseUrl(baseUrl) ?? DEFAULT_BASE_URLS[provider];
      // `"configured"`, because the user chose it — rendering "detected" over a
      // choice made by hand is the same lie in the other direction. The previous
      // detection's probes and error go with it: they describe a question that
      // has now been answered, and leaving them would keep a stale "nothing
      // answered" on screen beside a working server.
      status = { provider, baseUrl: url, source: "configured", probes: [], error: null };
      client = factory(provider, url);
      return { ...status };
    },
  };
}
