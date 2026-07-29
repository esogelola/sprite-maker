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
 * Each test prints what it received. That log is the *point* of the committed
 * capture at `captures/2026-07-29-wave-5-live-smoke.txt`: a green tick proves the
 * assertions held, but only the printed payload shows a later reader what a real
 * model actually put on the wire on the day this shipped.
 */

import { describe, expect, it } from "vitest";

import { createOllamaClient } from "@main/ollama";
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
        prompt: "/no_think Reply with a single short word.",
        options: { temperature: 0, seed: 1 },
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
          content: "/no_think Place a pixel at x=3 y=4 with index 2, then reply DONE.",
        },
      ];

      const first = await client.chatWithTools({
        model: GENERATOR,
        messages,
        tools: [PLACE_PIXEL],
        options: { temperature: 0, seed: 7 },
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
      });

      report("chatWithTools() turn 2 — ChatTurn", second);
      report("transcript sent on turn 2 — ChatMessage[]", messages);

      expect(typeof second.content).toBe("string");
      expect(Array.isArray(second.toolCalls)).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );
});
