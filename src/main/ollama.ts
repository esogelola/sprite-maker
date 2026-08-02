/**
 * The Ollama client — spec §6.9, and one of the two places in this app HTTP
 * happens (spec §5.2, amendment A15).
 *
 * Every other module accepts the `LlmClient` interface rather than a URL, so the
 * whole harness runs against a scripted stub with Ollama stopped, and a second
 * provider is a one-file change. `main/lmstudio.ts` is that second file — it is
 * the other half of Wave 5's acceptance criterion 6, which was a grep for
 * `fetch(`, `http.request` and `axios` under `src/`. Two files now match, and
 * both implement the same interface. `lmstudio.ts` shares this module's
 * transport (`postJson`, `jsonRequest`), its error vocabulary and its
 * `parseToolCalls` rather than forking them: the abort discipline below is
 * subtle enough that a second copy would drift the first time either is fixed.
 *
 * Three wire-format facts are load-bearing, each verified against a live Ollama
 * 0.32.1 and recorded in
 * `docs/superpowers/specs/captures/2026-07-29-wave-5-tool-call-wire-format.txt`:
 *
 * **1. `tool_calls` is nested, not flat.** Ollama's decoder expects
 * `{ id, function: { name, arguments } }`. `ToolCall` — the shape §6.9 gives the
 * rest of the app — is flat: `{ id, name, arguments }`. Sending the flat form
 * produces no error, no warning and no rejection; the unknown keys are dropped,
 * the chat template renders no tool call, and the model re-issues the call it
 * already made, burning Wave 8's 40-turn cap. The whole difference between a
 * working revise loop and a silent infinite one is `messageToWire` below.
 *
 * **2. `stream: false` is not an optimisation.** Ollama streams by default and a
 * streamed reply is newline-delimited JSON, not one object. Omitting the flag
 * does not make the request smaller; it changes the protocol.
 *
 * **3. `response` is the answer; `thinking` is not.** On a thinking model
 * Ollama 0.32 splits the reasoning trace into its own field. Falling back to
 * `thinking` when `response` is empty would hand Wave 6's `parseDraft` a
 * monologue and charge the repair budget for it. The upside: `parseDraft` never
 * has to strip a `<think>` block.
 *
 * **4. `think` is a top-level request field, and only a top-level request
 * field** — spec amendment A8, capture
 * `captures/2026-07-29-wave-5-think-suppression.txt`. The corollary of fact 3 is
 * that the reasoning tokens are still generated, still counted in `eval_count`
 * and still paid for in wall clock; they simply land in a field nothing reads.
 * Measured on `qwen3:8b` / Ollama 0.32.1 at temperature 0 over two prompts:
 *
 * | method | eval tokens | `thinking` chars |
 * |---|---|---|
 * | nothing | 157 / 372 | 667 / 1433 |
 * | `/no_think` prompt prefix | 340 / 393 | 1527 / 1465 |
 * | `options: { think: false }` | 372 | 1433 |
 * | **top-level `think: false`** | **3 / 14** | **0 / 0** |
 *
 * The prefix is inert. The options-bag spelling is *worse than inert*: Ollama
 * drops unknown keys inside `options` with no error, no warning and no
 * rejection, so it type-checks against `Record<string, unknown>`, reads
 * correctly in review, and does nothing — which is why `OllamaOptions` below
 * makes it a compile error rather than a comment.
 *
 * Timeouts are the caller's: §6.8 scales `callTimeoutMs` by canvas area, which
 * this module cannot compute, so it takes an `AbortSignal` and reports what
 * happened.
 */

import type { ChatMessage, ChatTurn, ToolCall, ToolDef } from "@shared/schema";

/**
 * Where Ollama listens by default.
 *
 * `127.0.0.1`, never `localhost`: on macOS `localhost` resolves to `::1` first,
 * and Ollama binds IPv4 only, so every call would pay a refused connection
 * before falling back.
 */
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

/**
 * Where `listModels` asks, and — amendment A16 — where detection probes.
 *
 * Exported so the probe reuses the path this client already speaks rather than
 * inventing a second health endpoint that nobody would notice had rotted. A
 * dedicated `/health` would be one more thing to keep true about a server this
 * project does not own; the listing call is the one request whose success
 * already means "the model server is there and answering".
 */
export const OLLAMA_MODELS_PATH = "/api/tags";

/** How much of an unexpected error body is worth carrying in a message. */
const MAX_ERROR_BODY = 400;

/**
 * How a provider names itself in the errors a user reads — amendment A15.
 *
 * The three error classes below describe *transport*, not a vendor, and both
 * clients throw them: forking a parallel hierarchy would give §9's IPC envelope
 * two vocabularies to flatten and §8's status bar two shapes to render. But the
 * *message* is the only diagnostic a user gets — after a reload it is the only
 * thing left, since `SessionHistory.error` is a flat string — and
 * "Ollama is unreachable at http://127.0.0.1:1234" sends someone to restart the
 * wrong program. So the class stays shared and the wording is per provider.
 *
 * The hints are here rather than at the throw site because the throw site is a
 * generic transport function that has no idea what it is talking to.
 */
export interface ProviderIdentity {
  /** What the user calls this thing: `"Ollama"`, `"LM Studio"`. */
  readonly name: string;
  /** Appended to an unreachable message — the "what do I do now" sentence. */
  readonly unreachableHint: string;
  /** Appended to a 404 message. `""` when there is nothing useful to say. */
  notFoundHint(model: string): string;
}

/** The default identity, and the one every existing message was written for. */
export const OLLAMA_PROVIDER: ProviderIdentity = {
  name: "Ollama",
  // Deliberately empty: these messages are pinned by tests written before A15
  // and shown in a UI that was reviewed against them. LM Studio is new and gets
  // the sentence; changing Ollama's would be an unrelated behaviour change
  // smuggled into a commit about adding a provider.
  unreachableHint: "",
  notFoundHint: (model) =>
    model.length > 0 ? ` — if the model is not installed, run \`ollama pull ${model}\`` : "",
};

// ---------------------------------------------------------------------------
// requests — spec §6.9
// ---------------------------------------------------------------------------

/**
 * Ollama's own option bag — `temperature`, `seed`, `num_predict`, … — with one
 * key spelled out so it cannot be used.
 *
 * `think` is not an option, and Ollama discards it here without complaint (fact
 * 4 in the header). Nothing else in the type system would object: the bag is a
 * `Record<string, unknown>`, so `{ temperature: 0, think: false }` compiles,
 * reviews clean, and silently restores 1433 characters of reasoning per call.
 * Declaring the key with a sentence for a type turns that into a compile error
 * whose message *is* the correction. Arbitrary bags built elsewhere still assign
 * — only a literal or a type that actually carries `think` is rejected.
 */
export type OllamaOptions = Record<string, unknown> & {
  think?: "`think` is a top-level request field, not an `options` key — spec A8";
};

/**
 * Ollama's `format` — spec §6.9, amendment A10.
 *
 * Two shapes, not one. `"json"` constrains the model to *valid* JSON; a JSON
 * **Schema** object constrains it to a valid *document*, which is what A10's
 * draft stage sends and what made row width unrepresentable rather than merely
 * repairable. `generateBody` forwards the field verbatim, so the wire has always
 * carried both — only the type was narrow, and Wave 6b had to declare a local
 * `format`-widened request type at its own boundary to say what it was already
 * sending. Widening it here is the honest fix: the object is not an escape hatch
 * from the contract, it *is* the contract for `DRAFT`.
 */
export type OllamaFormat = string | Record<string, unknown>;

export interface GenerateRequest {
  model: string;
  system?: string;
  prompt: string;
  options?: OllamaOptions;
  /** `"json"`, or a whole JSON Schema — see `OllamaFormat`. */
  format?: OllamaFormat;
  /**
   * Suppress (or demand) the model's reasoning channel — spec §6.9, A8.
   *
   * Omitted leaves the decision to Ollama and the model, which is what the
   * critique stage wants; §7.4's draft and revise stages pass `false`.
   */
  think?: boolean;
  signal?: AbortSignal;
}

/**
 * `generate` plus the images §4.4 requires the critic to see.
 *
 * `format` is inherited, and the critic sends `"json"` through it — the string
 * arm and the schema arm are the same field on the same endpoint.
 */
export interface VisionRequest extends GenerateRequest {
  images: Buffer[];
}

export interface ChatWithToolsRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  options?: OllamaOptions;
  /**
   * `"json"`, or a whole JSON Schema — see `OllamaFormat`. `/api/chat` takes the
   * same field as `/api/generate`, and it is declared here so the widening A10
   * needed does not have to be discovered a third time by whichever stage wants
   * a constrained tool argument next. Omitted leaves it off the wire entirely.
   */
  format?: OllamaFormat;
  /** See `GenerateRequest.think`. This is the stage where it matters most. */
  think?: boolean;
  signal?: AbortSignal;
}

/**
 * The four calls this app makes of a local model — spec §6.9.
 *
 * Named for the capability, not the vendor. `createOllamaClient` and
 * `createLmStudioClient` both return one of these, and every consumer —
 * `draft`, `critique`, `revise`, `pipeline`, `ipc`, `models` — accepts the
 * interface, so the provider is chosen once at `main/provider.ts` and nothing
 * downstream can tell which one it got.
 *
 * The request types keep their Ollama spelling (`options`, `format`, `think`)
 * because that is the vocabulary every caller was written in and the one the
 * spec records. `lmstudio.ts` translates them at its own boundary — see its
 * header for the table, and for the one field it cannot translate.
 */
export interface LlmClient {
  listModels(): Promise<string[]>;
  generate(req: GenerateRequest): Promise<string>;
  vision(req: VisionRequest): Promise<string>;
  chatWithTools(req: ChatWithToolsRequest): Promise<ChatTurn>;
}

/**
 * @deprecated Use `LlmClient`. The interface describes a capability — four
 * calls against a local model — not a vendor, and since amendment A15 there are
 * two implementations of it. This alias exists only so the rename did not have
 * to touch nine consumer files in the same commit that added the second
 * provider; it is exactly `LlmClient` and can be replaced by it anywhere.
 */
export type OllamaClient = LlmClient;

// ---------------------------------------------------------------------------
// errors — spec §6.9, §9
// ---------------------------------------------------------------------------

/**
 * Ollama could not be reached at all — spec §6.9.
 *
 * `endpoint` is a field as well as part of the message because §9 sends errors
 * across IPC as a result envelope: `ipcMain.handle` destroys an error's own
 * properties, so the endpoint has to survive in both places. §8 then has the
 * status bar name the exact endpoint, and after a reload the flat
 * `SessionHistory.error` string is its only source.
 */
export class OllamaUnreachableError extends Error {
  override readonly name = "OllamaUnreachableError";

  constructor(
    readonly endpoint: string,
    options?: { cause?: unknown; provider?: ProviderIdentity },
  ) {
    const provider = options?.provider ?? OLLAMA_PROVIDER;
    const reason = describeCause(options?.cause);
    // The provider name and the exact URL that was tried, in that order, because
    // together they separate "the server is not running" from "the port in my
    // environment variable is wrong" — which is the entire diagnosis available
    // to someone who cannot read this source.
    super(
      `${provider.name} is unreachable at ${endpoint}${reason}${provider.unreachableHint}`,
      options,
    );
  }
}

/**
 * The caller's `AbortSignal` fired before the call finished — spec §6.9.
 *
 * Carries `elapsedMs` because §9 shows the elapsed time in the UI, and because
 * "aborted after 480s" and "aborted immediately" are different diagnoses that a
 * bare message could not tell apart.
 */
export class OllamaTimeoutError extends Error {
  override readonly name = "OllamaTimeoutError";

  constructor(
    readonly model: string,
    readonly elapsedMs: number,
    provider: ProviderIdentity = OLLAMA_PROVIDER,
  ) {
    super(`${provider.name} call to ${model} was aborted after ${Math.round(elapsedMs)}ms`);
  }
}

/**
 * Ollama answered, but not with success.
 *
 * Not in §6.9's two-error vocabulary, because §6.9 lists the errors *callers*
 * branch on and nothing branches on this one. It exists because something has to
 * be thrown for a non-2xx, and a bare `Error` would strip the two facts §9 needs
 * from the one layer that has them: a 404 here is the "bound model not
 * installed" row of §9's table, which asks for the model **and** the `ollama
 * pull` command that fixes it.
 */
export class OllamaHttpError extends Error {
  override readonly name = "OllamaHttpError";

  constructor(
    readonly endpoint: string,
    readonly status: number,
    readonly model: string,
    body: string,
    provider: ProviderIdentity = OLLAMA_PROVIDER,
  ) {
    // The remedy is the provider's to name: `ollama pull` is not a thing a user
    // of LM Studio can run, and a message that told them to would be worse than
    // one that said nothing.
    const hint = status === 404 ? provider.notFoundHint(model) : "";
    super(`${provider.name} returned ${status} from ${endpoint}: ${truncate(body)}${hint}`);
  }
}

// ---------------------------------------------------------------------------
// transport — shared with `main/lmstudio.ts`
// ---------------------------------------------------------------------------

/**
 * One request, with §6.9's two failure modes separated.
 *
 * The abort check comes first and is made against the *signal*, not against the
 * error: an aborted `fetch` rejects with a `TypeError` that is otherwise
 * indistinguishable from a connection failure, and calling a timeout
 * "unreachable" would put the wrong cause in the status bar and in
 * `SessionHistory.error`. Everything else that throws before a response arrives
 * — refused, reset, DNS — is unreachable, which is what it means to the user
 * regardless of the errno.
 *
 * Module-level and exported rather than closed over a base URL, because
 * `lmstudio.ts` needs exactly this and the three paragraphs of reasoning above
 * are what a second copy would lose. It takes a whole `endpoint` for the same
 * reason the errors carry one: §9 sends errors over IPC where `ipcMain.handle`
 * destroys their fields, and §8's status bar names the endpoint that failed —
 * so an LM Studio failure has to name an LM Studio endpoint, and the only way to
 * guarantee that is for the caller to supply it.
 */
export async function jsonRequest(
  endpoint: string,
  model: string,
  signal: AbortSignal | undefined,
  init: RequestInit,
  provider: ProviderIdentity = OLLAMA_PROVIDER,
): Promise<Record<string, unknown>> {
  const started = performance.now();

  let response: Response;
  try {
    response = await fetch(endpoint, { ...init, signal });
  } catch (cause) {
    if (signal?.aborted === true) {
      throw new OllamaTimeoutError(model, performance.now() - started, provider);
    }
    throw new OllamaUnreachableError(endpoint, { cause, provider });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new OllamaHttpError(endpoint, response.status, model, body, provider);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    // The body can still be cut off mid-read — the abort has to be checked
    // again here, not only around the headers.
    if (signal?.aborted === true) {
      throw new OllamaTimeoutError(model, performance.now() - started, provider);
    }
    throw new OllamaUnreachableError(endpoint, { cause, provider });
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${endpoint} returned ${JSON.stringify(payload)}, expected a JSON object`);
  }
  return payload as Record<string, unknown>;
}

/** `jsonRequest` with a JSON body — every non-listing call either side makes. */
export async function postJson(
  endpoint: string,
  body: Record<string, unknown>,
  model: string,
  signal: AbortSignal | undefined,
  provider: ProviderIdentity = OLLAMA_PROVIDER,
): Promise<Record<string, unknown>> {
  return jsonRequest(
    endpoint,
    model,
    signal,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    provider,
  );
}

/** The `ECONNREFUSED`-shaped tail of an unreachable message, when we have one. */
function describeCause(cause: unknown): string {
  if (cause === null || typeof cause !== "object") return "";
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0) return ` (${code})`;
  const message = (cause as { message?: unknown }).message;
  if (typeof message === "string" && message.length > 0) return ` (${message})`;
  return "";
}

/** Keeps an HTML error page from becoming the whole log line. */
export function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_ERROR_BODY ? flat : `${flat.slice(0, MAX_ERROR_BODY)}…`;
}

// ---------------------------------------------------------------------------
// wire marshalling
// ---------------------------------------------------------------------------

/**
 * One `ChatMessage` in the envelope Ollama's decoder actually reads.
 *
 * The nesting is the point — see fact 1 in the module header. `tool_calls` is
 * omitted when empty rather than sent as `[]`: an assistant turn with no calls
 * is not a turn that made zero calls, and Ollama's templates branch on presence.
 */
function messageToWire(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
    wire.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.tool_call_id !== undefined) wire.tool_call_id = message.tool_call_id;
  return wire;
}

/**
 * `arguments` as an object, whatever the server sent.
 *
 * Ollama emits an object; the OpenAI-compatible spelling is a JSON string, and
 * models drift. LM Studio is the OpenAI case, so on that path the string arm is
 * not a tolerance for drift but the normal reply — which is precisely why
 * `lmstudio.ts` reuses this function instead of writing a second parser that
 * would handle only the shape its author had in front of them that day. An
 * unparseable string degrades to `{}` rather than throwing:
 * §9 requires an invalid tool call to come back to the model as an error string
 * and count against the cap, and Wave 8's validation produces exactly that from
 * an empty argument set. A throw here would escape the loop as an unhandled
 * rejection and fail the whole run over one malformed turn.
 */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/**
 * `message.tool_calls` → `ChatTurn.toolCalls`.
 *
 * A missing `id` is synthesized, because `ToolCall.id` is required and Wave 8
 * answers every call with a `tool` message naming it — older Ollama builds emit
 * no id at all. The `tool_call_` prefix is deliberately not Ollama's own
 * `call_` so a synthesized id cannot collide with a real one in the same turn.
 *
 * Exported because OpenAI nests `tool_calls` identically — `{ id, type,
 * function: { name, arguments } }` — so `lmstudio.ts` reads its replies with
 * this exact function. The extra `type: "function"` key is ignored here, which
 * is correct: it carries no information a `ToolCall` has anywhere to put.
 */
export function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => {
    const record = (entry ?? {}) as { id?: unknown; function?: unknown };
    const fn = (record.function ?? {}) as { name?: unknown; arguments?: unknown };
    return {
      id: typeof record.id === "string" && record.id.length > 0 ? record.id : `tool_call_${index}`,
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: parseArguments(fn.arguments),
    };
  });
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

export function createOllamaClient(baseUrl: string = DEFAULT_OLLAMA_BASE_URL): OllamaClient {
  const root = baseUrl.replace(/\/+$/, "");

  /** `postJson` against this client's base URL — see the transport section. */
  async function post(
    path: string,
    body: Record<string, unknown>,
    model: string,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    return postJson(`${root}${path}`, body, model, signal);
  }

  /** The `response` field of a `/api/generate` reply — see fact 3 in the header. */
  function readResponse(payload: Record<string, unknown>, endpoint: string): string {
    const text = payload.response;
    if (typeof text !== "string") {
      // Not `""`. An empty string is a legitimately short answer that Wave 6
      // already routes into its retry path; a *missing* field means this is not
      // a `/api/generate` reply at all, and reporting that as empty output would
      // charge the model's repair budget for the harness's mistake.
      throw new Error(`${endpoint} returned no \`response\` field: ${truncate(stringify(payload))}`);
    }
    return text;
  }

  function generateBody(req: GenerateRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      stream: false,
    };
    if (req.system !== undefined) body.system = req.system;
    if (req.options !== undefined) body.options = req.options;
    if (req.format !== undefined) body.format = req.format;
    // Beside `options`, never inside it, and only when the caller asked. An
    // omitted `think` has to leave the key off the wire entirely rather than
    // default to `false`: Ollama's default is the model's default, and deciding
    // it here would take §7.4's per-stage choice away from every caller.
    if (req.think !== undefined) body.think = req.think;
    return body;
  }

  return {
    async listModels(): Promise<string[]> {
      const endpoint = `${root}${OLLAMA_MODELS_PATH}`;
      const payload = await jsonRequest(endpoint, "", undefined, { method: "GET" });
      const models = payload.models;
      if (!Array.isArray(models)) {
        // Not `[]`. An empty list means "Ollama is up and has nothing
        // installed", which §9's pickers would render as a quiet dead end
        // instead of the fault it is.
        throw new Error(
          `${endpoint} returned no \`models\` array: ${truncate(stringify(payload))}`,
        );
      }
      return models
        .map((entry) => (entry as { name?: unknown } | null)?.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0);
    },

    async generate(req: GenerateRequest): Promise<string> {
      const payload = await post("/api/generate", generateBody(req), req.model, req.signal);
      return readResponse(payload, `${root}/api/generate`);
    },

    async vision(req: VisionRequest): Promise<string> {
      const body = generateBody(req);
      // base64, never hex: Ollama decodes these with a base64 decoder, and a hex
      // string is still a string — it arrives, decodes to garbage, and the
      // critic reports on an image nobody drew.
      body.images = req.images.map((image) => image.toString("base64"));
      const payload = await post("/api/generate", body, req.model, req.signal);
      return readResponse(payload, `${root}/api/generate`);
    },

    async chatWithTools(req: ChatWithToolsRequest): Promise<ChatTurn> {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages.map(messageToWire),
        tools: req.tools,
        stream: false,
      };
      if (req.options !== undefined) body.options = req.options;
      if (req.format !== undefined) body.format = req.format;
      // Top-level, as on `/api/generate` — the capture reproduced the same
      // result on `/api/chat`, and this is the endpoint the 40-turn revise loop
      // runs on.
      if (req.think !== undefined) body.think = req.think;

      const payload = await post("/api/chat", body, req.model, req.signal);
      const message = payload.message;
      if (message === null || typeof message !== "object") {
        throw new Error(
          `${root}/api/chat returned no \`message\`: ${truncate(stringify(payload))}`,
        );
      }
      const { content, tool_calls: toolCalls } = message as {
        content?: unknown;
        tool_calls?: unknown;
      };
      return {
        content: typeof content === "string" ? content : "",
        toolCalls: parseToolCalls(toolCalls),
      };
    },
  };
}

/** `JSON.stringify` that cannot itself throw on a circular or exotic payload. */
export function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
