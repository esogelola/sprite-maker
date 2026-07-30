/**
 * The bounded agentic loop — spec §6.6, plan Wave 8.
 *
 * Most of this file is about the *transcript*, not about pixels. `revise()` is
 * the one stage the model drives, and every way it fails in production is a way
 * the conversation is malformed rather than a way the arithmetic is wrong: an
 * assistant turn that loses its `tool_calls`, a rejected call that throws
 * instead of answering, a turn that fires no tool and is not counted. None of
 * those change a pixel, and all of them burn the cap.
 *
 * So the assertions lean on `stub.calls[i].messages` — the per-turn snapshot
 * Wave 5b pinned precisely so a test can read what turn 3 actually sent rather
 * than what the transcript looked like at the end.
 */

import { describe, expect, it, vi } from "vitest";

import type { ChatWithToolsRequest, OllamaClient } from "@main/ollama";
import { REVISE_TOOLS, revise } from "@main/revise";
import { createStubClient, type StubClient } from "../stubs/ollama";
import { HarnessConfigSchema, type ChatMessage, type ChatTurn, type Issue, type ToolCall } from "@shared/schema";
import { BLANK, SPRITE_32, SPRITE_64 } from "../fixtures/sprites";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: args,
});

/** One scripted assistant turn. */
const turn = (content: string, ...toolCalls: ToolCall[]): ChatTurn => ({ content, toolCalls });

/** A turn that fires a tool and says nothing — the ordinary case. */
const calls = (...toolCalls: ToolCall[]): ChatTurn => turn("", ...toolCalls);

const cfg = (overrides: Record<string, unknown> = {}) => HarnessConfigSchema.parse(overrides);

const ISSUE: Issue = {
  id: "eye-1",
  region: [3, 4, 6, 7],
  severity: "high",
  issue: "the eyes sit one cell too far left",
  suggest: "shift the left eye one cell right",
  confidence: 0.9,
  suggestConfidence: 0.8,
};

/** Every `tool` message in a recorded transcript, in order. */
const toolMessages = (messages: ChatMessage[] | undefined): ChatMessage[] =>
  (messages ?? []).filter((m) => m.role === "tool");

/** Every `assistant` message in a recorded transcript, in order. */
const assistantMessages = (messages: ChatMessage[] | undefined): ChatMessage[] =>
  (messages ?? []).filter((m) => m.role === "assistant");

/**
 * A client that refuses to be called more than `limit` times.
 *
 * Non-termination is the failure the cap tests exist to catch, and a test
 * cannot assert on the return value of a function that never returns. Without
 * this fuse a loop that fails to count a turn simply grows the transcript until
 * the vitest worker is killed — measured at 21 seconds, reported as
 * "Worker exited unexpectedly", with no test name and no line number attached.
 * The fuse turns "spins forever" into an ordinary assertion failure on the
 * first turn past the bound.
 */
const withCallFuse = (stub: StubClient, limit: number): StubClient => ({
  ...stub,
  async chatWithTools(req) {
    if (stub.calls.length >= limit) {
      throw new Error(
        `revise() reached model call ${limit + 1} with a cap of ${limit} — the turn cap did not stop it`,
      );
    }
    return stub.chatWithTools(req);
  },
});

/**
 * One parameter's JSON-Schema fragment out of `REVISE_TOOLS`.
 *
 * `ToolDef.parameters` is `Record<string, unknown>` on purpose — it is data we
 * hand the model, not a shape `shared/schema.ts` validates — so a test that
 * wants to read it has to narrow it here rather than at every assertion.
 */
interface JsonSchemaFragment {
  type?: unknown;
  anyOf?: unknown;
  description?: unknown;
}

const paramSchema = (toolName: string, param: string): JsonSchemaFragment => {
  const tool = REVISE_TOOLS.find((t) => t.function.name === toolName);
  const properties = tool?.function.parameters.properties as
    | Record<string, JsonSchemaFragment>
    | undefined;
  const fragment = properties?.[param];
  if (fragment === undefined) {
    throw new Error(`REVISE_TOOLS declares no \`${toolName}\` parameter named \`${param}\``);
  }
  return fragment;
};

/** Every JSON-Schema `type` a fragment admits, flattened across its `anyOf`. */
const admittedTypes = (fragment: JsonSchemaFragment): string[] => {
  const branches: JsonSchemaFragment[] = Array.isArray(fragment.anyOf)
    ? (fragment.anyOf as JsonSchemaFragment[])
    : [fragment];
  return branches.flatMap((b) => (typeof b.type === "string" ? [b.type] : []));
};

/**
 * A client that records the `AbortSignal` of every turn and answers from a
 * script, reusing its last entry the way `createStubClient` does.
 *
 * `RecordedCall` carries no signal and `tests/stubs/ollama.ts` belongs to Wave
 * 5, so the per-call deadline (§6.8) is observed through a local client — the
 * same shape `draft.test.ts` uses for the same reason.
 */
function signalProbe(script: ChatTurn[]): {
  client: OllamaClient;
  signals: (AbortSignal | undefined)[];
} {
  const signals: (AbortSignal | undefined)[] = [];
  const unscripted = async (): Promise<never> => {
    throw new Error("revise() called a method other than chatWithTools()");
  };
  const client: OllamaClient = {
    listModels: unscripted,
    generate: unscripted,
    vision: unscripted,
    async chatWithTools(req: ChatWithToolsRequest): Promise<ChatTurn> {
      signals.push(req.signal);
      return script[Math.min(signals.length - 1, script.length - 1)];
    },
  };
  return { client, signals };
}

/**
 * A client whose turn never settles until its own `AbortSignal` fires.
 *
 * A request that carried no signal is rejected immediately and by name: a
 * deadline-less loop would otherwise hang here until vitest killed the worker,
 * and "Worker exited unexpectedly" names no test and no line.
 */
function hangingClient(): OllamaClient {
  const unscripted = async (): Promise<never> => {
    throw new Error("revise() called a method other than chatWithTools()");
  };
  return {
    listModels: unscripted,
    generate: unscripted,
    vision: unscripted,
    chatWithTools(req: ChatWithToolsRequest): Promise<ChatTurn> {
      return new Promise<ChatTurn>((_resolve, reject) => {
        const signal = req.signal;
        if (signal === undefined) {
          reject(new Error("revise() armed no deadline: the turn carried no signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// REVISE_TOOLS
// ---------------------------------------------------------------------------

describe("REVISE_TOOLS", () => {
  it("offers exactly the three tools spec §6.6 names", () => {
    expect(REVISE_TOOLS.map((t) => t.function.name)).toEqual([
      "place_pixel",
      "fill_row",
      "done",
    ]);
  });

  it("is a well-formed Ollama tool array", () => {
    for (const tool of REVISE_TOOLS) {
      expect(tool.type).toBe("function");
      expect(tool.function.description.length).toBeGreaterThan(0);
      expect(tool.function.parameters.type).toBe("object");
      expect(tool.function.parameters.properties).toBeTypeOf("object");
    }
  });

  it("declares fill_row's x1 as inclusive, which is the one thing a model cannot guess", () => {
    const fillRow = REVISE_TOOLS.find((t) => t.function.name === "fill_row");
    expect(fillRow?.function.description.toLowerCase()).toContain("inclusive");
  });

  it('declares `index` as number-or-string, because `"."` is the only way to CLEAR a cell', () => {
    // Spec §6.6 types `index` as `number | "."`, and `"."` is a string. A
    // schema narrowed to `{ type: "integer" }` still passes every behavioural
    // test in this file — the stub never reads the schema — while telling a
    // schema-obedient model that transparency is unrepresentable, which makes
    // clearing a pixel impossible for the rest of the run. Nothing but an
    // assertion on `REVISE_TOOLS` itself can see that.
    const index = paramSchema("place_pixel", "index");
    const types = admittedTypes(index);

    expect(types).toContain("integer");
    expect(types).toContain("string");
    // And the string branch is named in the prose the model actually reads.
    expect(String(index.description)).toContain('"."');

    // `fill_row` clears spans by the same route and shares the same fragment;
    // a narrowing applied to one of the two is the same defect half-sized.
    expect(admittedTypes(paramSchema("fill_row", "index"))).toEqual(types);
  });
});

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

describe("revise — the happy path", () => {
  it("applies a place_pixel then stops on done", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 5, y: 7, index: 2 })),
        calls(call("c2", "done", { summary: "moved the eye" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [ISSUE], cfg());

    expect(result.turns).toBe(2);
    expect(result.hitCap).toBe(false);
    expect(result.summary).toBe("moved the eye");
    expect(result.grid[7]).toBe(".....2..........");
    // Exactly one cell moved; nothing else did.
    expect(result.grid.filter((row) => row !== "................")).toHaveLength(1);
  });

  it("returns a Grid and never a SpriteDoc — the pipeline owns `meta` (§7.5)", async () => {
    const stub = createStubClient({
      chatWithTools: [calls(call("c1", "done", { summary: "nothing to do" }))],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    expect(Array.isArray(result.grid)).toBe(true);
    expect(result.grid).toHaveLength(16);
    expect(Object.keys(result).sort()).toEqual(["grid", "hitCap", "summary", "turns"]);
    // A Grid is `string[]`. A doc would have brought `meta`, `id` and `rows`
    // with it, and every round would then share the draft's identity.
    expect(result).not.toHaveProperty("meta");
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("rows");
  });

  it("leaves the caller's document untouched", async () => {
    const before = [...BLANK.rows];
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 0, y: 0, index: 1 })),
        calls(call("c2", "done", { summary: "done" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    expect(BLANK.rows).toEqual(before);
    expect(result.grid).not.toEqual(before);
  });

  it("returns a grid that is never an ALIAS of the document, even when nothing changed", async () => {
    // The round where the agent calls `done` immediately is the only one where
    // no `setPixel` ever runs, so it is the only one where the initial value
    // can escape by reference. Wave 9 stores this grid on a round snapshot and
    // §6.7 requires those snapshots to be safe to hold: an alias means a later
    // hand edit rewrites the history of a round that already happened.
    const stub = createStubClient({
      chatWithTools: [calls(call("c1", "done", { summary: "already correct" }))],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    expect(result.grid).toEqual([...BLANK.rows]);
    expect(result.grid).not.toBe(BLANK.rows);
  });

  it("applies fill_row inclusively of x1", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "fill_row", { y: 3, x0: 2, x1: 5, index: 1 })),
        calls(call("c2", "done", { summary: "filled" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    // 2..5 inclusive is FOUR cells, not three.
    expect(result.grid[3]).toBe("..1111..........");
  });

  it("applies every call in a multi-call turn, in order", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(
          call("c1", "place_pixel", { x: 0, y: 0, index: 1 }),
          call("c2", "place_pixel", { x: 1, y: 0, index: 2 }),
          call("c3", "place_pixel", { x: 2, y: 0, index: 3 }),
        ),
        calls(call("c4", "done", { summary: "three pixels" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    expect(result.grid[0]).toBe("123.............");
    expect(result.turns).toBe(2);
  });

  it("clears a cell with the `.` index", async () => {
    // SPRITE_32 row 4 is the canopy's top edge, filled with `3` at x = 11..20 —
    // so this asserts a real clear rather than a cell that was already empty.
    expect(SPRITE_32.rows[4][11]).toBe("3");

    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 11, y: 4, index: "." })),
        calls(call("c2", "done", { summary: "cleared" })),
      ],
    });

    const result = await revise({ client: stub }, SPRITE_32, [], cfg());

    expect(result.grid[4][11]).toBe(".");
  });

  it('clears a cell it painted EARLIER IN THE SAME RUN back to transparent with `"."`', async () => {
    // The behavioural half of the schema's `"."` branch. Clearing a fixture
    // cell shows that `.` reaches `setPixel`; clearing a cell this run painted
    // shows the round trip — paint, then undo — which is the edit a model
    // actually makes when the critique says a limb is one cell too long.
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 9, y: 9, index: 2 })),
        calls(call("c2", "place_pixel", { x: 9, y: 9, index: "." })),
        calls(call("c3", "done", { summary: "painted, then took it back" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    // Turn 1 painted it — asserted on the tool result so a grid that was never
    // dirty in the first place cannot pass this as a clear.
    expect(toolMessages(stub.calls[1].messages)[0].content).toContain("`2`");
    expect(toolMessages(stub.calls[2].messages)[1].content).toContain("`.`");
    expect(result.grid[9]).toBe("................");
    expect(result.grid).toEqual([...BLANK.rows]);
  });
});

// ---------------------------------------------------------------------------
// the transcript — acceptance criterion 5
// ---------------------------------------------------------------------------

describe("revise — transcript integrity", () => {
  it("appends the assistant turn INCLUDING tool_calls before the tool results", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 5, y: 7, index: 2 })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    await revise({ client: stub }, BLANK, [ISSUE], cfg());

    // Turn 2's transcript is what turn 1 left behind.
    const sent = stub.calls[1].messages ?? [];
    const assistant = assistantMessages(sent);
    expect(assistant).toHaveLength(1);
    expect(assistant[0].tool_calls).toEqual([
      { id: "c1", name: "place_pixel", arguments: { x: 5, y: 7, index: 2 } },
    ]);
  });

  it("puts the assistant turn BEFORE the tool result, not after", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 5, y: 7, index: 2 })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    await revise({ client: stub }, BLANK, [ISSUE], cfg());

    const sent = stub.calls[1].messages ?? [];
    const assistantAt = sent.findIndex((m) => m.role === "assistant");
    const toolAt = sent.findIndex((m) => m.role === "tool");
    expect(assistantAt).toBeGreaterThanOrEqual(0);
    expect(toolAt).toBeGreaterThan(assistantAt);
  });

  it("answers every tool call with a tool message naming its id", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(
          call("alpha", "place_pixel", { x: 0, y: 0, index: 1 }),
          call("beta", "place_pixel", { x: 1, y: 0, index: 2 }),
        ),
        calls(call("gamma", "done", { summary: "ok" })),
      ],
    });

    await revise({ client: stub }, BLANK, [], cfg());

    const results = toolMessages(stub.calls[1].messages);
    expect(results.map((m) => m.tool_call_id)).toEqual(["alpha", "beta"]);
  });

  it("opens with a system message and a user message carrying the issues and the grid", async () => {
    const stub = createStubClient({
      chatWithTools: [calls(call("c1", "done", { summary: "ok" }))],
    });

    await revise({ client: stub }, BLANK, [ISSUE], cfg());

    const sent = stub.calls[0].messages ?? [];
    expect(sent[0].role).toBe("system");
    expect(sent[1].role).toBe("user");
    expect(sent[1].content).toContain("the eyes sit one cell too far left");
    // The grid as text — spec §7.4.
    expect(sent[1].content).toContain("................");
  });

  it("grows the transcript monotonically — a turn never rewrites an earlier one", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 0, y: 0, index: 1 })),
        calls(call("c2", "place_pixel", { x: 1, y: 1, index: 2 })),
        calls(call("c3", "done", { summary: "ok" })),
      ],
    });

    await revise({ client: stub }, BLANK, [], cfg());

    const first = stub.calls[0].messages ?? [];
    const second = stub.calls[1].messages ?? [];
    const third = stub.calls[2].messages ?? [];
    expect(second.length).toBeGreaterThan(first.length);
    expect(third.length).toBeGreaterThan(second.length);
    // The prefix is stable — this is what the snapshot invariant buys.
    expect(second.slice(0, first.length)).toEqual(first);
    expect(third.slice(0, second.length)).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// invalid calls — acceptance criterion 2
// ---------------------------------------------------------------------------

describe("revise — an invalid call answers, it does not throw", () => {
  it("reports an out-of-bounds place_pixel as a tool result and keeps going", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 99, y: 0, index: 1 })),
        calls(call("c2", "place_pixel", { x: 1, y: 1, index: 1 })),
        calls(call("c3", "done", { summary: "recovered" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    const rejected = toolMessages(stub.calls[1].messages)[0];
    expect(rejected.content).toContain("out-of-bounds");
    expect(rejected.tool_call_id).toBe("c1");
    // The loop continued and the later, valid edit landed.
    expect(result.turns).toBe(3);
    expect(result.hitCap).toBe(false);
    expect(result.grid[1]).toBe(".1..............");
  });

  it("reports an off-palette index against the DOCUMENT's palette", async () => {
    // BLANK is `gameboy` — four colours, so index 9 does not exist here even
    // though the encoding can spell it.
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 0, y: 0, index: 9 })),
        calls(call("c2", "done", { summary: "gave up" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    expect(toolMessages(stub.calls[1].messages)[0].content).toContain("off-palette");
    expect(result.grid[0]).toBe("................");
  });

  it("accepts on a 16-colour palette the index it refuses on a 4-colour one", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 0, y: 0, index: 9 })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, SPRITE_32, [], cfg());

    expect(toolMessages(stub.calls[1].messages)[0].content).not.toContain("off-palette");
    expect(result.grid[0][0]).toBe("9");
  });

  it("reports a reversed fill_row span without throwing", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "fill_row", { y: 2, x0: 9, x1: 4, index: 1 })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    const rejected = toolMessages(stub.calls[1].messages)[0];
    expect(rejected.content).toContain("out-of-bounds");
    expect(rejected.content).toContain("x1");
    expect(result.grid[2]).toBe("................");
  });

  it("reports a fill_row that runs off the right edge", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "fill_row", { y: 2, x0: 10, x1: 40, index: 1 })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    expect(toolMessages(stub.calls[1].messages)[0].content).toContain("out-of-bounds");
    expect(result.grid[2]).toBe("................");
  });

  it("reports an unparseable index rather than painting something arbitrary", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 0, y: 0, index: "greenish" })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    expect(toolMessages(stub.calls[1].messages)[0].content).toMatch(/error/i);
    expect(result.grid[0]).toBe("................");
  });

  it("reports a missing argument", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 3, index: 1 })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    const rejected = toolMessages(stub.calls[1].messages)[0];
    expect(rejected.content).toMatch(/error/i);
    expect(rejected.content).toContain("y");
    expect(result.grid).toEqual([...BLANK.rows]);
  });

  it("reports an unknown tool name and names the three real ones", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "paint_bucket", { x: 0, y: 0 })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    await revise({ client: stub }, BLANK, [], cfg());

    const rejected = toolMessages(stub.calls[1].messages)[0];
    expect(rejected.content).toContain("place_pixel");
    expect(rejected.content).toContain("fill_row");
    expect(rejected.content).toContain("done");
  });

  it("keeps the valid half of a turn whose other call was rejected", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(
          call("bad", "place_pixel", { x: 99, y: 99, index: 1 }),
          call("good", "place_pixel", { x: 2, y: 2, index: 1 }),
        ),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    const results = toolMessages(stub.calls[1].messages);
    expect(results[0].content).toContain("out-of-bounds");
    expect(results[1].content).not.toMatch(/error/i);
    expect(result.grid[2]).toBe("..1.............");
  });

  it("an invalid call still costs a turn", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 99, y: 0, index: 1 })),
        calls(call("c2", "place_pixel", { x: 98, y: 0, index: 1 })),
        calls(call("c3", "done", { summary: "gave up" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());
    expect(result.turns).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// numeric-string coercion — amendment P10
// ---------------------------------------------------------------------------

describe("revise — numeric strings are coerced before validation", () => {
  it("accepts `\"3\"` where the contract says 3", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: "5", y: "7", index: "3" })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    expect(toolMessages(stub.calls[1].messages)[0].content).not.toMatch(/error/i);
    expect(result.grid[7]).toBe(".....3..........");
  });

  it("coerces fill_row's span too", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "fill_row", { y: "3", x0: "2", x1: "5", index: "1" })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());
    expect(result.grid[3]).toBe("..1111..........");
  });

  it("tolerates surrounding whitespace", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: " 5 ", y: "7", index: 3 })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());
    expect(result.grid[7]).toBe(".....3..........");
  });

  it("accepts the hex-digit spelling of an index, which is what the prompt shows it", async () => {
    // The grid is rendered to the model as row text, where index 11 is `b`.
    // A model that reads `bbbb` and answers `"b"` is describing the colour it
    // was shown; rejecting that burns turns for no gain, and it is unambiguous
    // because `"3"` reads the same as a digit and as a decimal.
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 0, y: 0, index: "b" })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, SPRITE_32, [], cfg());

    expect(toolMessages(stub.calls[1].messages)[0].content).not.toMatch(/error/i);
    expect(result.grid[0][0]).toBe("b");
  });

  it("still refuses a non-numeric coordinate", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: "left", y: 0, index: 1 })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    expect(toolMessages(stub.calls[1].messages)[0].content).toMatch(/error/i);
    expect(result.grid).toEqual([...BLANK.rows]);
  });

  it("still refuses a fractional coordinate rather than rounding it", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: "5.5", y: 7, index: 1 })),
        calls(call("c2", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    expect(toolMessages(stub.calls[1].messages)[0].content).toMatch(/error/i);
    expect(result.grid).toEqual([...BLANK.rows]);
  });
});

// ---------------------------------------------------------------------------
// zero-tool-call turns — acceptance criterion 3
// ---------------------------------------------------------------------------

describe("revise — index 0", () => {
  // Index 0 is the second falsy-zero near-miss in this project: Wave 4's
  // `pickCriticBackground` did not count it as *used*, and returned #000000 as
  // the "most distant" background for a black-outlined sprite. Nothing here
  // used index 0 at all, so a `if (!index)` anywhere in the coercion would have
  // made palette entry 0 unpaintable — and entry 0 is #000000 in pico-8 and
  // #140c1c in db16, i.e. the outline colour of most sprites.
  it("paints with the NUMBER 0 rather than reading it as absent", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 5, y: 7, index: 0 })),
        calls(call("c2", "done", { summary: "outlined" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [ISSUE], cfg());

    expect(result.grid[7]).toBe(".....0..........");
    expect(toolMessages(stub.calls[1]?.messages)[0]?.content).not.toMatch(/error/i);
  });

  it("paints with the STRING \"0\", where the hex and decimal spellings coincide", async () => {
    // For index 0 the two spellings are the same three bytes, unlike index 11
    // ("b" vs "11"). That coincidence is why this case can hide: a coercion
    // that only handles one path still passes.
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 2, y: 3, index: "0" })),
        calls(call("c2", "done", { summary: "outlined" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [ISSUE], cfg());

    expect(result.grid[3]).toBe("..0.............");
  });

  it("clears with `\".\"` and repaints with 0, so the two are not confused", async () => {
    // `"."` and index 0 are both "the falsy-looking one". Clearing then
    // painting in the same run proves they take different branches.
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 4, y: 4, index: 0 })),
        calls(call("c2", "place_pixel", { x: 4, y: 4, index: "." })),
        calls(call("c3", "place_pixel", { x: 6, y: 4, index: 0 })),
        calls(call("c4", "done", { summary: "cleared and repainted" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [ISSUE], cfg());

    expect(result.grid[4]).toBe("......0.........");
  });

  it("fills a row with index 0", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "fill_row", { y: 9, x0: 2, x1: 5, index: 0 })),
        calls(call("c2", "done", { summary: "filled" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [ISSUE], cfg());

    expect(result.grid[9]).toBe("..0000..........");
  });
});

describe("revise — the per-call deadline (§6.8)", () => {
  // The only bound this stage has against a hung model. `RecordedCall` carries
  // no signal, so it is observed through the local probes above.
  it("arms a FRESH signal on every turn", async () => {
    const { client, signals } = signalProbe([
      calls(call("c1", "place_pixel", { x: 1, y: 1, index: 1 })),
      calls(call("c2", "place_pixel", { x: 2, y: 2, index: 1 })),
      calls(call("c3", "done", { summary: "done" })),
    ]);

    await revise({ client }, BLANK, [ISSUE], cfg());

    expect(signals).toHaveLength(3);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
    // A shared controller would re-arm one object; a shared *signal* would fire
    // the whole loop's deadline on the first turn's clock.
    expect(new Set(signals).size).toBe(3);
  });

  it("aborts a turn that never settles, rather than hanging the loop", async () => {
    await expect(
      revise({ client: hangingClient() }, BLANK, [ISSUE], cfg({ callTimeoutMs: 40 })),
    ).rejects.toThrow();
  });

  it("scales the deadline with canvas area, so a 64×64 gets more time than a 16×16", async () => {
    // §6.8: callTimeoutMs × (w×h)/(32×32). A 16×16 gets a quarter of the base,
    // a 64×64 gets four times it — a 16× spread. Inverting the scaling (÷ where
    // × was meant) would give the large canvas a quarter and abort legitimate
    // calls on exactly the size that needs the most room.
    const timed = async (doc: typeof BLANK): Promise<number> => {
      const started = performance.now();
      await revise({ client: hangingClient() }, doc, [ISSUE], cfg({ callTimeoutMs: 40 })).catch(
        () => undefined,
      );
      return performance.now() - started;
    };

    const small = await timed(BLANK); // 16×16 → 10ms
    const large = await timed(SPRITE_64); // 64×64 → 160ms

    expect(large).toBeGreaterThan(small * 2);
  });
});

describe("revise — a turn with no tool calls", () => {
  it("counts against the cap and injects a nudge naming the three tools", async () => {
    const stub = createStubClient({
      chatWithTools: [
        turn("Let me think about the eye placement."),
        calls(call("c1", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [ISSUE], cfg());

    expect(result.turns).toBe(2);

    const sent = stub.calls[1].messages ?? [];
    const nudge = sent[sent.length - 1];
    expect(nudge.role).toBe("user");
    expect(nudge.content).toContain("place_pixel");
    expect(nudge.content).toContain("fill_row");
    expect(nudge.content).toContain("done");
  });

  it("keeps the model's own prose in the transcript so it does not simply repeat it", async () => {
    const stub = createStubClient({
      chatWithTools: [
        turn("Let me think about the eye placement."),
        calls(call("c1", "done", { summary: "ok" })),
      ],
    });

    await revise({ client: stub }, BLANK, [], cfg());

    const sent = stub.calls[1].messages ?? [];
    const assistant = assistantMessages(sent);
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe("Let me think about the eye placement.");
  });

  it("terminates when EVERY turn fires no tool — three of them against a cap of two", async () => {
    // Acceptance criterion 3, spelled exactly as the reviewer will script it.
    // Counting only tool-firing turns spins here forever, on a message array
    // that grows but never changes shape.
    const stub = createStubClient({
      chatWithTools: [turn("thinking..."), turn("still thinking..."), turn("hmm.")],
    });

    // Fused one turn past the cap: if the loop does not count these turns it
    // fails here and names the reason, instead of running out of memory.
    const result = await revise(
      { client: withCallFuse(stub, 3) },
      BLANK,
      [ISSUE],
      cfg({ maxReviseTurns: 2 }),
    );

    expect(result.turns).toBe(2);
    expect(result.hitCap).toBe(true);
    expect(stub.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// the cap — acceptance criterion 4
// ---------------------------------------------------------------------------

describe("revise — the turn cap", () => {
  it("stops at maxReviseTurns when done is never called, keeping the landed edits", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 1, y: 1, index: 1 })),
        calls(call("c2", "place_pixel", { x: 2, y: 2, index: 2 })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [ISSUE], cfg({ maxReviseTurns: 3 }));

    expect(result.turns).toBe(3);
    expect(result.hitCap).toBe(true);
    // Both edits survive the cap — a loop that discards them on the way out
    // throws away the only work the round did.
    expect(result.grid[1]).toBe(".1..............");
    expect(result.grid[2]).toBe("..2.............");
  });

  it("honours maxReviseTurns exactly — no off-by-one in either direction", async () => {
    for (const cap of [1, 2, 3, 7]) {
      const stub = createStubClient({
        chatWithTools: [calls(call("c1", "place_pixel", { x: 0, y: 0, index: 1 }))],
      });

      const result = await revise({ client: stub }, BLANK, [], cfg({ maxReviseTurns: cap }));

      expect(result.turns).toBe(cap);
      expect(stub.calls).toHaveLength(cap);
      expect(result.hitCap).toBe(true);
    }
  });

  it("does not report hitCap when done lands on the very last permitted turn", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 0, y: 0, index: 1 })),
        calls(call("c2", "done", { summary: "just in time" })),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg({ maxReviseTurns: 2 }));

    expect(result.turns).toBe(2);
    expect(result.hitCap).toBe(false);
    expect(result.summary).toBe("just in time");
  });

  it("stops the moment done is called and never sends another turn", async () => {
    const stub = createStubClient({
      chatWithTools: [calls(call("c1", "done", { summary: "already correct" }))],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg({ maxReviseTurns: 40 }));

    expect(result.turns).toBe(1);
    expect(stub.calls).toHaveLength(1);
    expect(result.hitCap).toBe(false);
  });

  it("applies the edits in a turn that also calls done", async () => {
    const stub = createStubClient({
      chatWithTools: [
        calls(
          call("c1", "place_pixel", { x: 4, y: 4, index: 1 }),
          call("c2", "done", { summary: "one pixel and out" }),
        ),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());

    expect(result.turns).toBe(1);
    expect(result.hitCap).toBe(false);
    expect(result.summary).toBe("one pixel and out");
    expect(result.grid[4]).toBe("....1...........");
  });

  it("answers and applies calls that follow done in the SAME turn", async () => {
    // Incoherent model output, but it happens, and it is the one ordering that
    // separates "finish the turn, then stop" from "stop mid-turn". Breaking on
    // `done` before the loop over the turn's calls finishes drops both the edit
    // and — worse — the tool result, leaving the last call unanswered.
    const stub = createStubClient({
      chatWithTools: [
        calls(
          call("c1", "done", { summary: "finished" }),
          call("c2", "place_pixel", { x: 6, y: 6, index: 1 }),
        ),
      ],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg({ maxReviseTurns: 5 }));

    expect(result.turns).toBe(1);
    expect(result.summary).toBe("finished");
    expect(result.grid[6]).toBe("......1.........");
  });

  it("reports a summary a reader can act on when the cap was hit", async () => {
    const stub = createStubClient({
      chatWithTools: [calls(call("c1", "place_pixel", { x: 0, y: 0, index: 1 }))],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg({ maxReviseTurns: 2 }));

    // Not the agent's words — it never gave any — but not empty either: this
    // string is what the filmstrip and the bench CSV render for the round.
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary).toContain("2");
  });
});

// ---------------------------------------------------------------------------
// model binding and A8 — acceptance criterion, spec §7.4
// ---------------------------------------------------------------------------

describe("revise — model binding and think suppression", () => {
  it("binds to models.generator, not models.critic", async () => {
    const stub = createStubClient({
      chatWithTools: [calls(call("c1", "done", { summary: "ok" }))],
    });

    await revise(
      { client: stub },
      BLANK,
      [],
      cfg({ models: { generator: "gen-model", critic: "critic-model" } }),
    );

    expect(stub.calls[0].model).toBe("gen-model");
  });

  it("sends think: false on EVERY turn — asserted on the recorded call, not the prompt", async () => {
    const stub = createStubClient({
      chatWithTools: [calls(call("c1", "place_pixel", { x: 0, y: 0, index: 1 }))],
    });

    await revise({ client: stub }, BLANK, [], cfg({ maxReviseTurns: 5 }));

    expect(stub.calls).toHaveLength(5);
    for (const recorded of stub.calls) {
      // `false`, not `undefined`: an omitted key leaves the decision to the
      // model, and qwen3 chooses to reason. Measured 86x more tokens.
      expect(recorded.think).toBe(false);
    }
  });

  it("offers REVISE_TOOLS on every turn", async () => {
    const stub = createStubClient({
      chatWithTools: [calls(call("c1", "place_pixel", { x: 0, y: 0, index: 1 }))],
    });

    await revise({ client: stub }, BLANK, [], cfg({ maxReviseTurns: 3 }));

    for (const recorded of stub.calls) {
      expect(recorded.tools?.map((t) => t.function.name)).toEqual([
        "place_pixel",
        "fill_row",
        "done",
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// onTurn — behaviour 6
// ---------------------------------------------------------------------------

describe("revise — onTurn", () => {
  it("fires once per turn, 1-based and in order", async () => {
    const onTurn = vi.fn();
    const stub = createStubClient({
      chatWithTools: [
        calls(call("c1", "place_pixel", { x: 0, y: 0, index: 1 })),
        calls(call("c2", "place_pixel", { x: 1, y: 1, index: 1 })),
        calls(call("c3", "done", { summary: "ok" })),
      ],
    });

    const result = await revise({ client: stub, onTurn }, BLANK, [], cfg());

    expect(onTurn.mock.calls).toEqual([[1], [2], [3]]);
    expect(onTurn).toHaveBeenCalledTimes(result.turns);
  });

  it("fires per TURN, not per tool call", async () => {
    const onTurn = vi.fn();
    const stub = createStubClient({
      chatWithTools: [
        calls(
          call("c1", "place_pixel", { x: 0, y: 0, index: 1 }),
          call("c2", "place_pixel", { x: 1, y: 0, index: 1 }),
          call("c3", "place_pixel", { x: 2, y: 0, index: 1 }),
        ),
        calls(call("c4", "done", { summary: "ok" })),
      ],
    });

    await revise({ client: stub, onTurn }, BLANK, [], cfg());

    // Four calls across two turns.
    expect(onTurn.mock.calls).toEqual([[1], [2]]);
  });

  it("fires on a turn that fired no tool at all", async () => {
    const onTurn = vi.fn();
    const stub = createStubClient({
      chatWithTools: [turn("thinking"), calls(call("c1", "done", { summary: "ok" }))],
    });

    await revise({ client: stub, onTurn }, BLANK, [], cfg());

    expect(onTurn.mock.calls).toEqual([[1], [2]]);
  });

  it("is optional", async () => {
    const stub = createStubClient({
      chatWithTools: [calls(call("c1", "done", { summary: "ok" }))],
    });

    await expect(revise({ client: stub }, BLANK, [], cfg())).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// done()
// ---------------------------------------------------------------------------

describe("revise — done", () => {
  it("tolerates a done() with no summary rather than burning the rest of the cap", async () => {
    const stub = createStubClient({
      chatWithTools: [calls(call("c1", "done", {}))],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg({ maxReviseTurns: 10 }));

    expect(result.turns).toBe(1);
    expect(result.hitCap).toBe(false);
    expect(typeof result.summary).toBe("string");
  });

  it("coerces a non-string summary rather than rejecting the only call that ends the loop", async () => {
    const stub = createStubClient({
      chatWithTools: [calls(call("c1", "done", { summary: 42 }))],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg({ maxReviseTurns: 10 }));

    expect(result.turns).toBe(1);
    expect(result.hitCap).toBe(false);
    expect(result.summary).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// the client's own failures
// ---------------------------------------------------------------------------

describe("revise — client failures", () => {
  it("propagates an Ollama error rather than swallowing it into a summary", async () => {
    // Spec §7.1 draws a FAILED edge out of REVISING; swallowing the error here
    // would report a successful round that never ran.
    const stub = createStubClient({
      chatWithTools: [new Error("Ollama is unreachable at http://127.0.0.1:11434")],
    });

    await expect(revise({ client: stub }, BLANK, [], cfg())).rejects.toThrow("unreachable");
  });
});

// ---------------------------------------------------------------------------
// no `meta` construction — acceptance criterion 6
// ---------------------------------------------------------------------------

describe("revise — the empty issue list", () => {
  it("still runs, because §7.3 user feedback arrives as an issue list of one", async () => {
    const stub = createStubClient({
      chatWithTools: [calls(call("c1", "done", { summary: "nothing to do" }))],
    });

    const result = await revise({ client: stub }, BLANK, [], cfg());
    expect(result.turns).toBe(1);
    expect(stub.calls[0].messages?.[1].content).toBeTypeOf("string");
  });
});
