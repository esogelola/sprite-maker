/**
 * The LM Studio client — spec amendment A15, and the second implementation of
 * `LlmClient`.
 *
 * LM Studio serves the OpenAI chat-completions API. `GET /v1/models` lists;
 * everything else is `POST /v1/chat/completions` with `stream: false` (Ollama
 * streams by default and so does this — fact 2 in `ollama.ts`'s header applies
 * verbatim, for the same reason: omitting the flag does not make the request
 * smaller, it changes the protocol).
 *
 * The request types are Ollama's, because that is the vocabulary every caller
 * was written in and the one the spec records. The translation is here:
 *
 * | `OllamaClient` request | `/v1/chat/completions` |
 * |---|---|
 * | `system` + `prompt` | `messages: [{role:"system"},{role:"user"}]`, system omitted when absent |
 * | `options.temperature` | **top-level** `temperature` |
 * | `options.seed` | **top-level** `seed` |
 * | `options.num_predict` | **top-level** `max_tokens`, negative sentinels omitted |
 * | `format: <schema>` | `response_format.json_schema`, `strict: true` |
 * | `format: "json"` | `response_format: {type:"json_object"}` |
 * | `images: Buffer[]` | user `content` array with `data:image/png;base64,…` URIs |
 * | `tool_calls` | same nesting, `arguments` **stringified**, `type:"function"` added |
 * | `think: false` | **top-level `reasoning_effort: "none"`** — see below |
 * | `think: true` / omitted | no field at all — see below |
 * | reply text | `choices[0].message.content` |
 *
 * **Three things about this file are hazards rather than code.**
 *
 * **1. `think: false` maps to `reasoning_effort: "none"`, and only to `"none"`**
 * — amendment A15, capture
 * `captures/2026-07-30-reasoning-suppression-openai.txt`. Measured against
 * Ollama's own OpenAI-compatible `/v1` endpoint on `qwen3:8b-q4_K_M` at
 * temperature 0 on a reasoning-heavy prompt:
 *
 * | request | generated tokens | ms |
 * |---|---|---|
 * | native `/api/generate` `think: false` (reference) | 82 | 2551 |
 * | OpenAI endpoint, no suppression | 600 | 24472 |
 * | **`reasoning_effort: "none"`** | **82** | **3340** |
 * | `reasoning_effort: "low"` | 600 | 24402 |
 * | `/no_think` in the prompt | 204 — *worse* than sending nothing | — |
 * | `chat_template_kwargs: { enable_thinking: false }` | 180 — no effect | — |
 * | top-level `think: false` | 180 — no effect; the OpenAI layer drops it | — |
 *
 * Content was byte-identical to the native reference. Four of those six rows are
 * spellings that read as correct and change nothing — the same trap A8 recorded
 * for `options: { think: false }`, which is why the mapping is one line of code
 * and twenty of evidence. **`"low"` does not suppress**; only `"none"` does, so
 * this is not a scale to tune. An assistant prefill of an empty `<think>` block
 * also suppresses on the hybrid model (12 tokens) and was rejected anyway: on the
 * non-thinking VL model it made things *worse* (34 vs 13), because the model
 * answers the injected block.
 *
 * `think: true` and an omitted `think` both send **no field**, which leaves the
 * server's default in force — exactly what an omitted `think` does on Ollama.
 *
 * Two caveats belong with the mapping rather than in a doc nobody opens:
 *
 * - **The model this app actually ships cannot reason at all.**
 *   `qwen3-vl:8b-instruct-q4_K_M` — bound to *both* roles by default — answers
 *   native `think: true` with HTTP 400, `does not support thinking`. A8's 86×
 *   was measured on `qwen3:8b`, which the project later abandoned because it
 *   cannot draw. So on the shipped configuration this whole field is a no-op,
 *   and it matters only for a hybrid generator someone binds later.
 * - **Suppressing reasoning costs accuracy where reasoning was the point.** The
 *   same constrained prompt returned the right answer with reasoning on and the
 *   wrong one under `"none"`. §7.4 already runs the draft stage with
 *   `think: false` and A10's benchmark was taken that way, so this is a
 *   documented trade rather than a regression — but it is the reason `think` is
 *   a per-stage choice and not a client-wide setting.
 *
 * **2. Every falsy-zero trap in this project lives on this path.** The Ollama →
 * OpenAI move lifts values out of a nested bag and onto the top level, which is
 * exactly where `if (options.temperature)` gets written. `temperature: 0` is
 * what every bench run and every seeded determinism test sets (§6.8 A13); a
 * truthiness guard drops it, the server applies its own default, every
 * measurement afterwards is invalid, and every test still passes. `seed: 0` is
 * an ordinary seed. `num_predict: 0` is a real, if degenerate, budget. Each is
 * written `!== undefined` and each has a test that asserts `0` reaches the wire.
 *
 * **3. Grammar-constrained decoding is the thinnest part of the conversion.**
 * Ollama compiles a JSON Schema into a decoder grammar directly; the OpenAI
 * spelling goes through llama.cpp's GBNF converter, which does not support every
 * JSON Schema construct. `response_format: { type: "json_schema", json_schema: {
 * name, strict: true, schema } }` was measured to constrain output correctly over
 * Ollama's `/v1` endpoint (A15), so the mechanism works. What is **not** measured
 * is the shape that matters most: A10's draft schema is an `anyOf` over five
 * `const`-tagged object variants, which is the construct most likely to be
 * thinned by a GBNF converter, and nothing here has run it. `strict: true` is
 * what asks for enforcement at all — without it the schema is a suggestion.
 */

import {
  jsonRequest,
  parseToolCalls,
  postJson,
  stringify,
  truncate,
  type ChatWithToolsRequest,
  type GenerateRequest,
  type LlmClient,
  type OllamaFormat,
  type OllamaOptions,
  type ProviderIdentity,
  type VisionRequest,
} from "@main/ollama";
import type { ChatMessage, ChatTurn } from "@shared/schema";

/**
 * Where LM Studio's server listens by default.
 *
 * LM Studio documents `localhost:1234`; this is the same place spelled without
 * a name to resolve. The literal is chosen to sidestep the resolver-order
 * question rather than to answer it: `DEFAULT_OLLAMA_BASE_URL` gives a
 * *macOS-shaped* reason for preferring the literal (`localhost` resolves to
 * `::1` first there, and Ollama binds IPv4 only), and that reasoning does not
 * transfer — this app is developed against LM Studio on Linux too, where both
 * the resolution order and LM Studio's own bind behaviour differ.
 *
 * **A supplied base URL is passed through untouched** — only a trailing slash is
 * removed, and only so the path does not double its separator. Hostnames, IPv6
 * literals and non-loopback LAN addresses all survive verbatim, because LM
 * Studio is routinely run on a different machine from the editor and rewriting
 * `localhost` to `127.0.0.1` on the user's behalf would silently retarget a host
 * they chose deliberately. Pinned by tests.
 */
export const DEFAULT_LMSTUDIO_BASE_URL = "http://127.0.0.1:1234";

/**
 * Where `listModels` asks, and — amendment A16 — where detection probes.
 *
 * The counterpart of `OLLAMA_MODELS_PATH`, and the reason detection can tell the
 * two providers apart at all: `/api/tags` and `/v1/models` are what each server
 * already answers, so a 200 here is LM Studio and a 200 there is Ollama without
 * either of them having to identify itself.
 */
export const LMSTUDIO_MODELS_PATH = "/v1/models";

/**
 * LM Studio's **own** listing, not the OpenAI-compatible one — amendment A17.
 *
 * `/v1/models` is OpenAI's shape and carries exactly `id, object, created,
 * owned_by`: no size, no loaded state, and no prospect of either, because the
 * shape is not LM Studio's to extend. `/api/v0/models` is LM Studio's native
 * listing and carries `id, object, type, publisher, arch, compatibility_type,
 * quantization, state, max_context_length`.
 *
 * **It carries no size either** — that is the finding, not a hope.
 * `lmstudio-ai/lmstudio-js#156` is the open request to add one. So A17 probes
 * this path, reads a size *if a future build reports one*, and otherwise falls
 * back to a `totalmem()`-derived assumption and says in the UI that it did.
 * A build without the path answers 404, which is an answer.
 */
export const LMSTUDIO_NATIVE_MODELS_PATH = "/api/v0/models";

/**
 * Where a model is unloaded — amendment A17.
 *
 * LM Studio's REST documentation specifies `POST /api/v1/models/unload` with a
 * body of `{ instance_id }`. **The key is `instance_id`, not `model`** — every
 * other request this client sends is keyed by `model`, so `model` is what habit
 * writes, and a body the server ignores is indistinguishable from one it honours
 * when nothing checks.
 *
 * Unverified against a live LM Studio, like everything else in this file. A
 * build without the v1 beta API answers 404; the residency runner treats any
 * failure as survivable and the README names LM Studio's own JIT auto-evict
 * (Developer ▸ Max loaded models) as the supported route in that case. This
 * client attempts the documented call once and does not fight the host app.
 */
export const LMSTUDIO_UNLOAD_PATH = "/api/v1/models/unload";

/**
 * How LM Studio names itself in the errors a user reads — spec A15.
 *
 * The classes are shared with the Ollama path because they describe transport;
 * the wording is not, because the message is the whole diagnostic. Someone whose
 * editor says *"Ollama is unreachable at :1234"* while they run LM Studio has
 * been told to go and fix the wrong program, and after a reload that sentence is
 * all that survives — §6.7 flattens the error to one string.
 *
 * The unreachable hint names both halves of the actual decision: start the
 * server, or point the app somewhere else. Those are the two things that are
 * ever wrong, and the message should not require reading this file to tell them
 * apart.
 */
export const LMSTUDIO_PROVIDER: ProviderIdentity = {
  name: "LM Studio",
  unreachableHint:
    " — start LM Studio's local server (Developer tab ▸ Status: Running), " +
    "or set LMSTUDIO_BASE_URL if it listens on another host or port",
  notFoundHint: (model) =>
    model.length > 0
      ? ` — load \`${model}\` in LM Studio, or check the id against \`GET /v1/models\``
      : "",
};

/**
 * What `think: false` becomes — hazard 1 in the header.
 *
 * Exported so a test names the same constant the client sends rather than a
 * second copy of the string, and so the one value that was measured to work is
 * findable by grep from the spec amendment that measured it.
 */
export const NO_REASONING_EFFORT = "none";

// ---------------------------------------------------------------------------
// untranslatable options
// ---------------------------------------------------------------------------

/**
 * Something a caller asked for that this client cannot put on an OpenAI wire.
 *
 * `think` is **not** one of these — it has a measured translation (see the
 * header). What remains are `options` keys with no top-level OpenAI spelling:
 * this app sends only `temperature` and `seed` (`modelOptions`, spec A13), so in
 * practice the set is empty, and the reporting exists so that the day someone
 * adds `num_ctx` or `repeat_penalty` it is a line in the log rather than a
 * setting that silently does nothing on one provider.
 *
 * A value rather than a log line, so the gap is inspectable: a test asserts on
 * it without capturing `console`, and a future status bar could surface it
 * without this file learning about the UI.
 */
export interface UnsupportedCapability {
  /**
   * `"options.<key>"` — the option that could not be translated.
   *
   * Also the default sink's dedupe key, which is why it names the *field* and
   * not the model or the endpoint — those vary per call and would defeat it.
   */
  capability: string;
  /** One sentence a user could act on, or at least understand. */
  detail: string;
  model: string;
  endpoint: string;
}

export interface LmStudioClientOptions {
  /**
   * Called **once per affected request**, before the request goes out.
   *
   * Defaults to a sink that warns once per capability for the lifetime of the
   * client. Supplying your own opts out of that dedupe entirely — which is what
   * a test wants and what a counter would want, and neither should have to
   * scrape stderr for it.
   */
  onUnsupported?: (gap: UnsupportedCapability) => void;
}

/**
 * `console.warn` once per capability, then silence.
 *
 * Per client, and the app constructs exactly one — `main/provider.ts`, called
 * once from `main/index.ts` — so this is once per process in practice without
 * module-level state that would leak between tests and make the dedupe itself
 * untestable.
 */
function warnOncePerCapability(): (gap: UnsupportedCapability) => void {
  const warned = new Set<string>();
  return (gap) => {
    if (warned.has(gap.capability)) return;
    warned.add(gap.capability);
    console.warn(
      `[sprite-maker] LM Studio cannot honour \`${gap.capability}\`: ${gap.detail} ` +
        `(model ${gap.model}, ${gap.endpoint}). Further \`${gap.capability}\` notices ` +
        `from this client are suppressed.`,
    );
  };
}

// ---------------------------------------------------------------------------
// request translation
// ---------------------------------------------------------------------------

/** The option keys with a top-level OpenAI spelling. Everything else is a gap. */
const TRANSLATED_OPTIONS = new Set(["temperature", "seed", "num_predict"]);

/**
 * `system` + `prompt` → OpenAI's `messages`.
 *
 * **An absent `system` produces no system message at all**, rather than one
 * whose content is `""`. An empty system turn is still a turn: chat templates
 * render a blank system block for it, and on some models that measurably shifts
 * behaviour. `undefined` is the caller saying "no system prompt", and the wire
 * has a way to say that — one fewer element.
 */
function promptMessages(system: string | undefined, content: unknown): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  if (system !== undefined) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content });
  return messages;
}

/**
 * The user `content` for a vision call — spec §4.4.
 *
 * An array whenever `vision()` is the method called, including for zero images,
 * because the shape should follow the *call*, not the payload: a critique with
 * an empty image list is a bug worth seeing as one, not a text call that quietly
 * succeeded.
 *
 * The `data:image/png;base64,` prefix is not decoration. Ollama takes bare
 * base64 in its own `images` array; OpenAI takes a URL, and a bare base64 string
 * in that field is not a URL — it is rejected, or worse, fetched as a relative
 * path. `render.ts` emits PNG, so the media type is a fact rather than a guess.
 */
function visionContent(prompt: string, images: readonly Buffer[]): Record<string, unknown>[] {
  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
    })),
  ];
}

/**
 * Ollama's `format` → OpenAI's `response_format` — hazard 3 in the header.
 *
 * `strict: true` is the whole point of the schema arm: it is what turns the
 * schema into a decoding constraint rather than a hint the model may ignore,
 * which is the property A10 depends on for op shape to be unrepresentable rather
 * than merely repairable. The `name` is required by the OpenAI shape and carries
 * no meaning for a single anonymous response schema.
 */
function responseFormat(format: OllamaFormat): Record<string, unknown> {
  // Ollama defines exactly one string value here, `"json"` — "valid JSON, any
  // shape" — which is `json_object` and nothing else.
  if (typeof format === "string") return { type: "json_object" };
  return { type: "json_schema", json_schema: { name: "response", strict: true, schema: format } };
}

/**
 * `options: { … }` → top-level fields — hazard 2 in the header.
 *
 * Every guard is `!== undefined`. `temperature: 0`, `seed: 0` and
 * `num_predict: 0` are all legal values that a truthiness check would drop while
 * leaving the request valid, the tests green and the server's own defaults
 * quietly in force.
 *
 * `num_predict` is the one that is not a straight move. Ollama spells "no limit"
 * as a negative sentinel (`-1` unbounded, `-2` fill context); OpenAI spells it by
 * **omitting `max_tokens`**, and a negative `max_tokens` is not a smaller limit
 * but an invalid request. Dropping the key for a negative is therefore the
 * faithful translation, not a silent loss — and it is the only case in this
 * function where a supplied value does not reach the wire.
 */
function applyOptions(
  body: Record<string, unknown>,
  options: OllamaOptions | undefined,
  report: (gap: Omit<UnsupportedCapability, "model" | "endpoint">) => void,
): void {
  if (options === undefined) return;

  const temperature = options.temperature;
  if (temperature !== undefined) body.temperature = temperature;

  const seed = options.seed;
  if (seed !== undefined) body.seed = seed;

  const numPredict = options.num_predict;
  if (numPredict !== undefined) {
    if (typeof numPredict === "number" && numPredict >= 0) {
      body.max_tokens = numPredict;
    } else if (typeof numPredict !== "number") {
      report({
        capability: "options.num_predict",
        detail:
          "`num_predict` must be a number to become `max_tokens`; got " +
          stringify(numPredict),
      });
    }
    // A negative is Ollama's "unbounded" sentinel, and an omitted `max_tokens`
    // is how OpenAI says the same thing — nothing to report.
  }

  for (const key of Object.keys(options)) {
    if (TRANSLATED_OPTIONS.has(key)) continue;
    report({
      capability: `options.${key}`,
      detail:
        `\`options.${key}\` has no OpenAI equivalent this client knows how to translate, ` +
        "so it is not being sent",
    });
  }
}

/**
 * One `ChatMessage` in OpenAI's envelope.
 *
 * Two differences from `ollama.ts`'s `messageToWire`, and both are silent when
 * wrong — the same class of defect as the flat-`tool_calls` finding in
 * `captures/2026-07-29-wave-5-tool-call-wire-format.txt`:
 *
 * - **`arguments` is a JSON string, not an object.** OpenAI's schema types it as
 *   a string; a server handed an object may coerce it, may ignore the call, or
 *   may error, and which of those happens is a property of the server rather
 *   than of the request.
 * - **`type: "function"` is required** on each call. It is the discriminator of
 *   a union that currently has one arm, so leaving it out looks harmless.
 *
 * `tool_calls` is omitted rather than sent as `[]` for the reason the Ollama
 * side gives: an assistant turn with no calls is not a turn that made zero
 * calls, and templates branch on presence.
 */
function messageToWire(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
    wire.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  if (message.tool_call_id !== undefined) wire.tool_call_id = message.tool_call_id;
  return wire;
}

// ---------------------------------------------------------------------------
// response reading
// ---------------------------------------------------------------------------

/**
 * `choices[0].message`, or a throw naming the endpoint.
 *
 * `choices` can legitimately arrive empty — a filtered or aborted completion —
 * and `choices[0].message.content` on an empty array is a `TypeError` from four
 * frames inside this module, which tells the user nothing and §9 nothing. The
 * guard is what turns that into the same "this is not the reply I asked for"
 * message the Ollama side produces.
 */
function readMessage(payload: Record<string, unknown>, endpoint: string): Record<string, unknown> {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`${endpoint} returned no \`choices\`: ${truncate(stringify(payload))}`);
  }
  const message = (choices[0] as { message?: unknown } | null)?.message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new Error(
      `${endpoint} returned a choice with no \`message\`: ${truncate(stringify(payload))}`,
    );
  }
  return message as Record<string, unknown>;
}

/**
 * The completion text — the counterpart of `readResponse` in `ollama.ts`.
 *
 * `""` is returned, because an empty completion is a short answer that §6.3
 * already routes into its retry path. Anything that is not a string — including
 * the `null` OpenAI sends when an assistant turn is pure tool calls — throws:
 * `generate` and `vision` offer no tools, so there is nothing for the model to
 * have called instead, and reporting that as empty output would charge the
 * draft's repair budget for a reply this client could not read.
 */
function readContent(payload: Record<string, unknown>, endpoint: string): string {
  const content = readMessage(payload, endpoint).content;
  if (typeof content !== "string") {
    throw new Error(
      `${endpoint} returned no \`content\` string: ${truncate(stringify(payload))}`,
    );
  }
  return content;
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

export function createLmStudioClient(
  baseUrl: string = DEFAULT_LMSTUDIO_BASE_URL,
  clientOptions: LmStudioClientOptions = {},
): LlmClient {
  // Trailing slashes only. The host is never rewritten — see
  // `DEFAULT_LMSTUDIO_BASE_URL`; a LAN address or an IPv6 literal is a choice,
  // not a mistake to correct.
  const root = baseUrl.replace(/\/+$/, "");
  const modelsEndpoint = `${root}${LMSTUDIO_MODELS_PATH}`;
  const chatEndpoint = `${root}/v1/chat/completions`;
  const onUnsupported = clientOptions.onUnsupported ?? warnOncePerCapability();

  /** Binds a report to the call it came from, so the sink can name both. */
  function reporter(
    model: string,
  ): (gap: Omit<UnsupportedCapability, "model" | "endpoint">) => void {
    return (gap) => onUnsupported({ ...gap, model, endpoint: chatEndpoint });
  }

  /**
   * The one body builder — `generate`, `vision` and `chatWithTools` differ only
   * in how they fill `messages`, which is the point of the OpenAI shape.
   */
  function completionBody(
    req: { model: string; options?: OllamaOptions; format?: OllamaFormat; think?: boolean },
    messages: Record<string, unknown>[],
  ): Record<string, unknown> {
    const report = reporter(req.model);
    const body: Record<string, unknown> = { model: req.model, messages, stream: false };
    applyOptions(body, req.options, report);
    if (req.format !== undefined) body.response_format = responseFormat(req.format);
    // Hazard 1, and the only value measured to suppress. `=== false`, not
    // `!== undefined`: `think: true` is "let the model reason", which is what an
    // absent field already means, and sending `reasoning_effort` for it would
    // invent a request the caller did not make. `"low"` was measured **not** to
    // suppress, so there is no scale here to be clever with.
    if (req.think === false) body.reasoning_effort = NO_REASONING_EFFORT;
    return body;
  }

  return {
    async listModels(): Promise<string[]> {
      const payload = await jsonRequest(
        modelsEndpoint,
        "",
        undefined,
        { method: "GET" },
        LMSTUDIO_PROVIDER,
      );
      const data = payload.data;
      if (!Array.isArray(data)) {
        // Not `[]`, for the reason the Ollama side gives: an empty list means
        // "the server is up and has nothing loaded", which §9's pickers render
        // as a quiet dead end rather than the fault it is.
        throw new Error(
          `${modelsEndpoint} returned no \`data\` array: ${truncate(stringify(payload))}`,
        );
      }
      return data
        .map((entry) => (entry as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    },

    async generate(req: GenerateRequest): Promise<string> {
      const body = completionBody(req, promptMessages(req.system, req.prompt));
      const payload = await postJson(chatEndpoint, body, req.model, req.signal, LMSTUDIO_PROVIDER);
      return readContent(payload, chatEndpoint);
    },

    async vision(req: VisionRequest): Promise<string> {
      const content = visionContent(req.prompt, req.images);
      const body = completionBody(req, promptMessages(req.system, content));
      const payload = await postJson(chatEndpoint, body, req.model, req.signal, LMSTUDIO_PROVIDER);
      return readContent(payload, chatEndpoint);
    },

    async chatWithTools(req: ChatWithToolsRequest): Promise<ChatTurn> {
      const body = completionBody(req, req.messages.map(messageToWire));
      // `tools` is already OpenAI-shaped — `{ type: "function", function: { name,
      // description, parameters } }` is what `ToolDef` is and what Ollama took —
      // so this is the one field that crosses unchanged.
      body.tools = req.tools;

      const payload = await postJson(chatEndpoint, body, req.model, req.signal, LMSTUDIO_PROVIDER);
      const message = readMessage(payload, chatEndpoint);
      const { content, tool_calls: toolCalls } = message as {
        content?: unknown;
        tool_calls?: unknown;
      };
      return {
        // `null` here — the shape OpenAI sends for a pure tool-calling turn — is
        // an empty answer, not a fault, and Wave 8 counts the turn either way.
        content: typeof content === "string" ? content : "",
        toolCalls: parseToolCalls(toolCalls),
      };
    },

    /**
     * Unload `model` — amendment A17. See `LMSTUDIO_UNLOAD_PATH`.
     *
     * Not on `/v1/...` with the rest of this client: the unload is LM Studio's
     * own API rather than OpenAI's, which is why the body is keyed by
     * `instance_id` and why a build that predates it answers 404.
     */
    async release(model: string, signal?: AbortSignal): Promise<void> {
      await postJson(
        `${root}${LMSTUDIO_UNLOAD_PATH}`,
        { instance_id: model },
        model,
        signal,
        LMSTUDIO_PROVIDER,
      );
    },
  };
}
