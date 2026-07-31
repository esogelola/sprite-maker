/**
 * `main/lmstudio.ts` — spec amendment A15.
 *
 * **Every test here runs against a real `http.createServer` and asserts on the
 * received request body**, exactly as `ollama.test.ts` does and for a sharper
 * reason: this file is a *translation layer*, and a test that mocked `fetch` and
 * asserted on the translation function would be asserting that the author agrees
 * with themselves. The socket is the only place where "the schema is nested
 * under `json_schema.schema`" and "the schema is nested under `json_schema`" are
 * different claims.
 *
 * LM Studio is **not installed on the machine this was written on**. That makes
 * the fixture the whole of the evidence for the wire format, and it makes the
 * boundary of that evidence worth stating: these tests prove the bytes this
 * client sends and how it reads a reply of a given shape. They cannot prove that
 * a real LM Studio accepts those bytes, honours `strict: true` through llama.cpp's
 * GBNF converter, or implements `reasoning_effort`. The README and A15 both carry
 * that list; it is not hidden in a comment.
 *
 * The falsy-zero cases get their own `describe`. `temperature: 0` is what every
 * bench run and every determinism test sets, and the Ollama → OpenAI move lifts
 * it out of a nested bag onto the top level — which is precisely where
 * `if (options.temperature)` gets written. That mutant leaves every other test in
 * this file green while invalidating every measurement taken afterwards.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLmStudioClient,
  DEFAULT_LMSTUDIO_BASE_URL,
  NO_REASONING_EFFORT,
  type UnsupportedCapability,
} from "@main/lmstudio";
import { OllamaHttpError, OllamaTimeoutError, OllamaUnreachableError } from "@main/ollama";
import type { ChatMessage, ChatTurn, ToolDef } from "@shared/schema";

// ---------------------------------------------------------------------------
// the HTTP fixture — the same one ollama.test.ts uses
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  contentType: string | undefined;
  /**
   * The `Host` header, which is the base URL's authority as the client sent it.
   *
   * The one place a rewritten host is visible: `fetch` resolves the name to an
   * address to open the socket, but it writes the *supplied* authority here — so
   * a client that "helpfully" turned `localhost` into `127.0.0.1` would still
   * connect, still pass every other test in this file, and differ only here.
   */
  host: string | undefined;
  /** Exactly the bytes that arrived, before any parsing. */
  raw: string;
  /** `raw` as JSON, or `{}` when it was not JSON. */
  body: Record<string, unknown>;
}

interface Fixture {
  baseUrl: string;
  requests: CapturedRequest[];
  /** So a test can spell the same server under a different authority. */
  port: number;
}

type Handler = (captured: CapturedRequest, res: ServerResponse) => void;

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(handler: Handler, host = "127.0.0.1"): Promise<Fixture> {
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
        host: req.headers.host,
        raw,
        body,
      };
      requests.push(captured);
      handler(captured, res);
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  // Bracketed for IPv6, because that is what a URL authority requires and what
  // a caller running LM Studio on `[::1]` would have typed.
  const authority = host.includes(":") ? `[${host}]` : host;
  return { baseUrl: `http://${authority}:${port}`, requests, port };
}

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

/** One OpenAI chat completion carrying `text`. */
function completion(text: string | null, toolCalls?: unknown[]): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: text };
  if (toolCalls !== undefined) message.tool_calls = toolCalls;
  return { id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message }] };
}

/** OpenAI's own reply envelope for one tool call — `arguments` is a string. */
function wireToolCall(
  name: string,
  args: Record<string, unknown>,
  id?: string,
): Record<string, unknown> {
  const call: Record<string, unknown> = {
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
  if (id !== undefined) call.id = id;
  return call;
}

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

const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
const OTHER = Buffer.from([0x01, 0x02, 0x03]);

/** `messages` as sent, narrowed for assertions. */
function sentMessages(request: CapturedRequest): Array<Record<string, unknown>> {
  return request.body.messages as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// base URL
// ---------------------------------------------------------------------------

describe("createLmStudioClient — base URL", () => {
  it("defaults to LM Studio's documented port on the loopback literal", () => {
    // The literal sidesteps the resolution-order question rather than answering
    // it. The Ollama default's reasoning for preferring it is macOS-shaped, and
    // this app is developed against LM Studio on Linux too — so the default is
    // deliberately unopinionated and every other host comes from the caller.
    expect(DEFAULT_LMSTUDIO_BASE_URL).toBe("http://127.0.0.1:1234");
  });

  it("does not double the separator when the base URL ends in a slash", async () => {
    const fixture = await startServer(replyJson({ data: [] }));
    await createLmStudioClient(`${fixture.baseUrl}/`).listModels();
    expect(fixture.requests[0].url).toBe("/v1/models");
  });

  it("strips only the trailing slash, leaving the authority untouched", async () => {
    const fixture = await startServer(replyJson({ data: [] }));
    await createLmStudioClient(`${fixture.baseUrl}///`).listModels();

    expect(fixture.requests[0].url).toBe("/v1/models");
    expect(fixture.requests[0].host).toBe(`127.0.0.1:${fixture.port}`);
  });

  it("honours a non-default base URL", async () => {
    const fixture = await startServer(replyJson(completion("ok")));
    const client = createLmStudioClient(fixture.baseUrl);
    expect(await client.generate({ model: "m", prompt: "p" })).toBe("ok");
    expect(fixture.requests).toHaveLength(1);
  });

  it("passes a supplied hostname through verbatim rather than resolving it first", async () => {
    // The cobuilder case. `localhost` and `127.0.0.1` are not interchangeable to
    // a user who typed one of them: rewriting the host would work here, work on
    // the machine of whoever wrote the rewrite, and quietly retarget anyone whose
    // `localhost` means something else. The `Host` header is the only place the
    // difference shows.
    const fixture = await startServer(replyJson({ data: [{ id: "m" }] }));
    await createLmStudioClient(`http://localhost:${fixture.port}`).listModels();

    expect(fixture.requests[0].host).toBe(`localhost:${fixture.port}`);
    expect(fixture.requests[0].url).toBe("/v1/models");
  });

  it("passes an IPv6 literal through verbatim", async () => {
    const fixture = await startServer(replyJson({ data: [{ id: "m" }] }), "::1");
    // `[::1]:port`, brackets and all — the authority a caller running LM Studio
    // on IPv6 loopback would have typed, and a shape that string-munging a host
    // tends to break.
    expect(fixture.baseUrl).toBe(`http://[::1]:${fixture.port}`);

    expect(await createLmStudioClient(fixture.baseUrl).listModels()).toEqual(["m"]);
    expect(fixture.requests[0].host).toBe(`[::1]:${fixture.port}`);
  });

  it("reaches a non-loopback address on this machine untouched", async () => {
    // LM Studio on another box is the *normal* deployment for a Linux cobuilder,
    // and nothing about a LAN address is a mistake to be corrected. Bound to this
    // machine's own routable interface so the test is hermetic and instant rather
    // than depending on a second host.
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((iface) => iface !== undefined && iface.family === "IPv4" && !iface.internal);
    if (lan === undefined) {
      // A machine with no non-loopback IPv4 (CI in a namespace) cannot make this
      // claim; the two tests above still pin the no-rewriting property.
      expect(true).toBe(true);
      return;
    }

    const fixture = await startServer(replyJson({ data: [{ id: "m" }] }), lan.address);
    expect(await createLmStudioClient(fixture.baseUrl).listModels()).toEqual(["m"]);
    expect(fixture.requests[0].host).toBe(`${lan.address}:${fixture.port}`);
    expect(fixture.baseUrl.startsWith("http://127.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

describe("listModels", () => {
  it("GETs /v1/models and returns the ids in order", async () => {
    const fixture = await startServer(
      replyJson({
        object: "list",
        data: [
          { id: "qwen3-vl-8b-instruct", object: "model", owned_by: "organization_owner" },
          { id: "qwen2.5-coder-7b", object: "model" },
        ],
      }),
    );
    const models = await createLmStudioClient(fixture.baseUrl).listModels();

    // `data[].id`, not `models[].name` — the same list under a different name is
    // the most ordinary way a port of this method silently returns `[]`.
    expect(models).toEqual(["qwen3-vl-8b-instruct", "qwen2.5-coder-7b"]);
    expect(fixture.requests[0].method).toBe("GET");
    expect(fixture.requests[0].url).toBe("/v1/models");
    expect(fixture.requests[0].raw).toBe("");
  });

  it("returns an empty list when the server has nothing loaded", async () => {
    const fixture = await startServer(replyJson({ object: "list", data: [] }));
    expect(await createLmStudioClient(fixture.baseUrl).listModels()).toEqual([]);
  });

  it("skips an entry with no usable id rather than emitting undefined", async () => {
    const fixture = await startServer(
      replyJson({ data: [{ id: "a" }, { object: "model" }, { id: "" }] }),
    );
    expect(await createLmStudioClient(fixture.baseUrl).listModels()).toEqual(["a"]);
  });

  it("throws naming the endpoint when the payload has no data array", async () => {
    const fixture = await startServer(replyJson({ error: "something else entirely" }));
    // Not `[]`: "up with nothing loaded" is a legitimate quiet dead end in the
    // pickers, and a malformed payload must not look like one.
    await expect(createLmStudioClient(fixture.baseUrl).listModels()).rejects.toThrow(
      `${fixture.baseUrl}/v1/models`,
    );
  });
});

// ---------------------------------------------------------------------------
// generate — the messages translation
// ---------------------------------------------------------------------------

describe("generate", () => {
  it("POSTs /v1/chat/completions with stream disabled", async () => {
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({ model: "qwen3", prompt: "draw a fox" });

    const request = fixture.requests[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/chat/completions");
    expect(request.contentType).toBe("application/json");
    // Not an optimisation. The OpenAI default is to stream, and a streamed reply
    // is `text/event-stream`, not one JSON object — omitting the flag changes the
    // protocol rather than the size.
    expect(request.body.stream).toBe(false);
    expect(request.body.model).toBe("qwen3");
  });

  it("turns prompt into a single user message", async () => {
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({ model: "m", prompt: "draw a fox" });

    expect(sentMessages(fixture.requests[0])).toEqual([{ role: "user", content: "draw a fox" }]);
    // `prompt` is not a field of this API; a translation that forwarded it too
    // would look harmless and double the prompt on servers that accept both.
    expect("prompt" in fixture.requests[0].body).toBe(false);
  });

  it("prepends the system message when the caller sent one", async () => {
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({
      model: "m",
      system: "You draw pixel art.",
      prompt: "p",
    });

    expect(sentMessages(fixture.requests[0])).toEqual([
      { role: "system", content: "You draw pixel art." },
      { role: "user", content: "p" },
    ]);
  });

  it("omits the system message entirely when there is none", async () => {
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({ model: "m", prompt: "p" });

    // Not `{ role: "system", content: "" }`. An empty system turn is still a
    // turn: the chat template renders a blank system block for it, and "no
    // system prompt" has a spelling on this wire — one fewer element.
    const messages = sentMessages(fixture.requests[0]);
    expect(messages).toHaveLength(1);
    expect(messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("sends only the fields the caller supplied", async () => {
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({ model: "m", prompt: "p" });

    expect(Object.keys(fixture.requests[0].body).sort()).toEqual(["messages", "model", "stream"]);
  });

  it("returns choices[0].message.content verbatim", async () => {
    const fixture = await startServer(replyJson(completion('{"ops":[]}')));
    const text = await createLmStudioClient(fixture.baseUrl).generate({ model: "m", prompt: "p" });
    expect(text).toBe('{"ops":[]}');
  });

  it("returns an empty completion rather than treating it as a fault", async () => {
    // A short answer, not a broken server — §6.3 already routes an unparseable
    // draft through its retry path.
    const fixture = await startServer(replyJson(completion("")));
    expect(await createLmStudioClient(fixture.baseUrl).generate({ model: "m", prompt: "p" })).toBe(
      "",
    );
  });

  it("throws naming the endpoint and the empty choices array", async () => {
    // `choices[0].message.content` on `[]` is a TypeError four frames inside the
    // client, which tells §9 nothing and the user less. An empty `choices` is a
    // real reply shape — a filtered or cancelled completion — so the guard is
    // reachable rather than defensive.
    const fixture = await startServer(replyJson({ id: "c", choices: [] }));
    const error = (await createLmStudioClient(fixture.baseUrl)
      .generate({ model: "m", prompt: "p" })
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toContain(`${fixture.baseUrl}/v1/chat/completions`);
    // The *wording* is the assertion, not merely that something threw. Dropping
    // the `length === 0` half of the guard still throws — `choices[0]` is
    // `undefined`, so the next check fires — but it reports "a choice with no
    // message" for a reply that contained no choices at all, sending whoever
    // reads it looking for a malformed choice that does not exist.
    expect(error.message).toContain("no `choices`");
  });

  it("throws naming the endpoint when choices is missing altogether", async () => {
    const fixture = await startServer(replyJson({ error: { message: "no model loaded" } }));
    await expect(
      createLmStudioClient(fixture.baseUrl).generate({ model: "m", prompt: "p" }),
    ).rejects.toThrow(`${fixture.baseUrl}/v1/chat/completions`);
  });

  it("throws when the completion carries no content string", async () => {
    // `content: null` is what OpenAI sends for a pure tool-calling turn, and
    // `generate` offers no tools — so there was nothing to call instead, and
    // reporting it as empty output would charge the draft's repair budget for a
    // reply this client could not read.
    const fixture = await startServer(replyJson(completion(null)));
    await expect(
      createLmStudioClient(fixture.baseUrl).generate({ model: "m", prompt: "p" }),
    ).rejects.toThrow(`${fixture.baseUrl}/v1/chat/completions`);
  });
});

// ---------------------------------------------------------------------------
// options → top-level fields, and the falsy-zero minefield
// ---------------------------------------------------------------------------

describe("options translation", () => {
  it("lifts temperature, seed and num_predict onto the top level", async () => {
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({
      model: "m",
      prompt: "p",
      options: { temperature: 0.6, seed: 7, num_predict: 1200 },
    });

    const { body } = fixture.requests[0];
    expect(body.temperature).toBe(0.6);
    expect(body.seed).toBe(7);
    expect(body.max_tokens).toBe(1200);
    // The bag itself is Ollama's spelling and means nothing here. Forwarding it
    // as well would be invisible on a lenient server and a 400 on a strict one.
    expect("options" in body).toBe(false);
    expect("num_predict" in body).toBe(false);
  });

  it("omits max_tokens for Ollama's negative num_predict sentinel", async () => {
    // `-1` is Ollama's "unbounded"; OpenAI spells the same thing by leaving
    // `max_tokens` off, and a negative `max_tokens` is not a smaller limit but an
    // invalid request. This is the one supplied value that deliberately does not
    // reach the wire.
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({
      model: "m",
      prompt: "p",
      options: { num_predict: -1 },
    });

    expect("max_tokens" in fixture.requests[0].body).toBe(false);
  });

  it("reports an option with no OpenAI spelling instead of dropping it in silence", async () => {
    const fixture = await startServer(replyJson(completion("rows")));
    const gaps: UnsupportedCapability[] = [];
    await createLmStudioClient(fixture.baseUrl, {
      onUnsupported: (gap) => gaps.push(gap),
    }).generate({ model: "qwen3", prompt: "p", options: { temperature: 0, num_ctx: 8192 } });

    expect(gaps.map((g) => g.capability)).toEqual(["options.num_ctx"]);
    expect(gaps[0].model).toBe("qwen3");
    expect(gaps[0].endpoint).toBe(`${fixture.baseUrl}/v1/chat/completions`);
    // The translated keys are not gaps, and the untranslated one is not sent.
    expect("num_ctx" in fixture.requests[0].body).toBe(false);
    expect(fixture.requests[0].body.temperature).toBe(0);
  });

  it("warns once per capability rather than once per call by default", async () => {
    // The default sink dedupes because a 40-turn revise loop would otherwise emit
    // 40 identical lines and teach the reader to skip them.
    const fixture = await startServer(replyJson(completion("rows")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client = createLmStudioClient(fixture.baseUrl);
      const options = { num_ctx: 8192 };
      await client.generate({ model: "m", prompt: "p", options });
      await client.generate({ model: "m", prompt: "p", options });
      await client.generate({ model: "m", prompt: "p", options });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("options.num_ctx");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("falsy zero — the values a truthiness guard eats", () => {
  it("sends temperature: 0", async () => {
    // The single most dangerous value in this file. `temperature: 0` is what
    // every bench run and every seeded determinism test sets; `if (o.temperature)`
    // drops it, the server applies its own default, and every measurement taken
    // afterwards is invalid while this suite stays green.
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({
      model: "m",
      prompt: "p",
      options: { temperature: 0 },
    });

    const { body, raw } = fixture.requests[0];
    expect(body.temperature).toBe(0);
    expect("temperature" in body).toBe(true);
    // Spelled on the raw bytes too: `"temperature":0` and an absent key are
    // different requests, and `toBe(0)` alone would also pass for `undefined`
    // under a `toEqual`-shaped mistake.
    expect(raw).toContain('"temperature":0');
  });

  it("sends seed: 0", async () => {
    // 0 is an ordinary seed. `HarnessConfig.seed` spells "no seed" as `null` and
    // `modelOptions` omits the key for it precisely so that `0` can mean itself.
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({
      model: "m",
      prompt: "p",
      options: { temperature: 0, seed: 0 },
    });

    const { body, raw } = fixture.requests[0];
    expect(body.seed).toBe(0);
    expect(raw).toContain('"seed":0');
  });

  it("sends max_tokens: 0 for num_predict: 0", async () => {
    const fixture = await startServer(replyJson(completion("")));
    await createLmStudioClient(fixture.baseUrl).generate({
      model: "m",
      prompt: "p",
      options: { num_predict: 0 },
    });

    expect(fixture.requests[0].body.max_tokens).toBe(0);
    expect(fixture.requests[0].raw).toContain('"max_tokens":0');
  });

  it("carries temperature: 0 and seed: 0 on vision and chatWithTools too", async () => {
    // Three call sites, one helper — and a guard added to only one of them is the
    // shape this project has near-missed six times.
    const vision = await startServer(replyJson(completion("{}")));
    await createLmStudioClient(vision.baseUrl).vision({
      model: "m",
      prompt: "p",
      images: [IMAGE],
      options: { temperature: 0, seed: 0 },
    });
    expect(vision.requests[0].body.temperature).toBe(0);
    expect(vision.requests[0].body.seed).toBe(0);

    const chat = await startServer(replyJson(completion("hi")));
    await createLmStudioClient(chat.baseUrl).chatWithTools({
      model: "m",
      messages: [{ role: "user", content: "u" }],
      tools: [],
      options: { temperature: 0, seed: 0 },
    });
    expect(chat.requests[0].body.temperature).toBe(0);
    expect(chat.requests[0].body.seed).toBe(0);
  });

  it("omits both when the caller sent no options at all", async () => {
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({ model: "m", prompt: "p" });

    const { body } = fixture.requests[0];
    expect("temperature" in body).toBe(false);
    expect("seed" in body).toBe(false);
    // Absent, not defaulted. Deciding a temperature here would take §6.8 A13's
    // choice away from every caller.
    expect("max_tokens" in body).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// response_format — both arms
// ---------------------------------------------------------------------------

describe("format translation", () => {
  it("wraps a JSON Schema in response_format.json_schema with strict: true", async () => {
    const fixture = await startServer(replyJson(completion("{}")));
    const schema = {
      type: "object",
      properties: { ops: { type: "array", items: { anyOf: [{ type: "object" }] } } },
      required: ["ops"],
    };

    await createLmStudioClient(fixture.baseUrl).generate({
      model: "m",
      prompt: "p",
      format: schema,
    });

    const format = fixture.requests[0].body.response_format as Record<string, unknown>;
    expect(format.type).toBe("json_schema");
    // `strict: true` is what turns the schema into a decoding constraint rather
    // than a hint. Without it A10's op shape goes back to being repairable
    // instead of unrepresentable, and nothing about the reply says so.
    expect(format.json_schema).toEqual({ name: "response", strict: true, schema });
    // Nested under `schema`, not spread into `json_schema` — both are objects,
    // both are valid JSON, and only the socket tells them apart.
    expect((format.json_schema as Record<string, unknown>).schema).toEqual(schema);
    expect(typeof (format.json_schema as Record<string, unknown>).schema).toBe("object");
  });

  it("maps the string arm to json_object", async () => {
    const fixture = await startServer(replyJson(completion("{}")));
    await createLmStudioClient(fixture.baseUrl).generate({
      model: "m",
      prompt: "p",
      format: "json",
    });

    // Ollama's `"json"` means "valid JSON, any shape", which is `json_object` and
    // not an empty schema.
    expect(fixture.requests[0].body.response_format).toEqual({ type: "json_object" });
  });

  it("omits response_format entirely when the caller did not ask for one", async () => {
    const fixture = await startServer(replyJson(completion("free text")));
    await createLmStudioClient(fixture.baseUrl).generate({ model: "m", prompt: "p" });

    expect("response_format" in fixture.requests[0].body).toBe(false);
    // Not `format` either — the Ollama key must not survive the translation.
    expect("format" in fixture.requests[0].body).toBe(false);
  });

  it("applies to vision and chatWithTools alike", async () => {
    const vision = await startServer(replyJson(completion("{}")));
    await createLmStudioClient(vision.baseUrl).vision({
      model: "m",
      prompt: "p",
      images: [IMAGE],
      format: "json",
    });
    expect(vision.requests[0].body.response_format).toEqual({ type: "json_object" });

    const chat = await startServer(replyJson(completion("{}")));
    const schema = { type: "object", required: ["summary"] };
    await createLmStudioClient(chat.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
      format: schema,
    });
    expect(
      (chat.requests[0].body.response_format as { json_schema: Record<string, unknown> })
        .json_schema,
    ).toEqual({ name: "response", strict: true, schema });
  });
});

// ---------------------------------------------------------------------------
// think → reasoning_effort — spec A15
// ---------------------------------------------------------------------------

describe("think translation", () => {
  it("sends reasoning_effort: none for think: false", async () => {
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({
      model: "m",
      prompt: "p",
      options: { temperature: 0 },
      think: false,
    });

    const { body } = fixture.requests[0];
    // A15's measurement: over an OpenAI-compatible endpoint, `reasoning_effort:
    // "none"` reproduced native `think: false` exactly — 82 generated tokens
    // against 600 unsuppressed, byte-identical content. The four spellings that
    // read as correct and do nothing (`/no_think`, `enable_thinking`, a top-level
    // `think`, `reasoning_effort: "low"`) are why this is asserted on the wire.
    expect(body.reasoning_effort).toBe(NO_REASONING_EFFORT);
    expect(body.reasoning_effort).toBe("none");
    // Top-level, and the Ollama spelling does not survive alongside it.
    expect("think" in body).toBe(false);
  });

  it("sends no reasoning_effort for think: true", async () => {
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({ model: "m", prompt: "p", think: true });

    // "Let the model reason" is what an absent field already means. Sending
    // `reasoning_effort` here would invent a request the caller did not make —
    // and `"low"` was measured *not* to suppress, so there is no scale to map on
    // to anyway.
    expect("reasoning_effort" in fixture.requests[0].body).toBe(false);
  });

  it("sends no reasoning_effort when think is omitted", async () => {
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({ model: "m", prompt: "p" });

    expect("reasoning_effort" in fixture.requests[0].body).toBe(false);
    expect(Object.keys(fixture.requests[0].body).sort()).toEqual(["messages", "model", "stream"]);
  });

  it("suppresses on vision and chatWithTools too — the revise loop is the point", async () => {
    // §7.4 sends `think: false` from the draft and revise stages, and revise runs
    // up to 40 turns per round. A mapping applied on `generate` alone would leave
    // the expensive path unsuppressed and every test but this one green.
    const vision = await startServer(replyJson(completion("{}")));
    await createLmStudioClient(vision.baseUrl).vision({
      model: "m",
      prompt: "p",
      images: [IMAGE],
      think: false,
    });
    expect(vision.requests[0].body.reasoning_effort).toBe("none");

    const chat = await startServer(replyJson(completion("hi")));
    await createLmStudioClient(chat.baseUrl).chatWithTools({
      model: "m",
      messages: [{ role: "user", content: "u" }],
      tools: [],
      think: false,
    });
    expect(chat.requests[0].body.reasoning_effort).toBe("none");
  });

  it("sends reasoning_effort as the JSON string \"none\", not a boolean", async () => {
    const fixture = await startServer(replyJson(completion("rows")));
    await createLmStudioClient(fixture.baseUrl).generate({ model: "m", prompt: "p", think: false });
    expect(fixture.requests[0].raw).toContain('"reasoning_effort":"none"');
  });
});

// ---------------------------------------------------------------------------
// vision — the content array
// ---------------------------------------------------------------------------

describe("vision", () => {
  it("sends the prompt and each image as one content array", async () => {
    const fixture = await startServer(replyJson(completion("{}")));
    await createLmStudioClient(fixture.baseUrl).vision({
      model: "qwen3-vl",
      prompt: "what is this",
      images: [IMAGE, OTHER],
    });

    const [user] = sentMessages(fixture.requests[0]);
    expect(user.role).toBe("user");
    // Spelled out rather than rebuilt from `toString("base64")`: hex, base64url
    // and base64 all produce plausible strings, and the `data:` prefix is the
    // difference between an image and a relative URL the server tries to fetch.
    expect(user.content).toEqual([
      { type: "text", text: "what is this" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgr/AA==" },
      },
      { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
    ]);
  });

  it("prefixes the base64 with the PNG data URI scheme", async () => {
    const fixture = await startServer(replyJson(completion("{}")));
    await createLmStudioClient(fixture.baseUrl).vision({
      model: "m",
      prompt: "p",
      images: [IMAGE],
    });

    const [user] = sentMessages(fixture.requests[0]);
    const [, image] = user.content as Array<Record<string, unknown>>;
    const url = (image.image_url as { url: string }).url;
    // Bare base64 in this field is not a URL. `render.ts` emits PNG, so the media
    // type is a fact rather than a guess.
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(url.slice("data:image/png;base64,".length), "base64").equals(IMAGE)).toBe(
      true,
    );
  });

  it("does not send an Ollama-style images array", async () => {
    const fixture = await startServer(replyJson(completion("{}")));
    await createLmStudioClient(fixture.baseUrl).vision({
      model: "m",
      prompt: "p",
      images: [IMAGE],
    });

    // A top-level `images` is Ollama's spelling; on this API it is an unknown key
    // that a lenient server ignores — leaving the critic to review an image it
    // never received and report on a sprite nobody drew.
    expect("images" in fixture.requests[0].body).toBe(false);
  });

  it("keeps the content array shape for an empty image list", async () => {
    const fixture = await startServer(replyJson(completion("{}")));
    await createLmStudioClient(fixture.baseUrl).vision({ model: "m", prompt: "p", images: [] });

    // The shape follows the call, not the payload: a critique with no image is a
    // bug worth seeing as one, not a text call that quietly succeeded.
    const [user] = sentMessages(fixture.requests[0]);
    expect(user.content).toEqual([{ type: "text", text: "p" }]);
  });

  it("carries the system message beside the image content", async () => {
    const fixture = await startServer(replyJson(completion("{}")));
    await createLmStudioClient(fixture.baseUrl).vision({
      model: "m",
      system: "You review pixel art.",
      prompt: "critique",
      images: [IMAGE],
      format: "json",
    });

    const messages = sentMessages(fixture.requests[0]);
    expect(messages[0]).toEqual({ role: "system", content: "You review pixel art." });
    expect(Array.isArray(messages[1].content)).toBe(true);
    expect(fixture.requests[0].body.response_format).toEqual({ type: "json_object" });
  });

  it("returns the completion content", async () => {
    const fixture = await startServer(replyJson(completion('{"overall":4}')));
    const text = await createLmStudioClient(fixture.baseUrl).vision({
      model: "m",
      prompt: "p",
      images: [IMAGE],
    });
    expect(text).toBe('{"overall":4}');
  });
});

// ---------------------------------------------------------------------------
// chatWithTools — the highest wire-format risk on this path too
// ---------------------------------------------------------------------------

describe("chatWithTools", () => {
  it("POSTs the tools verbatim with stream disabled", async () => {
    const fixture = await startServer(replyJson(completion("hi")));
    await createLmStudioClient(fixture.baseUrl).chatWithTools({
      model: "qwen3",
      messages: [{ role: "user", content: "start" }],
      tools: [PLACE_PIXEL, DONE],
    });

    const request = fixture.requests[0];
    expect(request.url).toBe("/v1/chat/completions");
    expect(request.body.stream).toBe(false);
    // `ToolDef` is already OpenAI's shape — this is the one field that crosses
    // the boundary unchanged, and Ollama took it unchanged too.
    expect(request.body.tools).toEqual([PLACE_PIXEL, DONE]);
  });

  it("stringifies tool call arguments and tags each call type: function", async () => {
    const fixture = await startServer(replyJson(completion("ok")));
    const messages: ChatMessage[] = [
      { role: "user", content: "fix row 4" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", name: "place_pixel", arguments: { x: 3, y: 4, index: 2 } }],
      },
      { role: "tool", content: "ok", tool_call_id: "call_1" },
    ];
    await createLmStudioClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages,
      tools: [PLACE_PIXEL],
    });

    // The two differences from the Ollama envelope, and both fail silently:
    // OpenAI types `arguments` as a *string*, and `type: "function"` is the
    // discriminator of a union that currently has one arm — so omitting it looks
    // harmless right up until a server validates it.
    expect(sentMessages(fixture.requests[0])).toEqual([
      { role: "user", content: "fix row 4" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "place_pixel", arguments: '{"x":3,"y":4,"index":2}' },
          },
        ],
      },
      { role: "tool", content: "ok", tool_call_id: "call_1" },
    ]);
  });

  it("sends arguments as a string even when they are empty", async () => {
    const fixture = await startServer(replyJson(completion("ok")));
    await createLmStudioClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "c", name: "done", arguments: {} }] },
      ],
      tools: [],
    });

    const [assistant] = sentMessages(fixture.requests[0]);
    const [call] = assistant.tool_calls as Array<Record<string, unknown>>;
    expect((call.function as { arguments: unknown }).arguments).toBe("{}");
    expect(Object.keys(call).sort()).toEqual(["function", "id", "type"]);
  });

  it("omits tool_calls entirely when a message carries none", async () => {
    const fixture = await startServer(replyJson(completion("ok")));
    await createLmStudioClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [
        { role: "user", content: "u" },
        { role: "assistant", content: "a", tool_calls: [] },
      ],
      tools: [],
    });

    const messages = sentMessages(fixture.requests[0]);
    expect(Object.keys(messages[0]).sort()).toEqual(["content", "role"]);
    expect(Object.keys(messages[1]).sort()).toEqual(["content", "role"]);
  });

  it("parses OpenAI tool calls whose arguments arrive as a JSON string", async () => {
    // The *normal* reply shape on this API, not a tolerance for drift — which is
    // why the parser is shared with `ollama.ts` rather than rewritten here by
    // someone looking only at the shape in front of them.
    const fixture = await startServer(
      replyJson(
        completion(null, [
          wireToolCall("place_pixel", { x: 3, y: 4, index: 2 }, "call_abc"),
          wireToolCall("done", { summary: "tidied the outline" }, "call_def"),
        ]),
      ),
    );

    const turn = await createLmStudioClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [{ role: "user", content: "u" }],
      tools: [PLACE_PIXEL, DONE],
    });

    expect(turn).toEqual({
      content: "",
      toolCalls: [
        { id: "call_abc", name: "place_pixel", arguments: { x: 3, y: 4, index: 2 } },
        { id: "call_def", name: "done", arguments: { summary: "tidied the outline" } },
      ],
    } satisfies ChatTurn);
  });

  it("reads a null content as an empty answer, not a fault", async () => {
    // OpenAI's shape for a pure tool-calling turn. Wave 8 counts the turn either
    // way, and a throw here would take a whole run to FAILED over the most
    // ordinary reply the revise loop receives.
    const fixture = await startServer(replyJson(completion(null, [wireToolCall("done", {}, "c")])));
    const turn = await createLmStudioClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
    });
    expect(turn.content).toBe("");
    expect(turn.toolCalls).toHaveLength(1);
  });

  it("degrades unparseable arguments to an empty object rather than throwing", async () => {
    const fixture = await startServer(
      replyJson(
        completion(null, [
          { id: "c1", type: "function", function: { name: "p", arguments: "{x:" } },
        ]),
      ),
    );
    const turn = await createLmStudioClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
    });
    // §9: an invalid tool call comes back to the model as an error string and
    // counts against the cap. A throw would escape Wave 8's loop as an unhandled
    // rejection.
    expect(turn.toolCalls).toEqual([{ id: "c1", name: "p", arguments: {} }]);
  });

  it("synthesizes a stable id when the reply omits one", async () => {
    const fixture = await startServer(
      replyJson(completion(null, [wireToolCall("place_pixel", { x: 1 })])),
    );
    const turn = await createLmStudioClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
    });
    expect(turn.toolCalls[0].id).toBe("tool_call_0");
  });

  it("yields an empty toolCalls array when the model only spoke", async () => {
    const fixture = await startServer(replyJson(completion("I am thinking about it.")));
    const turn = await createLmStudioClient(fixture.baseUrl).chatWithTools({
      model: "m",
      messages: [],
      tools: [],
    });
    expect(turn).toEqual({ content: "I am thinking about it.", toolCalls: [] });
  });

  it("throws naming the endpoint when the reply carries no choices", async () => {
    const fixture = await startServer(replyJson({ done: true }));
    await expect(
      createLmStudioClient(fixture.baseUrl).chatWithTools({ model: "m", messages: [], tools: [] }),
    ).rejects.toThrow(`${fixture.baseUrl}/v1/chat/completions`);
  });

  it("round-trips a tool call: the reply becomes the next request's transcript", async () => {
    // The shape of every Wave 8 turn, and the assertion the Ollama suite calls
    // the most load-bearing one in Wave 5 — restated for the OpenAI envelope.
    const fixture = await startServer(
      replySequence([
        completion(null, [wireToolCall("place_pixel", { x: 3, y: 4, index: 2 }, "call_1")]),
        completion("DONE"),
      ]),
    );
    const client = createLmStudioClient(fixture.baseUrl);

    const messages: ChatMessage[] = [{ role: "user", content: "fix the outline" }];
    const first = await client.chatWithTools({ model: "m", messages, tools: [PLACE_PIXEL] });

    messages.push({ role: "assistant", content: first.content, tool_calls: first.toolCalls });
    messages.push({ role: "tool", content: "ok", tool_call_id: first.toolCalls[0].id });

    const second = await client.chatWithTools({ model: "m", messages, tools: [PLACE_PIXEL] });

    expect(second).toEqual({ content: "DONE", toolCalls: [] } satisfies ChatTurn);
    expect(sentMessages(fixture.requests[1])).toEqual([
      { role: "user", content: "fix the outline" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "place_pixel", arguments: '{"x":3,"y":4,"index":2}' },
          },
        ],
      },
      { role: "tool", content: "ok", tool_call_id: "call_1" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// errors — spec §6.9, §9. Transport failures, reused rather than forked.
// ---------------------------------------------------------------------------

describe("transport errors", () => {
  it("names the LM Studio endpoint when the connection is refused", async () => {
    const baseUrl = await closedPortBaseUrl();
    const error = await createLmStudioClient(baseUrl)
      .generate({ model: "m", prompt: "p" })
      .catch((e: unknown) => e);

    // The class is shared with the Ollama path on purpose — these describe
    // *transport*, not a vendor, and §9's IPC envelope carries one vocabulary.
    // What must not be shared is the endpoint: §8's status bar names it, and
    // "unreachable at :11434" for a run configured against :1234 sends the user
    // to restart the wrong program.
    expect(error).toBeInstanceOf(OllamaUnreachableError);
    expect((error as OllamaUnreachableError).endpoint).toBe(`${baseUrl}/v1/chat/completions`);
    expect((error as OllamaUnreachableError).message).toContain(
      `${baseUrl}/v1/chat/completions`,
    );
  });

  it("names LM Studio — not Ollama — in the message the user reads", async () => {
    // For the person this client was written for, the error text is the entire
    // diagnostic: they cannot ask anyone what went wrong, and after a reload
    // §6.7's flat string is all that is left. "Ollama is unreachable at :1234"
    // sends them to restart a program they are not running.
    const baseUrl = await closedPortBaseUrl();
    const error = (await createLmStudioClient(baseUrl)
      .listModels()
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toContain("LM Studio is unreachable");
    expect(error.message).not.toContain("Ollama");
    // The URL actually tried, in full — the difference between "the server is
    // not running" and "the port in my environment variable is wrong".
    expect(error.message).toContain(`${baseUrl}/v1/models`);
  });

  it("tells the reader both things that could be wrong", async () => {
    const baseUrl = await closedPortBaseUrl();
    const error = (await createLmStudioClient(baseUrl)
      .generate({ model: "m", prompt: "p" })
      .catch((e: unknown) => e)) as Error;

    // Start the server, or point the app elsewhere. Naming the variable is what
    // makes the second one actionable without reading the source.
    expect(error.message).toContain("start LM Studio's local server");
    expect(error.message).toContain("LMSTUDIO_BASE_URL");
  });

  it("quotes the authority the user configured, not the address it resolved to", async () => {
    // A hostname, pointed at a port nothing is listening on. `fetch` resolves the
    // name to connect, so a message built from the resolved address would read
    // `127.0.0.1` (or `::1`) and leave the reader comparing it to a hostname they
    // never see in their own config.
    const closed = await closedPortBaseUrl();
    const port = new URL(closed).port;
    const error = (await createLmStudioClient(`http://localhost:${port}`)
      .listModels()
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toContain(`http://localhost:${port}/v1/models`);
  });

  it("names /v1/models for listModels", async () => {
    const baseUrl = await closedPortBaseUrl();
    const error = await createLmStudioClient(baseUrl)
      .listModels()
      .catch((e: unknown) => e);
    expect((error as OllamaUnreachableError).endpoint).toBe(`${baseUrl}/v1/models`);
  });

  it("names /v1/chat/completions for vision and chatWithTools", async () => {
    const baseUrl = await closedPortBaseUrl();
    const client = createLmStudioClient(baseUrl);

    const visionError = await client
      .vision({ model: "m", prompt: "p", images: [] })
      .catch((e: unknown) => e);
    const chatError = await client
      .chatWithTools({ model: "m", messages: [], tools: [] })
      .catch((e: unknown) => e);

    expect((visionError as OllamaUnreachableError).endpoint).toBe(`${baseUrl}/v1/chat/completions`);
    expect((chatError as OllamaUnreachableError).endpoint).toBe(`${baseUrl}/v1/chat/completions`);
  });

  it("carries a name and message Wave 9 can flatten into SessionHistory.error", async () => {
    const baseUrl = await closedPortBaseUrl();
    const error = (await createLmStudioClient(baseUrl)
      .generate({ model: "m", prompt: "p" })
      .catch((e: unknown) => e)) as Error;

    // §6.7 stores `"<ErrorName>: <message>"`, which after a reload is the only
    // place the endpoint survives.
    expect(error.name).toBe("OllamaUnreachableError");
    expect(`${error.name}: ${error.message}`).toContain(`${baseUrl}/v1/chat/completions`);
  });

  it("surfaces an in-flight abort as a timeout carrying the model", async () => {
    const fixture = await startServer(hang);
    const error = await createLmStudioClient(fixture.baseUrl)
      .generate({ model: "qwen3-vl", prompt: "p", signal: AbortSignal.timeout(40) })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaTimeoutError);
    expect((error as OllamaTimeoutError).model).toBe("qwen3-vl");
    expect((error as OllamaTimeoutError).elapsedMs).toBeGreaterThanOrEqual(30);
    // A timeout means it connected, so the port was right — but the message
    // still has to name the program that went quiet.
    expect((error as OllamaTimeoutError).message).toContain("LM Studio call to qwen3-vl");
  });

  it("reports an aborted vision call as a timeout, not an unreachable", async () => {
    const fixture = await startServer(hang);
    const error = await createLmStudioClient(fixture.baseUrl)
      .vision({
        model: "critic",
        prompt: "p",
        images: [IMAGE],
        signal: AbortSignal.timeout(30),
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaTimeoutError);
    expect((error as OllamaTimeoutError).model).toBe("critic");
  });

  it("reports a non-2xx with the status, the LM Studio endpoint and the model", async () => {
    const fixture = await startServer(
      replyJson({ error: "model not found" }, 404),
    );
    const error = await createLmStudioClient(fixture.baseUrl)
      .generate({ model: "ghost-7b", prompt: "p" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaHttpError);
    const http = error as OllamaHttpError;
    expect(http.status).toBe(404);
    expect(http.endpoint).toBe(`${fixture.baseUrl}/v1/chat/completions`);
    expect(http.model).toBe("ghost-7b");
    expect(http.message).toContain(`${fixture.baseUrl}/v1/chat/completions`);
    expect(http.message).toContain("404");
    expect(http.message).toContain("LM Studio returned 404");
    // `ollama pull` is not a command an LM Studio user can run, and a remedy
    // that does not exist is worse than none. The hint is the provider's.
    expect(http.message).not.toContain("ollama pull");
    expect(http.message).toContain("load `ghost-7b` in LM Studio");
  });

  it("reports a 400 from the chat endpoint without inventing a fix", async () => {
    // The shape A15 recorded from a real server: a model that cannot reason
    // answers a thinking request with 400. Only the 404 arm carries a remedy, and
    // it is Ollama's — see the known wart in A15.
    const fixture = await startServer(
      replyJson({ error: { message: "does not support thinking" } }, 400),
    );
    const error = (await createLmStudioClient(fixture.baseUrl)
      .chatWithTools({ model: "m", messages: [], tools: [] })
      .catch((e: unknown) => e)) as OllamaHttpError;

    expect(error.status).toBe(400);
    expect(error.message).toContain("does not support thinking");
    expect(error.message).not.toContain("ollama pull");
  });
});
