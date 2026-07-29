/**
 * The scripted `OllamaClient` that Waves 6, 7, 8 and 9 test against — plan Wave 5.
 *
 * This is a **deliverable**, not a test helper. `draft.test.ts`, `critique.test.ts`,
 * `revise.test.ts` and `pipeline.test.ts` all assert against this recording
 * surface, so its shape is pinned in the plan and its semantics are pinned here.
 *
 * Three properties are what make it usable, and each one is a defect this file
 * exists to prevent:
 *
 * **1. Per-method queues, one ordered call log.** `generate`, `vision` and
 * `chatWithTools` each consume their own queue, so a Wave 9 pipeline script reads
 * `{ generate: [draft], vision: [round1, round2], chatWithTools: [...turns] }`
 * without anyone counting how many calls of *other* kinds fall between them. But
 * `calls` is a single array in call order, so the interleaving —
 * `generate → vision → chatWithTools × N → vision` — is still inspectable, which
 * is the thing a pipeline test is actually about.
 *
 * **2. Recorded arguments are snapshotted, not aliased.** Wave 8's revise loop
 * appends to *one* `messages` array across up to 40 turns. If this stub stored
 * the reference, every recorded call would point at the final transcript, and
 * "the assistant turn carries `tool_calls`" — the assertion Wave 8's acceptance
 * criterion 5 names — would be checking the end state rather than what turn 3
 * actually sent. A loop that appended nothing until the last turn would pass.
 *
 * This applies to **every** mutable thing that crosses the boundary, not only
 * `messages`: `options` (a seeded bench bumps `seed` on one object between
 * calls), `tools` (a pipeline may withhold `done` until turn 2), `images`, and
 * the array `listModels` hands back (§9's pickers sort it). Each of those is
 * pinned by a named test in `tests/main/ollama.test.ts`, and each of those tests
 * exists because the recording surface is only worth what its oldest entry is
 * still true about. Waves 6–9 are invited to extend this file — extend the tests
 * with it.
 *
 * `tool_call_id` is the sharpest case and gets its own test: it is how a tool
 * result names the call it answers, the whole subject of the wire-format
 * capture, and it appears in no transcript any other test sends.
 *
 * **3. The last entry is reused when a queue is exhausted.** This is what makes
 * "a script that never calls `done()`" a one-line fixture: Wave 8 scripts a
 * single tool-calling turn and the cap test runs it 40 times.
 *
 * @see docs/superpowers/plans/2026-07-28-sprite-maker-mvp.md — Wave 5, task 5.1
 */

import type {
  ChatWithToolsRequest,
  GenerateRequest,
  OllamaClient,
  VisionRequest,
} from "@main/ollama";
import type { ChatMessage, ChatTurn, ToolDef } from "@shared/schema";

/**
 * One call, as it arrived. Every field the four methods can carry, so a consumer
 * inspects `calls[i].prompt` or `calls[i].images` without narrowing on `method`
 * first — the pinned shape from plan Wave 5.
 *
 * `model` is required by that shape, so `listModels` — which has no model —
 * records the empty string.
 */
export interface RecordedCall {
  method: "generate" | "vision" | "chatWithTools" | "listModels";
  model: string;
  system?: string;
  prompt?: string;
  images?: Buffer[];
  messages?: ChatMessage[];
  tools?: ToolDef[];
  options?: Record<string, unknown>;
  format?: string;
  /**
   * The A8 suppression flag, recorded because the plan pins both Wave 6's and
   * Wave 8's assertion as "assert on the stub's recorded call, not on the prompt
   * text" — the `/no_think` prefix those criteria used to name was measured
   * inert, and a prompt-text assertion could not tell the difference.
   */
  think?: boolean;
}

/**
 * What each method returns, in order. **The last entry is reused once a queue is
 * exhausted** — a one-entry queue answers every call.
 *
 * An `Error` entry is *thrown* rather than returned. The plan pins the queues as
 * `string[]` / `ChatTurn[]`; those types remain exactly assignable to these, so
 * every consumer written against the pinned shape compiles unchanged. The union
 * is widened because spec §7.1 draws `FAILED` edges out of `DRAFTING`,
 * `CRITIQUING` and `REVISING`, and §9 requires an `OllamaTimeoutError` during
 * `CRITIQUING` to be mirrored into `SessionHistory.error` — and a stub that can
 * only succeed gives Wave 9 no way to reach any of those edges.
 *
 * Absent is not the same as empty: calling a method with no queue throws a stub
 * error naming the method, because a test that forgot to script `vision` should
 * say so rather than fail four frames deep inside `parseCritique`.
 */
export interface StubScript {
  generate?: ReadonlyArray<string | Error>;
  vision?: ReadonlyArray<string | Error>;
  chatWithTools?: ReadonlyArray<ChatTurn | Error>;
  models?: readonly string[] | Error;
}

export interface StubClient extends OllamaClient {
  /** Every call, in call order, across all four methods. */
  calls: RecordedCall[];
  /** Back to the state `createStubClient` returned: log emptied, queues rewound. */
  reset(): void;
}

/**
 * One method's response queue.
 *
 * `cursor` keeps advancing past the end so an exhausted queue is still a fact a
 * future assertion could read, while `at` clamps — reuse of the last entry is
 * the documented behaviour, not an accident of indexing.
 */
class ResponseQueue<T> {
  private cursor = 0;

  constructor(
    private readonly method: string,
    private readonly entries: readonly T[] | undefined,
  ) {}

  next(): T {
    const entries = this.entries;
    if (entries === undefined || entries.length === 0) {
      throw new Error(
        `stub script has no \`${this.method}\` entries, but \`${this.method}()\` ` +
          `was called — add \`${this.method}: [...]\` to the script`,
      );
    }
    const at = Math.min(this.cursor, entries.length - 1);
    this.cursor++;
    return entries[at];
  }

  reset(): void {
    this.cursor = 0;
  }
}

/** Deep enough that a caller mutating its own transcript cannot rewrite history. */
function snapshotMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const copy: ChatMessage = { role: m.role, content: m.content };
    if (m.tool_calls !== undefined) {
      copy.tool_calls = m.tool_calls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: { ...c.arguments },
      }));
    }
    if (m.tool_call_id !== undefined) copy.tool_call_id = m.tool_call_id;
    return copy;
  });
}

/**
 * A copy of a scripted turn.
 *
 * Returned rather than the script's own object because the last entry is reused:
 * a consumer that pushed the returned `toolCalls` array into a transcript and
 * then mutated it would be editing the script for every later turn, and the
 * resulting test would fail in a turn that has nothing to do with the cause.
 */
function copyTurn(turn: ChatTurn): ChatTurn {
  return {
    content: turn.content,
    toolCalls: turn.toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      arguments: { ...c.arguments },
    })),
  };
}

/** Throws `entry` if it is an `Error`, otherwise returns it. */
function unwrap<T>(entry: T | Error): T {
  if (entry instanceof Error) throw entry;
  return entry;
}

export function createStubClient(script: StubScript): StubClient {
  const calls: RecordedCall[] = [];
  const generateQueue = new ResponseQueue("generate", script.generate);
  const visionQueue = new ResponseQueue("vision", script.vision);
  const chatQueue = new ResponseQueue("chatWithTools", script.chatWithTools);

  /** Only the fields this call actually carried — an absent key stays absent. */
  function record(call: RecordedCall): void {
    calls.push(call);
  }

  function recordTextCall(
    method: "generate" | "vision",
    req: GenerateRequest | VisionRequest,
    images?: readonly Buffer[],
  ): void {
    const call: RecordedCall = { method, model: req.model, prompt: req.prompt };
    if (req.system !== undefined) call.system = req.system;
    if (images !== undefined) call.images = [...images];
    if (req.options !== undefined) call.options = { ...req.options };
    if (req.format !== undefined) call.format = req.format;
    if (req.think !== undefined) call.think = req.think;
    record(call);
  }

  return {
    calls,

    reset(): void {
      // In place, so a `const { calls } = stub` binding taken before the reset
      // still observes the cleared log.
      calls.length = 0;
      generateQueue.reset();
      visionQueue.reset();
      chatQueue.reset();
    },

    async listModels(): Promise<string[]> {
      record({ method: "listModels", model: "" });
      const models = script.models;
      if (models instanceof Error) throw models;
      return [...(models ?? [])];
    },

    async generate(req: GenerateRequest): Promise<string> {
      recordTextCall("generate", req);
      return unwrap(generateQueue.next());
    },

    async vision(req: VisionRequest): Promise<string> {
      recordTextCall("vision", req, req.images);
      return unwrap(visionQueue.next());
    },

    async chatWithTools(req: ChatWithToolsRequest): Promise<ChatTurn> {
      const call: RecordedCall = {
        method: "chatWithTools",
        model: req.model,
        messages: snapshotMessages(req.messages),
        tools: [...req.tools],
      };
      if (req.options !== undefined) call.options = { ...req.options };
      if (req.think !== undefined) call.think = req.think;
      record(call);
      return copyTurn(unwrap(chatQueue.next()));
    },
  };
}
