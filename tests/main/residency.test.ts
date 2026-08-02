/**
 * `main/residency.ts` — the model residency policy, spec amendment A17.
 *
 * **Every probe here runs against a real `http.createServer` and asserts on the
 * requests that arrived**, the way `lmstudio.test.ts` does. The reason is
 * sharper than usual: half of this feature's contract is about requests that
 * must **not** happen. "The shipped default costs nothing" is a claim about an
 * empty request log, and no amount of asserting on a returned object can make
 * it. A mocked `fetch` would let the same code pass while probing on every run.
 *
 * The other half is the falsy-zero surface, which on this feature is the worst
 * it has been in this project:
 *
 * - **`keep_alive: 0` is the entire eviction mechanism**, and `0` is falsy. That
 *   one is pinned on the wire in `ollama.test.ts`, where the request body is.
 * - **A model `size` of `0`** must not read as "this model is free". It is the
 *   one wrong answer that produces the OOM this feature exists to prevent.
 * - **A headroom factor of `0`** is a legal, if extreme, budget — "assume
 *   nothing fits" — and `factor || DEFAULT` silently restores 0.6.
 * - **`os.totalmem()` returning `0`** must not become a budget of zero that
 *   nothing explains.
 *
 * And `os.freemem()` must never appear at all: it read 2.1 GB free of 34.4 GB
 * total on an idle machine, because macOS excludes purgeable pages and Linux
 * excludes the page cache. A decision keyed off it would be sequential
 * everywhere, always, for a reason nobody could see.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GenerateRequest, LlmClient } from "@main/ollama";
import {
  ASSUMED_MODEL_BYTES,
  MEMORY_HEADROOM,
  createResidencyRunner,
  resolveResidency,
  type ResidencyDecision,
} from "@main/residency";

// ---------------------------------------------------------------------------
// the HTTP fixture — the same one lmstudio.test.ts uses
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

interface Fixture {
  baseUrl: string;
  requests: CapturedRequest[];
}

type Handler = (captured: CapturedRequest, res: ServerResponse) => void;

const openServers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
      const captured: CapturedRequest = { method: req.method ?? "", url: req.url ?? "", body };
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

function replyJson(payload: unknown, status = 200): Handler {
  return (_captured, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
}

/** A server that accepts the connection and never answers — a firewalled port. */
function silence(): Handler {
  return () => {
    // Deliberately no `res.end`.
  };
}

// ---------------------------------------------------------------------------
// the numbers this machine actually reports
// ---------------------------------------------------------------------------

/** `GET /api/tags`, as the real Ollama answers it. */
function tags(entries: ReadonlyArray<readonly [string, number]>): Record<string, unknown> {
  return { models: entries.map(([name, size]) => ({ name, model: name, size })) };
}

/** `qwen3-vl:8b-instruct-q4_K_M`, measured on the machine this was written on. */
const VL_8B_BYTES = 6_140_415_975;
/** `qwen3:8b-q4_K_M`, same source. */
const QWEN3_8B_BYTES = 5_225_388_164;
/** 32 GiB — `os.totalmem()` on the development machine. */
const TOTAL_32_GIB = 34_359_738_368;
/** 16 GiB — the memory-constrained host this whole amendment is for. */
const TOTAL_16_GIB = 17_179_869_184;

const GEN = "qwen3-vl:8b-instruct-q4_K_M";
const CRITIC = "qwen3:8b-q4_K_M";

// ---------------------------------------------------------------------------
// rule zero — the shipped default, and it must be provably free
// ---------------------------------------------------------------------------

describe("rule zero: one model in both roles", () => {
  it("issues no request at all, and resolves concurrent", async () => {
    const fixture = await startServer(replyJson(tags([[GEN, VL_8B_BYTES]])));

    const decision = await resolveResidency(
      {
        provider: "ollama",
        baseUrl: fixture.baseUrl,
        models: { generator: GEN, critic: GEN },
        configured: "auto",
      },
      { totalMemBytes: TOTAL_16_GIB },
    );

    expect(decision.policy).toBe("concurrent");
    // The whole claim. Not "one request", not "a cheap request" — none.
    expect(fixture.requests).toEqual([]);
    expect(decision.reason).toContain(GEN);
  });

  it("stays a no-op even when the config asks for sequential", async () => {
    // Rule zero comes *before* the configured policy: evicting a model you are
    // about to load again is pure loss, and 10s per switch is the cost this
    // amendment exists to avoid paying when it is not needed.
    const fixture = await startServer(replyJson(tags([[GEN, VL_8B_BYTES]])));

    const decision = await resolveResidency(
      {
        provider: "ollama",
        baseUrl: fixture.baseUrl,
        models: { generator: GEN, critic: GEN },
        configured: "sequential",
      },
      { totalMemBytes: TOTAL_16_GIB },
    );

    expect(decision.policy).toBe("concurrent");
    expect(fixture.requests).toEqual([]);
  });

  it("says which model is serving both roles, not merely that nothing happens", async () => {
    const fixture = await startServer(replyJson(tags([])));

    const decision = await resolveResidency(
      {
        provider: "lmstudio",
        baseUrl: fixture.baseUrl,
        models: { generator: GEN, critic: GEN },
        configured: "auto",
      },
      { totalMemBytes: TOTAL_16_GIB },
    );

    expect(decision.reason).toContain(GEN);
    expect(decision.configured).toBe("auto");
    expect(fixture.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// an explicit policy answers the question, so nothing may re-ask it
// ---------------------------------------------------------------------------

describe("an explicit policy", () => {
  it("takes `sequential` without probing", async () => {
    const fixture = await startServer(replyJson(tags([[GEN, VL_8B_BYTES]])));

    const decision = await resolveResidency(
      {
        provider: "ollama",
        baseUrl: fixture.baseUrl,
        models: { generator: GEN, critic: CRITIC },
        configured: "sequential",
      },
      { totalMemBytes: TOTAL_32_GIB },
    );

    expect(decision.policy).toBe("sequential");
    expect(decision.configured).toBe("sequential");
    // The user answered the question — the same rule `detectProvider` applies to
    // an explicit `SPRITE_MAKER_PROVIDER`.
    expect(fixture.requests).toEqual([]);
  });

  it("takes `concurrent` without probing, even on a machine that cannot hold both", async () => {
    const fixture = await startServer(replyJson(tags([[GEN, VL_8B_BYTES]])));

    const decision = await resolveResidency(
      {
        provider: "ollama",
        baseUrl: fixture.baseUrl,
        models: { generator: GEN, critic: CRITIC },
        configured: "concurrent",
      },
      { totalMemBytes: TOTAL_16_GIB },
    );

    expect(decision.policy).toBe("concurrent");
    expect(fixture.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// auto on Ollama — real sizes, so this is the accurate path
// ---------------------------------------------------------------------------

describe("auto on Ollama", () => {
  const input = (baseUrl: string) =>
    ({
      provider: "ollama",
      baseUrl,
      models: { generator: GEN, critic: CRITIC },
      configured: "auto",
    }) as const;

  it("chooses sequential when the two models exceed the budget", async () => {
    const fixture = await startServer(
      replyJson(tags([[GEN, VL_8B_BYTES], [CRITIC, QWEN3_8B_BYTES]])),
    );

    const decision = await resolveResidency(input(fixture.baseUrl), {
      totalMemBytes: TOTAL_16_GIB,
    });

    expect(decision.policy).toBe("sequential");
    // The signal, not just the verdict: neither the user nor the author can
    // inspect the cobuilder's machine, and a heuristic they cannot see is one
    // they cannot debug.
    expect(decision.reason).toContain("6.1 GB");
    expect(decision.reason).toContain("5.2 GB");
    expect(decision.reason).toContain("17.2 GB");
    // The listing path the client already speaks, asked once.
    expect(fixture.requests.map((r) => r.url)).toEqual(["/api/tags"]);
    expect(fixture.requests[0].method).toBe("GET");
  });

  it("chooses concurrent when they fit", async () => {
    const fixture = await startServer(
      replyJson(tags([[GEN, VL_8B_BYTES], [CRITIC, QWEN3_8B_BYTES]])),
    );

    const decision = await resolveResidency(input(fixture.baseUrl), {
      totalMemBytes: TOTAL_32_GIB,
    });

    expect(decision.policy).toBe("concurrent");
    expect(decision.reason).toContain("6.1 GB");
    expect(decision.reason).toContain("34.4 GB");
  });

  it("treats a combined size exactly equal to the budget as fitting", async () => {
    // `>`, not `>=`: every threshold in this project is a maximum — "at most
    // this much" — and a pair that exactly fills the budget fits it.
    const fixture = await startServer(replyJson(tags([[GEN, 6e9], [CRITIC, 4e9]])));

    const decision = await resolveResidency(input(fixture.baseUrl), {
      totalMemBytes: 20e9,
      headroom: 0.5,
    });

    expect(decision.policy).toBe("concurrent");
  });

  it("chooses sequential one byte past the budget", async () => {
    const fixture = await startServer(replyJson(tags([[GEN, 6e9], [CRITIC, 4e9 + 1]])));

    const decision = await resolveResidency(input(fixture.baseUrl), {
      totalMemBytes: 20e9,
      headroom: 0.5,
    });

    expect(decision.policy).toBe("sequential");
  });

  it("does not read a reported size of 0 as a model that costs nothing", async () => {
    // Ollama reports `size: 405` for a cloud model, so a *small* size is a real
    // measurement and is honoured. `0` is not a size any local model has ever
    // carried, and "this model is free" is the single wrong answer that produces
    // the OOM the whole amendment exists to prevent.
    const fixture = await startServer(replyJson(tags([[GEN, 0], [CRITIC, QWEN3_8B_BYTES]])));

    const decision = await resolveResidency(input(fixture.baseUrl), {
      totalMemBytes: TOTAL_16_GIB,
    });

    expect(decision.policy).toBe("sequential");
    // And it says so, rather than quietly reporting a 5.2 GB pair that fits.
    expect(decision.reason).toContain(GEN);
    expect(decision.reason).toMatch(/no size|size unknown|unknown size/i);
  });

  it("falls back to an assumed size when a bound model is not in the listing", async () => {
    const fixture = await startServer(replyJson(tags([[GEN, VL_8B_BYTES]])));

    const decision = await resolveResidency(input(fixture.baseUrl), {
      totalMemBytes: TOTAL_16_GIB,
    });

    // 2 × the assumed size against a 16 GiB budget.
    expect(decision.policy).toBe("sequential");
    expect(decision.reason).toContain(CRITIC);
    expect(decision.reason).toContain((ASSUMED_MODEL_BYTES / 1e9).toFixed(1));
  });

  it("survives a listing that fails, and says the size is unknown", async () => {
    const fixture = await startServer(replyJson({ error: "nope" }, 500));

    const decision = await resolveResidency(input(fixture.baseUrl), {
      totalMemBytes: TOTAL_32_GIB,
    });

    // 2 × 6 GB against 20.6 GB of budget — it fits, and the reason says the
    // figure is an assumption rather than a measurement.
    expect(decision.policy).toBe("concurrent");
    expect(decision.reason).toMatch(/assum/i);
  });

  it("never asks Ollama for LM Studio's native listing", async () => {
    const fixture = await startServer(
      replyJson(tags([[GEN, VL_8B_BYTES], [CRITIC, QWEN3_8B_BYTES]])),
    );

    await resolveResidency(input(fixture.baseUrl), { totalMemBytes: TOTAL_16_GIB });

    expect(fixture.requests.map((r) => r.url)).not.toContain("/api/v0/models");
  });
});

// ---------------------------------------------------------------------------
// auto on LM Studio — sizes are not available, and it has to say so
// ---------------------------------------------------------------------------

describe("auto on LM Studio", () => {
  const input = (baseUrl: string) =>
    ({
      provider: "lmstudio",
      baseUrl,
      models: { generator: GEN, critic: CRITIC },
      configured: "auto",
    }) as const;

  it("probes the native endpoint once and falls back gracefully on a 404", async () => {
    // `/api/v0/models` is LM Studio's own listing; a build without it answers
    // 404, and a 404 is an answer rather than a failure.
    const fixture = await startServer(replyJson({ error: "not found" }, 404));

    const decision = await resolveResidency(input(fixture.baseUrl), {
      totalMemBytes: TOTAL_16_GIB,
    });

    expect(fixture.requests.map((r) => r.url)).toEqual(["/api/v0/models"]);
    expect(decision.policy).toBe("sequential");
    expect(decision.reason).toMatch(/size/i);
    expect(decision.reason).toContain("17.2 GB");
  });

  it("never falls back to `/v1/models`, which cannot carry a size", async () => {
    // OpenAI's listing is `id, object, created, owned_by` and nothing else, so
    // asking it for a size would be a request whose answer is known in advance.
    const fixture = await startServer(replyJson({ error: "not found" }, 404));

    await resolveResidency(input(fixture.baseUrl), { totalMemBytes: TOTAL_16_GIB });

    expect(fixture.requests.map((r) => r.url)).not.toContain("/v1/models");
  });

  it("uses a size from the native endpoint when a build reports one", async () => {
    // As of today no LM Studio build carries a size here (lmstudio-js#156 is the
    // open request for it). Read defensively so the day one does, the accurate
    // path switches itself on.
    const fixture = await startServer(
      replyJson({
        data: [
          { id: GEN, state: "not-loaded", size_bytes: 3e9 },
          { id: CRITIC, state: "loaded", size_bytes: 3e9 },
        ],
      }),
    );

    const decision = await resolveResidency(input(fixture.baseUrl), {
      totalMemBytes: TOTAL_16_GIB,
    });

    // 6 GB against a 10.3 GB budget.
    expect(decision.policy).toBe("concurrent");
    expect(decision.reason).toContain("3.0 GB");
  });

  it("is bounded — a native endpoint that never answers does not hang the decision", async () => {
    const fixture = await startServer(silence());

    const started = performance.now();
    const decision = await resolveResidency(input(fixture.baseUrl), {
      totalMemBytes: TOTAL_16_GIB,
      timeoutMs: 60,
    });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(2000);
    expect(decision.policy).toBe("sequential");
    expect(decision.reason).toMatch(/assum/i);
  });

  it("names LM Studio's own eviction setting, because this app cannot force it", async () => {
    const fixture = await startServer(replyJson({ error: "not found" }, 404));

    const decision = await resolveResidency(input(fixture.baseUrl), {
      totalMemBytes: TOTAL_16_GIB,
    });

    expect(decision.policy).toBe("sequential");
    // The one sentence the cobuilder can act on without reading this source.
    expect(decision.reason).toMatch(/max loaded models|auto-evict|JIT/i);
  });
});

// ---------------------------------------------------------------------------
// the memory signal
// ---------------------------------------------------------------------------

describe("the memory signal", () => {
  const input = (baseUrl: string) =>
    ({
      provider: "ollama",
      baseUrl,
      models: { generator: GEN, critic: CRITIC },
      configured: "auto",
    }) as const;

  it("defends a total of 0 rather than computing a budget from it", async () => {
    const fixture = await startServer(
      replyJson(tags([[GEN, VL_8B_BYTES], [CRITIC, QWEN3_8B_BYTES]])),
    );

    const decision = await resolveResidency(input(fixture.baseUrl), { totalMemBytes: 0 });

    expect(decision.policy).toBe("sequential");
    expect(decision.reason).toMatch(/totalmem|total memory/i);
    expect(decision.reason).not.toMatch(/NaN|Infinity/);
  });

  it("honours a headroom factor of 0 rather than substituting the default", async () => {
    // `factor || MEMORY_HEADROOM` is the mutation. A budget of zero means
    // "assume nothing fits", which is extreme and legal; silently restoring 0.6
    // makes a deliberately strict setting do the opposite of what it says.
    const fixture = await startServer(replyJson(tags([[GEN, 1e6], [CRITIC, 1e6]])));

    const decision = await resolveResidency(input(fixture.baseUrl), {
      totalMemBytes: TOTAL_32_GIB,
      headroom: 0,
    });

    expect(decision.policy).toBe("sequential");
    expect(decision.reason).toContain("0.0 GB");
  });

  it("uses os.totalmem() when no total is supplied", async () => {
    const fixture = await startServer(replyJson(tags([[GEN, 1e6], [CRITIC, 1e6]])));

    const decision = await resolveResidency(input(fixture.baseUrl));

    // Two 1 MB models fit any machine that can run this test at all.
    expect(decision.policy).toBe("concurrent");
    expect(decision.reason).toMatch(/\d+\.\d GB/);
  });

  it("never consults os.freemem()", () => {
    // Measured: 2.1 GB "free" of 34.4 GB total on an idle machine, because macOS
    // excludes purgeable and cached pages and Linux excludes the page cache. A
    // decision keyed off it is sequential everywhere, always, invisibly.
    //
    // Asserts it is neither imported nor called, rather than that the word is
    // absent: the module explains in prose why `freemem` must never be used, and
    // a bare word-ban would forbid the one comment most likely to stop someone
    // reintroducing it.
    const source = readFileSync(new URL("../../src/main/residency.ts", import.meta.url), "utf8");
    // Comments stripped first. The module documents the ban in prose — including
    // the exact call it is banning — so scanning the raw text finds the warning
    // and reports it as the offence.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/freemem/);
    expect(code).toMatch(/totalmem\s*\(/);
  });

  it("ships a headroom factor that leaves room for the rest of the machine", () => {
    expect(MEMORY_HEADROOM).toBeGreaterThan(0);
    expect(MEMORY_HEADROOM).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// the runner — who gets evicted, and when
// ---------------------------------------------------------------------------

/** An `LlmClient` that records nothing but its releases. */
function recordingClient(
  release?: (model: string) => Promise<void>,
): { client: LlmClient; released: string[] } {
  const released: string[] = [];
  const client: LlmClient = {
    listModels: async () => [],
    generate: async (_req: GenerateRequest) => "",
    vision: async () => "",
    chatWithTools: async () => ({ content: "", toolCalls: [] }),
    release: async (model: string) => {
      released.push(model);
      if (release !== undefined) await release(model);
    },
  };
  return { client, released };
}

const decisionOf = (policy: "sequential" | "concurrent"): ResidencyDecision => ({
  configured: "auto",
  policy,
  reason: "pinned by the test",
});

describe("the residency runner", () => {
  it("evicts the outgoing model when the model changes under sequential", async () => {
    const { client, released } = recordingClient();
    const runner = createResidencyRunner(decisionOf("sequential"), client);

    await runner.enter(GEN);
    await runner.enter(CRITIC);

    // The model being LEFT, never the one being entered. Evicting the incoming
    // model is a mutation that leaves the call count identical.
    expect(released).toEqual([GEN]);
  });

  it("evicts nothing on the first stage — nothing is resident yet", async () => {
    const { client, released } = recordingClient();
    const runner = createResidencyRunner(decisionOf("sequential"), client);

    await runner.enter(GEN);

    expect(released).toEqual([]);
  });

  it("evicts nothing when the same model is entered twice", async () => {
    const { client, released } = recordingClient();
    const runner = createResidencyRunner(decisionOf("sequential"), client);

    await runner.enter(GEN);
    await runner.enter(GEN);
    await runner.enter(GEN);

    expect(released).toEqual([]);
  });

  it("alternates across a whole run, one eviction per actual switch", async () => {
    const { client, released } = recordingClient();
    const runner = createResidencyRunner(decisionOf("sequential"), client);

    // draft → critique → revise → critique, the shape of a 2-round run.
    await runner.enter(GEN);
    await runner.enter(CRITIC);
    await runner.enter(GEN);
    await runner.enter(CRITIC);

    expect(released).toEqual([GEN, CRITIC, GEN]);
  });

  it("evicts nothing under concurrent, however many times the model changes", async () => {
    const { client, released } = recordingClient();
    const runner = createResidencyRunner(decisionOf("concurrent"), client);

    await runner.enter(GEN);
    await runner.enter(CRITIC);
    await runner.enter(GEN);

    expect(released).toEqual([]);
  });

  it("survives a release that rejects, and keeps going", async () => {
    // A failed unload must not kill a run: the model is still resident, the next
    // call still works, and the worst case is the swap this policy was avoiding.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, released } = recordingClient(async () => {
      throw new Error("connection reset");
    });
    const runner = createResidencyRunner(decisionOf("sequential"), client);

    await runner.enter(GEN);
    await expect(runner.enter(CRITIC)).resolves.toBeUndefined();
    await expect(runner.enter(GEN)).resolves.toBeUndefined();

    expect(released).toEqual([GEN, CRITIC]);
    expect(warn).toHaveBeenCalled();
  });

  it("does nothing when the provider cannot evict at all", async () => {
    // A typed absence, not a silent no-op: `release` is optional on `LlmClient`,
    // so a provider without one is a compile-time fact.
    const client: LlmClient = {
      listModels: async () => [],
      generate: async () => "",
      vision: async () => "",
      chatWithTools: async () => ({ content: "", toolCalls: [] }),
    };
    const runner = createResidencyRunner(decisionOf("sequential"), client);

    await expect(runner.enter(GEN)).resolves.toBeUndefined();
    await expect(runner.enter(CRITIC)).resolves.toBeUndefined();
  });

  it("carries the decision it was built from", async () => {
    const { client } = recordingClient();
    const decision = decisionOf("sequential");

    expect(createResidencyRunner(decision, client).decision).toEqual(decision);
  });
});
