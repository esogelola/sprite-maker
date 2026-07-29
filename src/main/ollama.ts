/**
 * The Ollama client — spec §6.9, and **the only place in this app HTTP happens**
 * (spec §5.2).
 *
 * Every other module accepts the `OllamaClient` interface rather than a URL, so
 * the whole harness runs against a scripted stub with Ollama stopped, and a
 * future hosted adapter is a one-file change. Wave 5's acceptance criterion 6 is
 * a grep: `fetch(`, `http.request` and `axios` appear nowhere else under `src/`.
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

/** How much of an unexpected error body is worth carrying in a message. */
const MAX_ERROR_BODY = 400;

// ---------------------------------------------------------------------------
// requests — spec §6.9
// ---------------------------------------------------------------------------

export interface GenerateRequest {
  model: string;
  system?: string;
  prompt: string;
  /** Ollama's own option bag — `temperature`, `seed`, `num_predict`, … */
  options?: Record<string, unknown>;
  /** `"json"` constrains the model to valid JSON. */
  format?: string;
  signal?: AbortSignal;
}

/** `generate` plus the images §4.4 requires the critic to see. */
export interface VisionRequest extends GenerateRequest {
  images: Buffer[];
}

export interface ChatWithToolsRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface OllamaClient {
  listModels(): Promise<string[]>;
  generate(req: GenerateRequest): Promise<string>;
  vision(req: VisionRequest): Promise<string>;
  chatWithTools(req: ChatWithToolsRequest): Promise<ChatTurn>;
}

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
    options?: { cause?: unknown },
  ) {
    const reason = describeCause(options?.cause);
    super(`Ollama is unreachable at ${endpoint}${reason}`, options);
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
  ) {
    super(`Ollama call to ${model} was aborted after ${Math.round(elapsedMs)}ms`);
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
  ) {
    const hint =
      status === 404 && model.length > 0
        ? ` — if the model is not installed, run \`ollama pull ${model}\``
        : "";
    super(`Ollama returned ${status} from ${endpoint}: ${truncate(body)}${hint}`);
  }
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
function truncate(text: string): string {
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
 * `arguments` as an object, whatever Ollama sent.
 *
 * Ollama emits an object; the OpenAI-compatible spelling is a JSON string, and
 * models drift. An unparseable string degrades to `{}` rather than throwing:
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
 */
function parseToolCalls(raw: unknown): ToolCall[] {
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

  /**
   * One request, with §6.9's two failure modes separated.
   *
   * The abort check comes first and is made against the *signal*, not against
   * the error: an aborted `fetch` rejects with a `TypeError` that is otherwise
   * indistinguishable from a connection failure, and calling a timeout
   * "unreachable" would put the wrong cause in the status bar and in
   * `SessionHistory.error`. Everything else that throws before a response
   * arrives — refused, reset, DNS — is unreachable, which is what it means to
   * the user regardless of the errno.
   */
  async function post(
    path: string,
    body: Record<string, unknown>,
    model: string,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    return request(path, model, signal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function request(
    path: string,
    model: string,
    signal: AbortSignal | undefined,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    const endpoint = `${root}${path}`;
    const started = performance.now();

    let response: Response;
    try {
      response = await fetch(endpoint, { ...init, signal });
    } catch (cause) {
      if (signal?.aborted === true) {
        throw new OllamaTimeoutError(model, performance.now() - started);
      }
      throw new OllamaUnreachableError(endpoint, { cause });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OllamaHttpError(endpoint, response.status, model, body);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      // The body can still be cut off mid-read — the abort has to be checked
      // again here, not only around the headers.
      if (signal?.aborted === true) {
        throw new OllamaTimeoutError(model, performance.now() - started);
      }
      throw new OllamaUnreachableError(endpoint, { cause });
    }

    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`${endpoint} returned ${JSON.stringify(payload)}, expected a JSON object`);
    }
    return payload as Record<string, unknown>;
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
    return body;
  }

  return {
    async listModels(): Promise<string[]> {
      const endpoint = `${root}/api/tags`;
      const payload = await request("/api/tags", "", undefined, { method: "GET" });
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
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
