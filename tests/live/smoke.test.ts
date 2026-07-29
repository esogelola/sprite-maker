/**
 * The live smoke test — spec §10, plan Wave 5 task 5.7.
 *
 * **Opt-in.** `vitest.config.ts` includes `tests/**` and is not in Wave 5's
 * whitelist, so the guard is in this file: without `LIVE` in the environment
 * every test below is skipped and `npm test` stays green with Ollama stopped,
 * which is Wave 5's first acceptance criterion. Run it with `npm run test:live`.
 *
 * **Nothing here asserts on content.** A local 8B model is not a deterministic
 * function and a test that expects it to say a particular thing is a test that
 * fails on a model update, at which point it gets deleted rather than fixed.
 * What these three assert is that the *wire format* still holds against a real
 * server — which is the only thing the HTTP fixture in `tests/main/ollama.test.ts`
 * cannot prove, because that fixture is a server this repo wrote.
 *
 * The `chatWithTools` case is here for the same reason it gets the most
 * attention in the unit tests: `captures/2026-07-29-wave-5-tool-call-wire-format.txt`
 * records that the wrong `tool_calls` marshalling produces no error at all — just
 * a model that repeats itself until Wave 8's turn cap runs out. A fixture cannot
 * catch that. Ollama can.
 *
 * The `think: false` case is here for a third reason: it is the only assertion in
 * the project that can prove amendment A8 at all. The HTTP fixture proves the
 * client puts `think` on the wire as a top-level boolean, but whether that field
 * *empties the reasoning channel* is a fact about Ollama and Qwen 3, and no
 * server this repo wrote can testify to it.
 *
 * Each test prints what it received. That log is the *point* of the committed
 * capture at `captures/2026-07-29-wave-5-live-smoke.txt`: a green tick proves the
 * assertions held, but only the printed payload shows a later reader what a real
 * model actually put on the wire on the day this shipped.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { createOllamaClient, DEFAULT_OLLAMA_BASE_URL } from "@main/ollama";
import type { ChatMessage } from "@shared/schema";
import { DEFAULT_HARNESS_CONFIG } from "@shared/schema";

const GENERATOR = DEFAULT_HARNESS_CONFIG.models.generator;

/** A local 8B model at the measured 28.4 tok/s (spec §3) needs real headroom. */
const LIVE_TIMEOUT_MS = 180_000;

const PLACE_PIXEL = {
  type: "function",
  function: {
    name: "place_pixel",
    description: "Set one pixel of the sprite to a palette index.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        index: { type: "integer" },
      },
      required: ["x", "y", "index"],
    },
  },
} as const;

/** Writes real model output into the capture. Only ever runs under `LIVE`. */
function report(label: string, value: unknown): void {
  const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  console.log(`\n--- ${label} ---\n${rendered}\n`);
}

interface RecordingProxy {
  baseUrl: string;
  /** Ollama's own reply to each forwarded request, in order. */
  replies: Record<string, unknown>[];
  close(): Promise<void>;
}

/**
 * A recording pass-through in front of the real Ollama.
 *
 * `generate()` returns only `response` — deliberately, fact 3 in the client's
 * header — so the one field the A8 assertion has to read, `thinking`, never
 * reaches a caller. The alternative is to hand-write the request body here and
 * `fetch` it directly, but that would prove only that a body *this file* invented
 * suppresses reasoning; it would say nothing about the body the client sends, and
 * the trap A8 exists to close is a body that looks right. Proxying keeps the real
 * client on one side and the real model on the other, and reads the reply in
 * between.
 */
async function startRecordingProxy(): Promise<RecordingProxy> {
  const replies: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        try {
          const upstream = await fetch(`${DEFAULT_OLLAMA_BASE_URL}${req.url ?? ""}`, {
            method: req.method,
            headers: { "content-type": "application/json" },
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
          });
          const text = await upstream.text();
          try {
            replies.push(JSON.parse(text) as Record<string, unknown>);
          } catch {
            replies.push({});
          }
          res.writeHead(upstream.status, { "content-type": "application/json" });
          res.end(text);
        } catch (cause) {
          // Ollama is not running. Answering rather than dropping the socket is
          // the whole difference between a `test:live` that says so in a second
          // and one that sits on `LIVE_TIMEOUT_MS` and then reports an unhandled
          // rejection from a proxy the reader has to go find.
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `proxy could not reach Ollama: ${String(cause)}` }));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    replies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The reasoning channel as a string — "absent" and "empty" are the same claim. */
function thinkingOf(payload: Record<string, unknown> | undefined): string {
  const thinking = payload?.thinking;
  return typeof thinking === "string" ? thinking : "";
}

describe.skipIf(!process.env.LIVE)("live Ollama smoke", () => {
  const client = createOllamaClient();

  it(
    "lists the installed models",
    async () => {
      const models = await client.listModels();
      report("listModels()", models);

      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => typeof m === "string" && m.length > 0)).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "returns a non-empty string from a real generator call",
    async () => {
      const text = await client.generate({
        model: GENERATOR,
        // `think: false`, not a `/no_think` prefix: the prefix was measured to be
        // inert and on one prompt made things worse (amendment A8).
        prompt: "Reply with a single short word.",
        options: { temperature: 0, seed: 1 },
        think: false,
      });
      report(`generate() — ${GENERATOR}`, text);

      expect(typeof text).toBe("string");
      expect(text.trim().length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "round-trips a tool call through a real chat turn",
    async () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: "Place a pixel at x=3 y=4 with index 2, then reply DONE.",
        },
      ];

      const first = await client.chatWithTools({
        model: GENERATOR,
        messages,
        tools: [PLACE_PIXEL],
        options: { temperature: 0, seed: 7 },
        // Exactly the configuration Wave 8's revise loop runs under, so the
        // round trip is exercised the way it will actually be used.
        think: false,
      });

      report("chatWithTools() turn 1 — ChatTurn", first);

      // Structural only: that a `ChatTurn` came back well-formed, whatever the
      // model chose to do with the tool.
      expect(typeof first.content).toBe("string");
      expect(Array.isArray(first.toolCalls)).toBe(true);
      for (const call of first.toolCalls) {
        expect(typeof call.id).toBe("string");
        expect(call.id.length).toBeGreaterThan(0);
        expect(typeof call.name).toBe("string");
        expect(typeof call.arguments).toBe("object");
      }

      // Continue the conversation exactly as `revise.ts` will — the assistant's
      // own turn including its calls, then the results. If `messageToWire` ever
      // stops nesting `tool_calls`, this second turn is where a real Ollama
      // notices.
      messages.push({ role: "assistant", content: first.content, tool_calls: first.toolCalls });
      for (const call of first.toolCalls) {
        messages.push({ role: "tool", content: "ok", tool_call_id: call.id });
      }

      const second = await client.chatWithTools({
        model: GENERATOR,
        messages,
        tools: [PLACE_PIXEL],
        options: { temperature: 0, seed: 7 },
        think: false,
      });

      report("chatWithTools() turn 2 — ChatTurn", second);
      report("transcript sent on turn 2 — ChatMessage[]", messages);

      expect(typeof second.content).toBe("string");
      expect(Array.isArray(second.toolCalls)).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "empties the thinking channel when the client sends think: false — spec A8",
    async () => {
      const proxy = await startRecordingProxy();
      try {
        const proxied = createOllamaClient(proxy.baseUrl);
        // A prompt the model has a reason to reason about — the control half of
        // this test is only meaningful if reasoning is what it would otherwise do.
        const prompt = "What is 17 times 23? Reply with just the number.";
        const options = { temperature: 0, seed: 1 };

        const loud = await proxied.generate({ model: GENERATOR, prompt, options });
        const quiet = await proxied.generate({ model: GENERATOR, prompt, options, think: false });

        const [control, suppressed] = proxy.replies;
        report("A8 control — no think field", {
          response: loud,
          thinkingChars: thinkingOf(control).length,
          evalCount: control.eval_count,
        });
        report("A8 — think: false", {
          response: quiet,
          thinkingChars: thinkingOf(suppressed).length,
          evalCount: suppressed.eval_count,
        });

        // The claim amendment A8 rests on, and the only one no fixture can make:
        // against the running model, the top-level field empties the reasoning
        // channel. `thinkingOf` folds absent and empty together — either is
        // suppression.
        expect(thinkingOf(suppressed)).toBe("");

        // The control keeps the line above from passing vacuously: a model that
        // never reasons would satisfy it for free, and A8 would then be resting
        // on a test that proves nothing. If this line fails while the one above
        // passes, the model's defaults changed — not the client.
        expect(thinkingOf(control).length).toBeGreaterThan(0);
        expect(Number(suppressed.eval_count)).toBeLessThan(Number(control.eval_count));
      } finally {
        await proxy.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
