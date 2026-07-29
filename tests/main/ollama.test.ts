/**
 * `main/ollama.ts` and the Wave 5 stub — spec §6.9, plan Wave 5.
 *
 * **Every HTTP test runs against a real `http.createServer`, never a `fetch`
 * mock.** A mock asserts that the client agrees with the test author's idea of
 * the wire format; a server asserts what actually goes down the socket. The
 * distinction is not academic here — `docs/superpowers/specs/captures/
 * 2026-07-29-wave-5-tool-call-wire-format.txt` records a live probe in which
 * `tool_calls` marshalled flat as `{ id, name, arguments }` is silently dropped
 * by Ollama's decoder, the chat template renders nothing, and the model
 * re-issues the call it already made. Both spellings are valid JSON and both
 * satisfy `ChatMessage`; only the socket can tell them apart.
 *
 * The server fixture therefore records the *parsed request body* and the tests
 * assert on it directly, so a marshalling change is a test failure rather than a
 * Wave 8 turn-cap mystery.
 */

import {
  createServer,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOllamaClient,
  DEFAULT_OLLAMA_BASE_URL,
  OllamaHttpError,
  OllamaTimeoutError,
  OllamaUnreachableError,
} from "@main/ollama";
import type { ChatMessage, ChatTurn, ToolDef } from "@shared/schema";

import { createStubClient } from "../stubs/ollama";

// ---------------------------------------------------------------------------
// the HTTP fixture
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  contentType: string | undefined;
  /** Exactly the bytes that arrived, before any parsing. */
  raw: string;
  /** `raw` as JSON, or `{}` when it was not JSON. */
  body: Record<string, unknown>;
}

interface Fixture {
  baseUrl: string;
  requests: CapturedRequest[];
}

type Handler = (captured: CapturedRequest, res: ServerResponse) => void;

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          // A hanging-response test leaves a live socket; without this the close
          // callback never fires and the suite stalls rather than failing.
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(handler: Handler): Promise<Fixture> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = {};
        }
      }
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        contentType: req.headers["content-type"],
        raw,
        body,
      };
      requests.push(captured);
      handler(captured, res);
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

/** Answers every request with the same JSON payload. */
function replyJson(payload: unknown, status = 200): Handler {
  return (_captured, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
}

/** Answers the nth request with the nth payload; the last is reused. */
function replySequence(payloads: readonly unknown[]): Handler {
  let n = 0;
  return (_captured, res) => {
    const payload = payloads[Math.min(n, payloads.length - 1)];
    n++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
}

/** Accepts the request and never answers it — the abort fixture. */
const hang: Handler = () => {};

/**
 * Answers with headers and half a body, then stops.
 *
 * A separate fixture from `hang` because the two exercise different code: the
 * abort can fire while `fetch` is still waiting on headers, or later, while the
 * body is being read. A critique that runs out its 480s budget mid-stream takes
 * the second path, and only this fixture reaches it.
 */
const hangMidBody: Handler = (_captured, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.write('{"response":"par');
};

/**
 * A base URL nothing is listening on.
 *
 * Bound and released rather than guessed, so the port is known-free on this
 * machine at this moment instead of merely unlikely.
 */
async function closedPortBaseUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------
// shared data
// ---------------------------------------------------------------------------

const PLACE_PIXEL: ToolDef = {
  type: "function",
  function: {
    name: "place_pixel",
    description: "Set one pixel.",
    parameters: {
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" }, index: { type: "integer" } },
      required: ["x", "y", "index"],
    },
  },
};

const DONE: ToolDef = {
  type: "function",
  function: { name: "done", description: "Finish.", parameters: { type: "object", properties: {} } },
};

/** Ollama's own response envelope for one tool call — see the wire-format capture. */
function wireToolCall(
  name: string,
  args: Record<string, unknown>,
  id?: string,
): Record<string, unknown> {
  const call: Record<string, unknown> = { function: { index: 0, name, arguments: args } };
  if (id !== undefined) call.id = id;
  return call;
}

// ---------------------------------------------------------------------------
// base URL
// ---------------------------------------------------------------------------

describe("createOllamaClient — base URL", () => {
  it("defaults to the loopback address Ollama binds", () => {
    // 127.0.0.1 rather than `localhost`: on macOS `localhost` resolves to `::1`
    // first and every call pays a connection-refused round trip before falling
    // back to IPv4.
    expect(DEFAULT_OLLAMA_BASE_URL).toBe("http://127.0.0.1:11434");
  });

  it("does not double the separator when the base URL ends in a slash", async () => {
    const fixture = await startServer(replyJson({ models: [] }));
    const client = createOllamaClient(`${fixture.baseUrl}/`);
    await client.listModels();
    expect(fixture.requests[0].url).toBe("/api/tags");
  });

  it("honours a non-default base URL", async () => {
    const fixture = await startServer(replyJson({ response: "ok" }));
    const client = createOllamaClient(fixture.baseUrl);
    expect(await client.generate({ model: "m", prompt: "p" })).toBe("ok");
    expect(fixture.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

describe("listModels", () => {
  it("GETs /api/tags and returns the names in order", async () => {
    const fixture = await startServer(
      replyJson({
        models: [
          { name: "qwen3:8b", size: 5225388164 },
          { name: "qwen3-vl:8b-instruct-q4_K_M", size: 6140415975 },
        ],
      }),
    );
    const models = await createOllamaClient(fixture.baseUrl).listModels();

    expect(models).toEqual(["qwen3:8b", "qwen3-vl:8b-instruct-q4_K_M"]);
    expect(fixture.requests[0].method).toBe("GET");
    expect(fixture.requests[0].url).toBe("/api/tags");
    expect(fixture.requests[0].raw).toBe("");
  });

  it("returns an empty list when no models are installed", async () => {
    const fixture = await startServer(replyJson({ models: [] }));
    expect(await createOllamaClient(fixture.baseUrl).listModels()).toEqual([]);
  });

  it("skips an entry with no usable name rather than emitting undefined", async () => {
    // A name is the only thing `bind()` can be given, so a nameless entry is not
    // a model this app can offer — but it must not become `undefined` in a
    // picker either.
    const fixture = await startServer(
      replyJson({ models: [{ name: "qwen3:8b" }, { size: 1 }, { name: "" }] }),
    );
    expect(await createOllamaClient(fixture.baseUrl).listModels()).toEqual(["qwen3:8b"]);
  });

  it("throws naming the endpoint when the payload has no models array", async () => {
    const fixture = await startServer(replyJson({ error: "something else entirely" }));
    const client = createOllamaClient(fixture.baseUrl);

    // Not `[]`: an empty list means "Ollama is up and has nothing installed",
    // which the pickers would render as a legitimate, quiet dead end.
    await expect(client.listModels()).rejects.toThrow(`${fixture.baseUrl}/api/tags`);
  });
});

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

describe("generate", () => {
  it("POSTs /api/generate with stream disabled", async () => {
    const fixture = await startServer(replyJson({ response: "rows" }));
    await createOllamaClient(fixture.baseUrl).generate({ model: "qwen3:8b", prompt: "draw a fox" });

    const request = fixture.requests[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/generate");
    expect(request.contentType).toBe("application/json");
    // `stream: false` is the whole difference between one JSON object and a
    // newline-delimited stream this client does not parse. Ollama's default is
    // to stream, so omitting the field is not a smaller request — it is a
    // different protocol.
    expect(request.body.stream).toBe(false);
    expect(request.body.model).toBe("qwen3:8b");
    expect(request.body.prompt).toBe("draw a fox");
  });

  it("sends only the fields the caller supplied", async () => {
    const fixture = await startServer(replyJson({ response: "rows" }));
    await createOllamaClient(fixture.baseUrl).generate({ model: "qwen3:8b", prompt: "p" });

    expect(Object.keys(fixture.requests[0].body).sort()).toEqual(["model", "prompt", "stream"]);
  });

  it("forwards system, options and format verbatim", async () => {
    const fixture = await startServer(replyJson({ response: "rows" }));
    await createOllamaClient(fixture.baseUrl).generate({
      model: "qwen3:8b",
      system: "You draw pixel art.",
      prompt: "p",
      options: { temperature: 0, seed: 7, num_predict: 1200 },
      format: "json",
    });

    const { body } = fixture.requests[0];
    expect(body.system).toBe("You draw pixel art.");
    expect(body.options).toEqual({ temperature: 0, seed: 7, num_predict: 1200 });
    expect(body.format).toBe("json");
  });

  it("returns the response field verbatim", async () => {
    const fixture = await startServer(replyJson({ response: '{"rows":["....","...."]}' }));
    const text = await createOllamaClient(fixture.baseUrl).generate({ model: "m", prompt: "p" });
    expect(text).toBe('{"rows":["....","...."]}');
  });

  it("returns an empty response rather than treating it as a fault", async () => {
    // Reachable: with a thinking model the whole turn can land in `thinking` and
    // leave `response` empty when generation is cut short. That is a short
    // answer, not a broken server, and Wave 6 already routes an unparseable
    // draft through its retry path.
    const fixture = await startServer(replyJson({ response: "", thinking: "..." }));
    expect(await createOllamaClient(fixture.baseUrl).generate({ model: "m", prompt: "p" })).toBe("");
  });

  it("ignores the thinking channel", async () => {
    // The reasoning trace is not the answer. Falling back to it would hand Wave
    // 6's `parseDraft` a monologue and charge the repair budget for it.
    const fixture = await startServer(replyJson({ response: "PONG", thinking: "Let me see..." }));
    expect(await createOllamaClient(fixture.baseUrl).generate({ model: "m", prompt: "p" })).toBe(
      "PONG",
    );
  });

  it("throws naming the endpoint when the payload has no response field", async () => {
    const fixture = await startServer(replyJson({ unexpected: true }));
    await expect(
      createOllamaClient(fixture.baseUrl).generate({ model: "m", prompt: "p" }),
    ).rejects.toThrow(`${fixture.baseUrl}/api/generate`);
  });

  it("does not substitute thinking for a missing response", async () => {
    // The tempting fallback — `payload.response ?? payload.thinking` — is
    // invisible until a reply arrives with only a reasoning trace, and then it
    // hands Wave 6's `parseDraft` a monologue that `normalize` charges the full
    // canvas of repairs for. The retry prompt would then complain about rows the
    // model never claimed to emit.
    const fixture = await startServer(replyJson({ thinking: "Let me consider the fox..." }));
    await expect(
      createOllamaClient(fixture.baseUrl).generate({ model: "m", prompt: "p" }),
    ).rejects.toThrow(`${fixture.baseUrl}/api/generate`);
  });
});

// ---------------------------------------------------------------------------
// vision
// ---------------------------------------------------------------------------

describe("vision", () => {
  const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
  const OTHER = Buffer.from([0x01, 0x02, 0x03]);

  it("base64-encodes each image and preserves order", async () => {
    const fixture = await startServer(replyJson({ response: "{}" }));
    await createOllamaClient(fixture.baseUrl).vision({
      model: "qwen3-vl:8b-instruct-q4_K_M",
      prompt: "what is this",
      images: [IMAGE, OTHER],
    });

    const images = fixture.requests[0].body.images as string[];
    // Spelled out rather than compared to another call of `toString("base64")`:
    // hex, base64url and base64 are all plausible-looking strings, and only one
    // of them is what Ollama decodes.
    expect(images).toEqual(["iVBORw0KGgr/AA==", "AQID"]);
  });

  it("round-trips the exact bytes it was given", async () => {
    const fixture = await startServer(replyJson({ response: "{}" }));
    await createOllamaClient(fixture.baseUrl).vision({
      model: "m",
      prompt: "p",
      images: [IMAGE],
    });

    const [encoded] = fixture.requests[0].body.images as string[];
    expect(Buffer.from(encoded, "base64").equals(IMAGE)).toBe(true);
  });

  it("POSTs /api/generate with stream disabled", async () => {
    const fixture = await startServer(replyJson({ response: "{}" }));
    await createOllamaClient(fixture.baseUrl).vision({ model: "m", prompt: "p", images: [IMAGE] });

    expect(fixture.requests[0].method).toBe("POST");
    expect(fixture.requests[0].url).toBe("/api/generate");
    expect(fixture.requests[0].body.stream).toBe(false);
  });

  it("forwards options and format — spec §6.9", async () => {
    const fixture = await startServer(replyJson({ response: "{}" }));
    await createOllamaClient(fixture.baseUrl).vision({
      model: "qwen3-vl:8b-instruct-q4_K_M",
      system: "You review pixel art.",
      prompt: "critique",
      images: [IMAGE],
      options: { temperature: 0, seed: 11 },
      format: "json",
    });

    const { body } = fixture.requests[0];
    // Without these the bench cannot be seeded, so the instrument that exists to
    // tune `confidenceFloor` produces a different number every run no matter
    // what the config records.
    expect(body.options).toEqual({ temperature: 0, seed: 11 });
    expect(body.format).toBe("json");
    expect(body.system).toBe("You review pixel art.");
  });

  it("always sends an images key, even for an empty list", async () => {
    const fixture = await startServer(replyJson({ response: "{}" }));
    await createOllamaClient(fixture.baseUrl).vision({ model: "m", prompt: "p", images: [] });
    expect(fixture.requests[0].body.images).toEqual([]);
  });

  it("returns the response field", async () => {
    const fixture = await startServer(replyJson({ response: '{"overall":4}' }));
    const text = await createOllamaClient(fixture.baseUrl).vision({
      model: "m",
      prompt: "p",
      images: [IMAGE],
    });
    expect(text).toBe('{"overall":4}');
  });
});

// ---------------------------------------------------------------------------
// chatWithTools — the highest wire-format risk in the project
// ---------------------------------------------------------------------------

describe("chatWithTools", () => {
  it("POSTs /api/chat with stream disabled and the tools verbatim", async () => {
    const fixture = await startServer(replyJson({ message: { role: "assistant", content: "hi" } }));
    await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "qwen3:8b",
      messages: [{ role: "user", content: "start" }],
      tools: [PLACE_PIXEL, DONE],
    });

    const request = fixture.requests[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/chat");
    expect(request.body.stream).toBe(false);
    expect(request.body.model).toBe("qwen3:8b");
    expect(request.body.tools).toEqual([PLACE_PIXEL, DONE]);
  });

  it("forwards options", async () => {
    const fixture = await startServer(replyJson({ message: { content: "" } }));
    await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [{ role: "user", content: "u" }],
      tools: [],
      options: { temperature: 0, seed: 3 },
    });
    expect(fixture.requests[0].body.options).toEqual({ temperature: 0, seed: 3 });
  });

  it("marshals an assistant turn's tool_calls into Ollama's nested envelope", async () => {
    const fixture = await startServer(replyJson({ message: { content: "ok" } }));
    const messages: ChatMessage[] = [
      { role: "user", content: "fix row 4" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", name: "place_pixel", arguments: { x: 3, y: 4, index: 2 } }],
      },
      { role: "tool", content: "ok", tool_call_id: "call_1" },
    ];
    await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "qwen3:8b",
      messages,
      tools: [PLACE_PIXEL],
    });

    // The single most load-bearing assertion in Wave 5. The live probe in
    // `captures/2026-07-29-wave-5-tool-call-wire-format.txt` shows that the flat
    // spelling — `{ id, name, arguments }`, which is exactly what `ToolCall`
    // looks like — is dropped by Ollama's decoder, so the chat template renders
    // no tool call and the model re-issues the one it already made. Both
    // spellings are valid JSON; only this assertion separates them.
    expect(fixture.requests[0].body.messages).toEqual([
      { role: "user", content: "fix row 4" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", function: { name: "place_pixel", arguments: { x: 3, y: 4, index: 2 } } },
        ],
      },
      { role: "tool", content: "ok", tool_call_id: "call_1" },
    ]);
  });

  it("does not leave the flat spelling on the wire alongside the nested one", async () => {
    const fixture = await startServer(replyJson({ message: { content: "ok" } }));
    await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "c", name: "done", arguments: {} }] },
      ],
      tools: [],
    });

    const [assistant] = fixture.requests[0].body.messages as Array<Record<string, unknown>>;
    const [call] = assistant.tool_calls as Array<Record<string, unknown>>;
    expect(Object.keys(call).sort()).toEqual(["function", "id"]);
  });

  it("omits tool_calls entirely when a message carries none", async () => {
    const fixture = await startServer(replyJson({ message: { content: "ok" } }));
    await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [
        { role: "user", content: "u" },
        { role: "assistant", content: "a", tool_calls: [] },
      ],
      tools: [],
    });

    const messages = fixture.requests[0].body.messages as Array<Record<string, unknown>>;
    expect(Object.keys(messages[0]).sort()).toEqual(["content", "role"]);
    expect(Object.keys(messages[1]).sort()).toEqual(["content", "role"]);
  });

  it("maps message.tool_calls to ChatTurn.toolCalls with id, name and arguments", async () => {
    const fixture = await startServer(
      replyJson({
        message: {
          role: "assistant",
          content: "placing",
          tool_calls: [
            wireToolCall("place_pixel", { x: 3, y: 4, index: 2 }, "call_d6c0jeub"),
            wireToolCall("done", { summary: "tidied the outline" }, "call_9zz"),
          ],
        },
      }),
    );

    const turn = await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [{ role: "user", content: "u" }],
      tools: [PLACE_PIXEL, DONE],
    });

    expect(turn).toEqual({
      content: "placing",
      toolCalls: [
        { id: "call_d6c0jeub", name: "place_pixel", arguments: { x: 3, y: 4, index: 2 } },
        { id: "call_9zz", name: "done", arguments: { summary: "tidied the outline" } },
      ],
    } satisfies ChatTurn);
  });

  it("parses arguments that arrive as a JSON string", async () => {
    // Ollama hands back an object, but the OpenAI-compatible spelling is a
    // string and models drift. Wave 8 coerces numeric *values*; it should not
    // also have to guess whether it holds an object at all.
    const fixture = await startServer(
      replyJson({
        message: {
          content: "",
          tool_calls: [{ id: "c1", function: { name: "place_pixel", arguments: '{"x":1,"y":2}' } }],
        },
      }),
    );
    const turn = await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
    });
    expect(turn.toolCalls[0].arguments).toEqual({ x: 1, y: 2 });
  });

  it("degrades unparseable arguments to an empty object rather than throwing", async () => {
    // Spec §9: an invalid tool call is answered with an error string and counts
    // against the cap. A throw here would escape Wave 8's loop as an unhandled
    // rejection and take the whole run to FAILED over one malformed turn.
    const fixture = await startServer(
      replyJson({
        message: {
          content: "",
          tool_calls: [{ id: "c1", function: { name: "place_pixel", arguments: "{x:" } }],
        },
      }),
    );
    const turn = await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
    });
    expect(turn.toolCalls).toEqual([{ id: "c1", name: "place_pixel", arguments: {} }]);
  });

  it("synthesizes a stable id when the response omits one", async () => {
    // `ToolCall.id` is required, and Wave 8 answers each call with a `tool`
    // message naming it. Older Ollama builds emit no id at all.
    const fixture = await startServer(
      replyJson({
        message: {
          content: "",
          tool_calls: [
            wireToolCall("place_pixel", { x: 1 }),
            wireToolCall("place_pixel", { x: 2 }),
          ],
        },
      }),
    );
    const turn = await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
    });
    expect(turn.toolCalls.map((c) => c.id)).toEqual(["tool_call_0", "tool_call_1"]);
  });

  it("keeps a supplied id and synthesizes only the missing one", async () => {
    const fixture = await startServer(
      replyJson({
        message: {
          content: "",
          tool_calls: [wireToolCall("done", {}, "call_real"), wireToolCall("done", {})],
        },
      }),
    );
    const turn = await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
    });
    expect(turn.toolCalls.map((c) => c.id)).toEqual(["call_real", "tool_call_1"]);
  });

  it("yields an empty toolCalls array when the model only spoke", async () => {
    const fixture = await startServer(
      replyJson({ message: { role: "assistant", content: "I am thinking about it." } }),
    );
    const turn = await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
    });
    // Wave 8 counts this turn against the cap and injects a nudge, which it can
    // only do if the empty case is a value rather than an error.
    expect(turn).toEqual({ content: "I am thinking about it.", toolCalls: [] });
  });

  it("yields an empty content string when the model only called tools", async () => {
    const fixture = await startServer(
      replyJson({ message: { role: "assistant", tool_calls: [wireToolCall("done", {}, "c")] } }),
    );
    const turn = await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
    });
    expect(turn.content).toBe("");
  });

  it("ignores the assistant's thinking channel", async () => {
    const fixture = await startServer(
      replyJson({ message: { role: "assistant", content: "DONE", thinking: "Let me check..." } }),
    );
    const turn = await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
    });
    expect(turn.content).toBe("DONE");
  });

  it("leaves content empty rather than promoting thinking into it", async () => {
    // This is the *common* live shape, not an edge case: a turn that only calls
    // tools comes back with `content: ""` and a full reasoning trace beside it.
    // Promoting the trace would append the model's internal monologue to Wave
    // 8's transcript on every tool-calling turn, and land it in `revise.summary`
    // — the most legible per-round artifact in the system.
    const fixture = await startServer(
      replyJson({
        message: {
          role: "assistant",
          content: "",
          thinking: "The user asked for a pixel at 3,4. I should call place_pixel.",
          tool_calls: [wireToolCall("place_pixel", { x: 3, y: 4, index: 2 }, "call_1")],
        },
      }),
    );
    const turn = await createOllamaClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
    });

    expect(turn.content).toBe("");
    expect(turn.toolCalls).toHaveLength(1);
  });

  it("throws naming the endpoint when the payload carries no message", async () => {
    const fixture = await startServer(replyJson({ done: true }));
    await expect(
      createOllamaClient(fixture.baseUrl).chatWithTools({ model: "m", messages: [], tools: [] }),
    ).rejects.toThrow(`${fixture.baseUrl}/api/chat`);
  });

  it("round-trips a tool call: the reply becomes the next request's transcript", async () => {
    // Wave 5 acceptance criterion 3, and the shape of every Wave 8 turn.
    const fixture = await startServer(
      replySequence([
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [wireToolCall("place_pixel", { x: 3, y: 4, index: 2 }, "call_1")],
          },
        },
        { message: { role: "assistant", content: "DONE" } },
      ]),
    );
    const client = createOllamaClient(fixture.baseUrl);

    const messages: ChatMessage[] = [{ role: "user", content: "fix the outline" }];
    const first = await client.chatWithTools({ model: "qwen3:8b", messages, tools: [PLACE_PIXEL] });

    // Exactly what `revise.ts` will do: append the assistant's own turn,
    // including the call it made, then the tool result.
    messages.push({ role: "assistant", content: first.content, tool_calls: first.toolCalls });
    messages.push({ role: "tool", content: "ok", tool_call_id: first.toolCalls[0].id });

    const second = await client.chatWithTools({ model: "qwen3:8b", messages, tools: [PLACE_PIXEL] });

    expect(second).toEqual({ content: "DONE", toolCalls: [] } satisfies ChatTurn);
    expect(fixture.requests[1].body.messages).toEqual([
      { role: "user", content: "fix the outline" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", function: { name: "place_pixel", arguments: { x: 3, y: 4, index: 2 } } },
        ],
      },
      { role: "tool", content: "ok", tool_call_id: "call_1" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// errors — spec §6.9, §9
// ---------------------------------------------------------------------------

describe("OllamaUnreachableError", () => {
  it("names the exact endpoint when /api/generate refuses the connection", async () => {
    const baseUrl = await closedPortBaseUrl();
    const client = createOllamaClient(baseUrl);

    const error = await client.generate({ model: "m", prompt: "p" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaUnreachableError);
    // §8 has the status bar name the exact endpoint, and §9 keeps it a separate
    // field because `ipcMain.handle` destroys an error's own properties. Both
    // require the field to exist and the message to carry it.
    expect((error as OllamaUnreachableError).endpoint).toBe(`${baseUrl}/api/generate`);
    expect((error as OllamaUnreachableError).message).toContain(`${baseUrl}/api/generate`);
  });

  it("names /api/tags for listModels", async () => {
    const baseUrl = await closedPortBaseUrl();
    const error = await createOllamaClient(baseUrl)
      .listModels()
      .catch((e: unknown) => e);
    expect((error as OllamaUnreachableError).endpoint).toBe(`${baseUrl}/api/tags`);
  });

  it("names /api/chat for chatWithTools", async () => {
    const baseUrl = await closedPortBaseUrl();
    const error = await createOllamaClient(baseUrl)
      .chatWithTools({ model: "m", messages: [], tools: [] })
      .catch((e: unknown) => e);
    expect((error as OllamaUnreachableError).endpoint).toBe(`${baseUrl}/api/chat`);
  });

  it("names /api/generate for vision", async () => {
    const baseUrl = await closedPortBaseUrl();
    const error = await createOllamaClient(baseUrl)
      .vision({ model: "m", prompt: "p", images: [] })
      .catch((e: unknown) => e);
    expect((error as OllamaUnreachableError).endpoint).toBe(`${baseUrl}/api/generate`);
  });

  it("carries a name Wave 9 can serialize into SessionHistory.error", async () => {
    const baseUrl = await closedPortBaseUrl();
    const error = (await createOllamaClient(baseUrl)
      .generate({ model: "m", prompt: "p" })
      .catch((e: unknown) => e)) as Error;

    // §6.7 stores a flat `"<ErrorName>: <message>"`, which is the only place the
    // endpoint survives a reload.
    expect(error.name).toBe("OllamaUnreachableError");
    expect(`${error.name}: ${error.message}`).toContain(`${baseUrl}/api/generate`);
  });

  it("preserves the underlying cause", async () => {
    const baseUrl = await closedPortBaseUrl();
    const error = (await createOllamaClient(baseUrl)
      .generate({ model: "m", prompt: "p" })
      .catch((e: unknown) => e)) as OllamaUnreachableError;
    expect(error.cause).toBeDefined();
  });
});

describe("OllamaTimeoutError", () => {
  it("surfaces an in-flight abort as a timeout carrying the model and elapsed ms", async () => {
    const fixture = await startServer(hang);
    const client = createOllamaClient(fixture.baseUrl);

    const started = performance.now();
    const error = await client
      .generate({ model: "qwen3:8b", prompt: "p", signal: AbortSignal.timeout(40) })
      .catch((e: unknown) => e);
    const wallClock = performance.now() - started;

    expect(error).toBeInstanceOf(OllamaTimeoutError);
    const timeout = error as OllamaTimeoutError;
    expect(timeout.model).toBe("qwen3:8b");
    // §9 shows the elapsed time in the UI, so it has to be the call's own
    // duration rather than a placeholder.
    expect(Number.isFinite(timeout.elapsedMs)).toBe(true);
    expect(timeout.elapsedMs).toBeGreaterThanOrEqual(30);
    expect(timeout.elapsedMs).toBeLessThanOrEqual(wallClock + 50);
    expect(timeout.message).toContain("qwen3:8b");
    expect(timeout.name).toBe("OllamaTimeoutError");
  });

  it("reports the critic model for an aborted vision call", async () => {
    const fixture = await startServer(hang);
    const error = await createOllamaClient(fixture.baseUrl)
      .vision({
        model: "qwen3-vl:8b-instruct-q4_K_M",
        prompt: "p",
        images: [Buffer.from([1])],
        signal: AbortSignal.timeout(30),
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaTimeoutError);
    expect((error as OllamaTimeoutError).model).toBe("qwen3-vl:8b-instruct-q4_K_M");
  });

  it("reports a timeout for an aborted chatWithTools turn", async () => {
    const fixture = await startServer(hang);
    const error = await createOllamaClient(fixture.baseUrl)
      .chatWithTools({
        model: "qwen3:8b",
        messages: [{ role: "user", content: "u" }],
        tools: [],
        signal: AbortSignal.timeout(30),
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaTimeoutError);
    expect((error as OllamaTimeoutError).model).toBe("qwen3:8b");
  });

  it("reports a timeout when the abort lands while the body is being read", async () => {
    // Headers arrive, the body does not. Checking the signal only around `fetch`
    // leaves this path reporting "Ollama is unreachable" for a server that
    // answered — which is the wrong cause in the status bar and the wrong
    // string in `SessionHistory.error`.
    const fixture = await startServer(hangMidBody);
    const error = await createOllamaClient(fixture.baseUrl)
      .generate({ model: "qwen3:8b", prompt: "p", signal: AbortSignal.timeout(40) })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaTimeoutError);
    expect((error as OllamaTimeoutError).model).toBe("qwen3:8b");
    expect((error as OllamaTimeoutError).elapsedMs).toBeGreaterThanOrEqual(30);
  });

  it("reports a timeout — not an unreachable — for an already-aborted signal", async () => {
    // A signal that fired while an earlier stage was running still means "we ran
    // out of time", and calling it unreachable would put the wrong cause in the
    // status bar and in `SessionHistory.error`.
    const fixture = await startServer(replyJson({ response: "never read" }));
    const error = await createOllamaClient(fixture.baseUrl)
      .generate({ model: "qwen3:8b", prompt: "p", signal: AbortSignal.abort() })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaTimeoutError);
    expect((error as OllamaTimeoutError).elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("does not abort a call whose signal never fires", async () => {
    const controller = new AbortController();
    const fixture = await startServer(replyJson({ response: "fine" }));
    const text = await createOllamaClient(fixture.baseUrl).generate({
      model: "m",
      prompt: "p",
      signal: controller.signal,
    });
    expect(text).toBe("fine");
  });
});

describe("OllamaHttpError", () => {
  it("reports a 404 with the status, the endpoint and the model", async () => {
    const fixture = await startServer(replyJson({ error: 'model "ghost:7b" not found' }, 404));
    const error = await createOllamaClient(fixture.baseUrl)
      .generate({ model: "ghost:7b", prompt: "p" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaHttpError);
    const http = error as OllamaHttpError;
    expect(http.status).toBe(404);
    expect(http.endpoint).toBe(`${fixture.baseUrl}/api/generate`);
    expect(http.model).toBe("ghost:7b");
    // §9: a bound model that is not installed must name the command that fixes
    // it. The client is the only layer that sees the 404.
    expect(http.message).toContain("ollama pull ghost:7b");
    expect(http.name).toBe("OllamaHttpError");
    // The fields above survive in-process; the *message* is what survives IPC
    // and a reload, because §6.7 flattens the error to one string. Both facts
    // have to be in it.
    expect(http.message).toContain("404");
    expect(http.message).toContain(`${fixture.baseUrl}/api/generate`);
  });

  it("reports a 500 without inventing a pull command", async () => {
    const fixture = await startServer(replyJson({ error: "out of memory" }, 500));
    const error = await createOllamaClient(fixture.baseUrl)
      .chatWithTools({ model: "qwen3:8b", messages: [], tools: [] })
      .catch((e: unknown) => e);

    const http = error as OllamaHttpError;
    expect(http.status).toBe(500);
    expect(http.message).toContain("500");
    expect(http.message).toContain(`${fixture.baseUrl}/api/chat`);
    expect(http.message).toContain("out of memory");
    expect(http.message).not.toContain("ollama pull");
  });

  it("truncates a runaway error body", async () => {
    const fixture = await startServer((_captured, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("x".repeat(5000));
    });
    const error = (await createOllamaClient(fixture.baseUrl)
      .listModels()
      .catch((e: unknown) => e)) as OllamaHttpError;

    expect(error.message.length).toBeLessThan(800);
    expect(error.message).toContain("…");
  });
});

// ---------------------------------------------------------------------------
// the stub — Waves 6, 7, 8 and 9 assert against this surface
// ---------------------------------------------------------------------------

describe("createStubClient", () => {
  it("consumes the generate queue in order and reuses the last entry", async () => {
    const stub = createStubClient({ generate: ["first", "second"] });
    const seen = [
      await stub.generate({ model: "m", prompt: "p" }),
      await stub.generate({ model: "m", prompt: "p" }),
      await stub.generate({ model: "m", prompt: "p" }),
    ];
    expect(seen).toEqual(["first", "second", "second"]);
  });

  it("consumes the vision queue in order — Wave 7's malformed-then-valid pair", async () => {
    const stub = createStubClient({ vision: ["not json at all", '{"overall":4,"issues":[]}'] });
    expect(await stub.vision({ model: "m", prompt: "p", images: [] })).toBe("not json at all");
    expect(await stub.vision({ model: "m", prompt: "p", images: [] })).toBe(
      '{"overall":4,"issues":[]}',
    );
  });

  it("consumes the chatWithTools queue in order", async () => {
    const place: ChatTurn = {
      content: "",
      toolCalls: [{ id: "c1", name: "place_pixel", arguments: { x: 1, y: 2, index: 3 } }],
    };
    const finish: ChatTurn = { content: "done", toolCalls: [] };
    const stub = createStubClient({ chatWithTools: [place, finish] });

    expect(await stub.chatWithTools({ model: "m", messages: [], tools: [] })).toEqual(place);
    expect(await stub.chatWithTools({ model: "m", messages: [], tools: [] })).toEqual(finish);
  });

  it("keeps a one-entry chat queue answering forever — Wave 8's turn-cap fixture", async () => {
    const nudgeable: ChatTurn = { content: "thinking", toolCalls: [] };
    const stub = createStubClient({ chatWithTools: [nudgeable] });
    for (let turn = 0; turn < 40; turn++) {
      await stub.chatWithTools({ model: "m", messages: [], tools: [] });
    }
    expect(stub.calls).toHaveLength(40);
  });

  it("records model, prompt, system, options and format for generate", async () => {
    const stub = createStubClient({ generate: ["ok"] });
    await stub.generate({
      model: "qwen3:8b",
      system: "s",
      prompt: "p",
      options: { seed: 1 },
      format: "json",
    });
    expect(stub.calls).toEqual([
      {
        method: "generate",
        model: "qwen3:8b",
        system: "s",
        prompt: "p",
        options: { seed: 1 },
        format: "json",
      },
    ]);
  });

  it("leaves an unsupplied field absent rather than undefined", async () => {
    const stub = createStubClient({ generate: ["ok"] });
    await stub.generate({ model: "m", prompt: "p" });
    expect(Object.keys(stub.calls[0]).sort()).toEqual(["method", "model", "prompt"]);
  });

  it("records the images and format Wave 7 inspects", async () => {
    const png = Buffer.from([0x89, 0x50]);
    const stub = createStubClient({ vision: ["{}"] });
    await stub.vision({
      model: "qwen3-vl:8b-instruct-q4_K_M",
      prompt: "critique",
      images: [png],
      format: "json",
      options: { temperature: 0 },
    });

    const call = stub.calls[0];
    expect(call.method).toBe("vision");
    expect(call.images).toHaveLength(1);
    expect(call.images?.[0].equals(png)).toBe(true);
    expect(call.format).toBe("json");
    expect(call.options).toEqual({ temperature: 0 });
  });

  it("copies the images array, so a caller reusing one cannot rewrite the record", async () => {
    const stub = createStubClient({ vision: ["{}"] });
    const images = [Buffer.from([1])];

    await stub.vision({ model: "m", prompt: "p", images });
    images.push(Buffer.from([2]));

    expect(stub.calls[0].images).toHaveLength(1);
  });

  it("records the tools offered to chatWithTools", async () => {
    const stub = createStubClient({ chatWithTools: [{ content: "", toolCalls: [] }] });
    await stub.chatWithTools({ model: "m", messages: [], tools: [PLACE_PIXEL, DONE] });
    expect(stub.calls[0].tools).toEqual([PLACE_PIXEL, DONE]);
  });

  it("snapshots messages so a growing transcript does not rewrite earlier calls", async () => {
    // Wave 8 appends to one array across up to 40 turns. Storing the reference
    // would make every recorded call show the *final* transcript, and its
    // acceptance criterion 5 — "the transcript's assistant turns carry
    // tool_calls" — would then pass for a loop that appended nothing until the
    // very end.
    const stub = createStubClient({ chatWithTools: [{ content: "", toolCalls: [] }] });
    const messages: ChatMessage[] = [{ role: "user", content: "start" }];

    await stub.chatWithTools({ model: "m", messages, tools: [] });
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", name: "place_pixel", arguments: { x: 1 } }],
    });
    await stub.chatWithTools({ model: "m", messages, tools: [] });

    expect(stub.calls[0].messages).toEqual([{ role: "user", content: "start" }]);
    expect(stub.calls[1].messages).toHaveLength(2);
    expect(stub.calls[1].messages?.[1].tool_calls).toEqual([
      { id: "c1", name: "place_pixel", arguments: { x: 1 } },
    ]);
  });

  it("snapshots a tool call's arguments, not just the array", async () => {
    const stub = createStubClient({ chatWithTools: [{ content: "", toolCalls: [] }] });
    const args: Record<string, unknown> = { x: 1 };
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "c", name: "n", arguments: args }] },
    ];

    await stub.chatWithTools({ model: "m", messages, tools: [] });
    args.x = 999;

    expect(stub.calls[0].messages?.[0].tool_calls?.[0].arguments).toEqual({ x: 1 });
  });

  it("returns a copy of the scripted turn so a consumer cannot edit the script", async () => {
    const turn: ChatTurn = {
      content: "",
      toolCalls: [{ id: "c1", name: "place_pixel", arguments: { x: 1 } }],
    };
    const stub = createStubClient({ chatWithTools: [turn] });

    const first = await stub.chatWithTools({ model: "m", messages: [], tools: [] });
    first.toolCalls[0].arguments.x = 999;
    first.toolCalls.push({ id: "c2", name: "done", arguments: {} });

    const second = await stub.chatWithTools({ model: "m", messages: [], tools: [] });
    expect(second.toolCalls).toEqual([{ id: "c1", name: "place_pixel", arguments: { x: 1 } }]);
  });

  it("keeps per-method queues independent while recording one ordered log", async () => {
    // Wave 9's pipeline script: draft, critique, revise turns, critique again.
    const stub = createStubClient({
      generate: ["draft"],
      vision: ["round 1 critique", "round 2 critique"],
      chatWithTools: [
        { content: "", toolCalls: [{ id: "c1", name: "place_pixel", arguments: { x: 1 } }] },
        { content: "", toolCalls: [{ id: "c2", name: "done", arguments: {} }] },
      ],
    });

    await stub.generate({ model: "g", prompt: "p" });
    expect(await stub.vision({ model: "v", prompt: "p", images: [] })).toBe("round 1 critique");
    await stub.chatWithTools({ model: "g", messages: [], tools: [] });
    await stub.chatWithTools({ model: "g", messages: [], tools: [] });
    // The second vision call is the second *vision* entry, unaffected by the two
    // chat calls in between — this is the whole point of per-method queues.
    expect(await stub.vision({ model: "v", prompt: "p", images: [] })).toBe("round 2 critique");

    expect(stub.calls.map((c) => c.method)).toEqual([
      "generate",
      "vision",
      "chatWithTools",
      "chatWithTools",
      "vision",
    ]);
  });

  it("returns the scripted model list and records the call", async () => {
    const stub = createStubClient({ models: ["qwen3:8b", "qwen3-vl:8b-instruct-q4_K_M"] });
    expect(await stub.listModels()).toEqual(["qwen3:8b", "qwen3-vl:8b-instruct-q4_K_M"]);
    expect(stub.calls).toEqual([{ method: "listModels", model: "" }]);
  });

  it("returns an empty model list when the script does not name one", async () => {
    const stub = createStubClient({});
    expect(await stub.listModels()).toEqual([]);
  });

  it("throws a scripted Error instead of returning it", async () => {
    // Spec §7.1 draws FAILED edges out of DRAFTING, CRITIQUING and REVISING, and
    // §9 requires an OllamaTimeoutError during CRITIQUING to reach
    // SessionHistory.error. Without this, Wave 9 cannot drive any of them.
    const stub = createStubClient({
      generate: ["fine"],
      vision: [new OllamaTimeoutError("qwen3-vl:8b-instruct-q4_K_M", 480_000)],
      models: new OllamaUnreachableError("http://127.0.0.1:11434/api/tags"),
    });

    expect(await stub.generate({ model: "m", prompt: "p" })).toBe("fine");
    await expect(stub.vision({ model: "m", prompt: "p", images: [] })).rejects.toBeInstanceOf(
      OllamaTimeoutError,
    );
    await expect(stub.listModels()).rejects.toBeInstanceOf(OllamaUnreachableError);
  });

  it("records the call that threw", async () => {
    const stub = createStubClient({ vision: [new OllamaTimeoutError("critic", 1)] });
    await stub.vision({ model: "critic", prompt: "p", images: [] }).catch(() => undefined);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("vision");
  });

  it("names the missing method when a script has no entry for it", async () => {
    const stub = createStubClient({ generate: ["only a draft"] });
    await expect(stub.vision({ model: "m", prompt: "p", images: [] })).rejects.toThrow("vision");
  });

  it("empties the call log in place and rewinds every queue on reset", async () => {
    const stub = createStubClient({ generate: ["first", "second"] });
    const { calls } = stub;

    await stub.generate({ model: "m", prompt: "p" });
    await stub.generate({ model: "m", prompt: "p" });
    stub.reset();

    expect(calls).toHaveLength(0);
    expect(stub.calls).toBe(calls);
    expect(await stub.generate({ model: "m", prompt: "p" })).toBe("first");
  });
});
