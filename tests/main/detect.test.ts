/**
 * `detectProvider` — spec amendment A16.
 *
 * A15 made LM Studio reachable and left one instruction behind:
 * `SPRITE_MAKER_PROVIDER=lmstudio`. For the person this whole provider exists
 * for — a cobuilder on Linux running LM Studio — that instruction is the same
 * class of thing they were already doing by hand. A16's claim is that the app
 * can find their server: clone, `npm run dev`, and the editor is talking to
 * whatever is actually running.
 *
 * **Neither the author nor the user can test Linux.** So these tests are the
 * contract, and the error string is the only diagnostic that reaches the other
 * machine. Every assertion below is either about which provider was chosen or
 * about the exact words someone will read when nothing was.
 *
 * Every probe here runs against a real `node:http` server on an ephemeral port,
 * the same fixture style as `tests/main/lmstudio.test.ts` and for the same
 * reason: detection is a statement about sockets, and a mocked `fetch` would let
 * "probed concurrently" and "probed serially" look identical.
 *
 * **The hazard this file exists for is `#7`.** A refused connection returns
 * instantly, which is what makes a serial, unbounded implementation look correct
 * on the machine it was written on. A firewalled port that black-holes packets
 * does not return at all — the app hangs on a blank window and the symptom points
 * at Electron rather than at networking. The concurrency and timeout tests
 * therefore use a server that **accepts the connection and never answers**; a
 * suite that only uses closed ports does not exercise this at all.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `@main/ipc` imports `ipcMain` at module scope, and outside Electron
// `require("electron")` resolves to a path string — so this is what makes test 8
// (the detection result reaching the UI) importable at all.
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

import { ipcMain } from "electron";

import { CHANNELS, registerIpc } from "@main/ipc";
import { DEFAULT_LMSTUDIO_BASE_URL } from "@main/lmstudio";
import { DEFAULT_OLLAMA_BASE_URL } from "@main/ollama";
import {
  createProviderControl,
  describeProbeFailure,
  detectProvider,
  PROBE_TIMEOUT_MS,
  UnknownProviderError,
} from "@main/provider";
import { HarnessConfigSchema } from "@shared/schema";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  baseUrl: string;
  /** Every path requested, in order. `/api/tags` is Ollama; `/v1/models` is not. */
  paths: string[];
  /**
   * `performance.now()` as each request arrived.
   *
   * The whole of the concurrency evidence. A serial implementation cannot get
   * its second request out before the first probe's budget expires, so the gap
   * between "detection started" and "this server was asked" separates the two
   * designs without depending on how long the whole call took.
   */
  arrivals: number[];
  port: number;
}

type Handler = (res: ServerResponse) => void;

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

async function startServer(handler: Handler): Promise<Fixture> {
  const paths: string[] = [];
  const arrivals: number[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    arrivals.push(performance.now());
    handler(res);
  });
  openServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, paths, arrivals, port };
}

/**
 * Answers any listing request in **both** dialects, so only the path identifies.
 *
 * A probe that read the wrong envelope would still succeed here, which keeps
 * these tests measuring the routing rather than the parsing.
 */
const answers: Handler = (res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ models: [{ name: "ollama-model" }], data: [{ id: "lmstudio-model" }] }));
};

/**
 * Accepts the connection and never answers — the firewall, not the closed port.
 *
 * This is the fixture the whole file turns on. A refused socket comes back in
 * under a millisecond, so it cannot distinguish a bounded probe from an
 * unbounded one, nor a concurrent sweep from a serial one.
 */
const blackHole: Handler = () => {};

/** A port that was listening and is not any more — an instant, honest refusal. */
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
// 1. an explicit choice is not second-guessed
// ---------------------------------------------------------------------------

describe("detectProvider — an explicit provider", () => {
  it("probes nothing at all when SPRITE_MAKER_PROVIDER names one", async () => {
    // The user's own setup must neither pay for detection nor be overridden by
    // it. Someone who has typed the variable has answered the question detection
    // exists to ask, and a probe that disagreed with them would be a bug with no
    // symptom other than a run attributed to the wrong provider.
    const ollama = await startServer(answers);
    const lmStudio = await startServer(answers);

    const resolution = await detectProvider({
      SPRITE_MAKER_PROVIDER: "lmstudio",
      OLLAMA_BASE_URL: ollama.baseUrl,
      LMSTUDIO_BASE_URL: lmStudio.baseUrl,
    });

    expect(resolution.provider).toBe("lmstudio");
    expect(resolution.baseUrl).toBe(lmStudio.baseUrl);
    expect(resolution.source).toBe("configured");
    expect(resolution.error).toBeNull();
    // Not one request, to either server.
    expect(ollama.paths).toEqual([]);
    expect(lmStudio.paths).toEqual([]);
    expect(resolution.probes).toEqual([]);
  });

  it("still exits loudly on an unknown provider rather than detecting one", async () => {
    // The opposite of a detection failure, and deliberately so: a typo'd provider
    // name cannot be fixed from inside an app that started against the wrong
    // server, so it stays fatal. `main/index.ts` turns this into `app.exit(1)`.
    const fixture = await startServer(answers);
    await expect(
      detectProvider({ SPRITE_MAKER_PROVIDER: "lmstduio", OLLAMA_BASE_URL: fixture.baseUrl }),
    ).rejects.toThrow(UnknownProviderError);
    expect(fixture.paths).toEqual([]);
  });

  it("treats an empty SPRITE_MAKER_PROVIDER as unset and detects", async () => {
    // `export SPRITE_MAKER_PROVIDER=` is a shell that has not chosen. A15 already
    // says that is not a typo; here it also means "please go and look".
    const ollama = await startServer(answers);
    const resolution = await detectProvider(
      {
        SPRITE_MAKER_PROVIDER: "",
        OLLAMA_BASE_URL: ollama.baseUrl,
        LMSTUDIO_BASE_URL: await closedPortBaseUrl(),
      },
      { timeoutMs: 500 },
    );

    expect(resolution.source).toBe("detected");
    expect(ollama.paths).toEqual(["/api/tags"]);
  });
});

// ---------------------------------------------------------------------------
// 2, 3, 4 — which one answers
// ---------------------------------------------------------------------------

describe("detectProvider — which server answered", () => {
  it("picks Ollama when only Ollama answers", async () => {
    // This machine.
    const ollama = await startServer(answers);
    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: ollama.baseUrl, LMSTUDIO_BASE_URL: await closedPortBaseUrl() },
      { timeoutMs: 500 },
    );

    expect(resolution.provider).toBe("ollama");
    expect(resolution.baseUrl).toBe(ollama.baseUrl);
    expect(resolution.source).toBe("detected");
    expect(resolution.error).toBeNull();
    // The listing endpoint the client already uses, not a second health path.
    expect(ollama.paths).toEqual(["/api/tags"]);
  });

  it("picks LM Studio when only LM Studio answers", async () => {
    // The cobuilder's machine, and the reason this amendment exists. Nothing is
    // set in their environment; the app has to find port 1234 by looking.
    const lmStudio = await startServer(answers);
    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: await closedPortBaseUrl(), LMSTUDIO_BASE_URL: lmStudio.baseUrl },
      { timeoutMs: 500 },
    );

    expect(resolution.provider).toBe("lmstudio");
    expect(resolution.baseUrl).toBe(lmStudio.baseUrl);
    expect(resolution.source).toBe("detected");
    expect(lmStudio.paths).toEqual(["/v1/models"]);
  });

  it("prefers Ollama when both answer, and says so about both", async () => {
    // Documented preference, not an accident of ordering. Every capture in this
    // project was measured against Ollama; a silent switch on a machine that
    // happens to be running both would invalidate the comparison while every
    // test stayed green.
    const ollama = await startServer(answers);
    const lmStudio = await startServer(answers);

    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: ollama.baseUrl, LMSTUDIO_BASE_URL: lmStudio.baseUrl },
      { timeoutMs: 500 },
    );

    expect(resolution.provider).toBe("ollama");
    expect(resolution.baseUrl).toBe(ollama.baseUrl);
    // Both were actually asked, and both actually answered — so the choice was a
    // preference between two live servers rather than a short-circuit that never
    // looked at the second one.
    expect(resolution.probes.map((p) => ({ provider: p.provider, up: p.up }))).toEqual([
      { provider: "ollama", up: true },
      { provider: "lmstudio", up: true },
    ]);
    expect(lmStudio.paths).toEqual(["/v1/models"]);
  });

  it("is deterministic across repeated runs when both answer", async () => {
    // The mutant this catches is a race: `Promise.any`, or "first to answer
    // wins", picks whichever server was quicker on the day and passes the test
    // above roughly half the time.
    const ollama = await startServer(answers);
    const lmStudio = await startServer(answers);
    const env = { OLLAMA_BASE_URL: ollama.baseUrl, LMSTUDIO_BASE_URL: lmStudio.baseUrl };

    const picks = [];
    for (let i = 0; i < 5; i++) {
      picks.push((await detectProvider(env, { timeoutMs: 500 })).provider);
    }
    expect(picks).toEqual(["ollama", "ollama", "ollama", "ollama", "ollama"]);
  });
});

// ---------------------------------------------------------------------------
// 5, 6 — nothing answered, and a probe that threw
// ---------------------------------------------------------------------------

describe("detectProvider — nothing answered", () => {
  it("reports both URLs and both providers, and is not fatal", async () => {
    // Their only diagnostic. Naming one URL tells someone running LM Studio that
    // Ollama is down, which is true, useless, and points at the wrong program.
    const ollamaUrl = await closedPortBaseUrl();
    const lmStudioUrl = await closedPortBaseUrl();

    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: ollamaUrl, LMSTUDIO_BASE_URL: lmStudioUrl },
      { timeoutMs: 500 },
    );

    // Resolved, not rejected: the app boots and the user fixes it in the UI.
    // Refusing to start would mean editing an environment variable to reach the
    // settings that edit the environment variable.
    expect(resolution.source).toBe("fallback");
    expect(resolution.provider).toBe("ollama");
    expect(resolution.error).not.toBeNull();

    const error = resolution.error ?? "";
    expect(error).toContain(`${ollamaUrl}/api/tags`);
    expect(error).toContain(`${lmStudioUrl}/v1/models`);
    expect(error).toContain("ollama");
    expect(error).toContain("lmstudio");
    // And the two ways out, spelled where they can be read without the source.
    expect(error).toContain("OLLAMA_BASE_URL");
    expect(error).toContain("LMSTUDIO_BASE_URL");
  });

  it("keeps the cause's own words when it carries no errno", () => {
    // Measured in the built app, not supposed. In **Electron's main process**
    // `fetch` is Chromium's rather than undici's, and its rejections do not all
    // carry `cause.code`: a refused connection does
    // (`ECONNREFUSED`, same as under Vitest), but a URL on Chromium's restricted
    // port list rejects with a cause whose **only** content is the message
    // `"bad port"`. Stopping at `error.message` printed `fetch failed` for that
    // case in the shipped app while this suite reported the errno — and in the
    // shipped app the message is the entire diagnostic.
    const noCode = new TypeError("fetch failed", { cause: new Error("bad port") });
    expect(describeProbeFailure(noCode, 1500)).toBe("bad port");

    const undici = new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
    expect(describeProbeFailure(undici, 1500)).toBe("ECONNREFUSED");

    const timedOut = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    expect(describeProbeFailure(timedOut, 400)).toBe("timed out after 400ms");

    // Nothing better to say — but never the empty string, which renders as a
    // sentence that stops mid-word.
    expect(describeProbeFailure(new Error("something else"), 1500)).toBe("something else");
    expect(describeProbeFailure("not an error", 1500)).not.toBe("");
  });

  it("records why each probe failed rather than only that it did", async () => {
    const ollamaUrl = await closedPortBaseUrl();
    const lmStudioUrl = await closedPortBaseUrl();
    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: ollamaUrl, LMSTUDIO_BASE_URL: lmStudioUrl },
      { timeoutMs: 500 },
    );

    expect(resolution.probes).toHaveLength(2);
    for (const probe of resolution.probes) {
      expect(probe.up).toBe(false);
      // "ECONNREFUSED" is the difference between "nothing is listening" and
      // "something is listening and refused me".
      expect(probe.detail ?? "").not.toBe("");
    }
  });

  it("still hands back a usable client, so the UI can be reached and fixed", async () => {
    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: await closedPortBaseUrl(), LMSTUDIO_BASE_URL: await closedPortBaseUrl() },
      { timeoutMs: 500 },
    );
    const control = createProviderControl(resolution);

    // The Ollama path, unchanged: a failed detection leaves exactly the client
    // this app has always constructed by default, and the same unreachable error
    // the status bar has always rendered.
    expect(control.status().provider).toBe("ollama");
    await expect(control.client().listModels()).rejects.toThrow(/unreachable/i);
  });

  it("treats a probe that throws as down rather than as fatal", async () => {
    // A malformed base URL makes `fetch` reject before a socket is ever opened.
    // A refused socket does the same thing one layer down. Either way the sweep
    // has to keep going: an unhandled rejection here is a startup crash, and the
    // window the user would fix it in never appears.
    const lmStudio = await startServer(answers);
    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: "not-a-url-at-all", LMSTUDIO_BASE_URL: lmStudio.baseUrl },
      { timeoutMs: 500 },
    );

    expect(resolution.provider).toBe("lmstudio");
    expect(resolution.probes[0]).toMatchObject({ provider: "ollama", up: false });
    expect(resolution.probes[0].detail ?? "").not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// 7 — the hazard: bounded and concurrent
// ---------------------------------------------------------------------------

describe("detectProvider — bounded and concurrent", () => {
  it("asks the second server before the first probe's budget expires", async () => {
    // The concurrency assertion, and the only one that can tell the two designs
    // apart. Ollama is probed first in any serial ordering, so a serial
    // implementation cannot ask LM Studio until Ollama's 600ms budget is spent.
    const stalled = await startServer(blackHole);
    const answering = await startServer(answers);

    const started = performance.now();
    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: stalled.baseUrl, LMSTUDIO_BASE_URL: answering.baseUrl },
      { timeoutMs: 800 },
    );
    const elapsed = performance.now() - started;

    // The other provider is still found, which is the user-visible half.
    expect(resolution.provider).toBe("lmstudio");
    expect(resolution.baseUrl).toBe(answering.baseUrl);

    // **The discriminator.** A serial sweep probes Ollama first and cannot ask
    // LM Studio until that 800ms budget is spent, so the second server's own
    // record of when it was asked separates the two designs without depending on
    // how long the whole call took — which is ≈800ms either way, because the
    // black hole is waited for in both.
    expect(answering.arrivals).toHaveLength(1);
    expect(answering.arrivals[0] - started).toBeLessThan(300);
    // And the stalled probe *was* waited for rather than abandoned, which is
    // what keeps the both-up preference deterministic: a sweep that returned as
    // soon as anything answered would pick whichever server was quicker.
    expect(stalled.arrivals).toHaveLength(1);
    expect(elapsed).toBeGreaterThanOrEqual(600);
    // One budget, not two.
    expect(elapsed).toBeLessThan(1600);
  });

  it(
    "completes when every port black-holes, instead of hanging forever",
    { timeout: 4000 },
    async () => {
      // Remove the abort signal and this test does not fail with a wrong value —
      // it never returns, and Vitest kills it at the timeout below. That is the
      // exact shape of the Linux failure: a blank window and no error.
      const a = await startServer(blackHole);
      const b = await startServer(blackHole);

      const started = performance.now();
      const resolution = await detectProvider(
        { OLLAMA_BASE_URL: a.baseUrl, LMSTUDIO_BASE_URL: b.baseUrl },
        { timeoutMs: 400 },
      );
      const elapsed = performance.now() - started;

      expect(resolution.source).toBe("fallback");
      expect(elapsed).toBeLessThan(2000);
      // The timeout is reported as the reason, not as a refusal — "nothing is
      // listening" and "something accepted my connection and went quiet" send
      // the reader to different places.
      expect(resolution.probes.every((p) => !p.up)).toBe(true);
      expect(resolution.error ?? "").toMatch(/time|abort/i);
    },
  );

  it("uses a probe budget of its own, nowhere near a model call's", () => {
    // §6.8 measures a model call in minutes and A12 puts a floor under it.
    // Reusing that number here would make a firewalled port a multi-minute blank
    // window, which is the failure this whole section is about.
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});

// ---------------------------------------------------------------------------
// 8 — the result reaches the UI
// ---------------------------------------------------------------------------

describe("detectProvider — the result reaches the UI", () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
  });

  it("crosses the IPC boundary as an envelope naming the provider and its URL", async () => {
    // "It picked LM Studio at :1234" has to be visible, not inferred. §6.7
    // flattens everything to strings and the status bar is the only surface a
    // remote cobuilder can screenshot, so a detection that only lives in a
    // closure is a detection nobody can confirm happened.
    const lmStudio = await startServer(answers);
    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: await closedPortBaseUrl(), LMSTUDIO_BASE_URL: lmStudio.baseUrl },
      { timeoutMs: 500 },
    );

    registerIpc({
      provider: createProviderControl(resolution),
      config: HarnessConfigSchema.parse({}),
      sessionDir: await mkdtemp(join(tmpdir(), "sprite-maker-detect-")),
      renderer: () => null,
    });

    const call = vi
      .mocked(ipcMain.handle)
      .mock.calls.find((c) => c[0] === CHANNELS.getProvider);
    expect(call, `no handler registered for '${CHANNELS.getProvider}'`).toBeDefined();

    const result = (await (call as unknown as [string, (e: unknown) => Promise<unknown>])[1]({})) as {
      ok: boolean;
      value: { provider: string; baseUrl: string; source: string; connected: boolean };
    };

    expect(result.ok).toBe(true);
    expect(result.value.provider).toBe("lmstudio");
    expect(result.value.baseUrl).toBe(lmStudio.baseUrl);
    expect(result.value.source).toBe("detected");
    expect(result.value.connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// falsy zero — a probe timeout of 0, a port of 0, an empty base URL
// ---------------------------------------------------------------------------

describe("falsy zero", () => {
  it("honours a probe timeout of 0 rather than reading it as unset", async () => {
    // `timeoutMs ?? DEFAULT`, never `timeoutMs || DEFAULT`. Zero is a legal
    // budget — "do not wait" — and the mutant silently restores 1.5 seconds,
    // which would make every timing test in this file pass for the wrong reason.
    //
    // Asserted on **the budget that was applied**, not on a live server failing
    // to answer in time. That version of this test was written first and was
    // flaky by construction: `AbortSignal.timeout(0)` fires in the next *timers*
    // phase, and a loopback request can be dispatched and answered inside the
    // preceding *poll* phase — so a live server sometimes wins the race, and the
    // test would have been measuring libuv rather than this module. Two black
    // holes can never answer, so the only variable left is the number.
    const a = await startServer(blackHole);
    const b = await startServer(blackHole);

    const started = performance.now();
    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: a.baseUrl, LMSTUDIO_BASE_URL: b.baseUrl },
      { timeoutMs: 0 },
    );
    const elapsed = performance.now() - started;

    expect(resolution.source).toBe("fallback");
    expect(resolution.probes.every((p) => !p.up)).toBe(true);
    // The number, in the words the user reads — and `"after 0ms"` rather than
    // `"0ms"`, because `|| PROBE_TIMEOUT_MS` reports "timed out after 1500ms",
    // which contains `"0ms"` and passed the first version of this assertion.
    expect(resolution.probes[0].detail ?? "").toContain("after 0ms");
    expect(resolution.probes[1].detail ?? "").toContain("after 0ms");
    // And it did not quietly wait the default out. Half the default rather than
    // all of it: the mutant lands at 1502ms against a 1500ms bound, which is a
    // margin the machine could close on a slow day.
    expect(elapsed).toBeLessThan(PROBE_TIMEOUT_MS / 2);
  });

  it("carries a port of 0 into the endpoint it reports", async () => {
    // Port 0 is ephemeral — legal, meaningful, and what every fixture in this
    // file listens on. A base URL rebuilt through `port || DEFAULT_PORT` would
    // report `:11434` for a probe that was never sent there.
    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: "http://127.0.0.1:0", LMSTUDIO_BASE_URL: await closedPortBaseUrl() },
      { timeoutMs: 500 },
    );

    expect(resolution.probes[0].endpoint).toBe("http://127.0.0.1:0/api/tags");
    expect(resolution.probes[0].up).toBe(false);
    expect(resolution.error ?? "").toContain("http://127.0.0.1:0/api/tags");
  });

  it("detects at a base URL whose port came from an ephemeral bind", async () => {
    const lmStudio = await startServer(answers);
    // Nothing about the number is special, and nothing may treat it as absent.
    expect(lmStudio.port).toBeGreaterThan(0);

    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: await closedPortBaseUrl(), LMSTUDIO_BASE_URL: lmStudio.baseUrl },
      { timeoutMs: 500 },
    );
    expect(resolution.baseUrl).toBe(`http://127.0.0.1:${lmStudio.port}`);
  });

  it("treats an empty base URL as absent, not as a valid URL", async () => {
    // `""` is a shell that exported the variable without a value. Passing it
    // through produces `"/api/tags"`, which `fetch` rejects as an invalid URL —
    // so the provider is reported down for a reason that has nothing to do with
    // the user's server, and the message names an endpoint that is not one.
    const resolution = await detectProvider(
      { OLLAMA_BASE_URL: "", LMSTUDIO_BASE_URL: "" },
      { timeoutMs: 500 },
    );

    expect(resolution.probes.map((p) => p.endpoint)).toEqual([
      `${DEFAULT_OLLAMA_BASE_URL}/api/tags`,
      `${DEFAULT_LMSTUDIO_BASE_URL}/v1/models`,
    ]);
  });

  it("treats an empty base URL as absent on the configured path too", async () => {
    const resolution = await detectProvider({
      SPRITE_MAKER_PROVIDER: "lmstudio",
      LMSTUDIO_BASE_URL: "",
    });

    expect(resolution.baseUrl).toBe(DEFAULT_LMSTUDIO_BASE_URL);
    expect(resolution.source).toBe("configured");
  });

  it("treats a whitespace-only base URL as absent as well", async () => {
    const resolution = await detectProvider({
      SPRITE_MAKER_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "   ",
    });
    expect(resolution.baseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
  });
});

// ---------------------------------------------------------------------------
// the control — a provider that can change without a restart
// ---------------------------------------------------------------------------

describe("createProviderControl", () => {
  it("hands out a client for the resolved provider", async () => {
    const ollama = await startServer(answers);
    const control = createProviderControl(
      await detectProvider(
        { OLLAMA_BASE_URL: ollama.baseUrl, LMSTUDIO_BASE_URL: await closedPortBaseUrl() },
        { timeoutMs: 500 },
      ),
    );

    expect(await control.client().listModels()).toEqual(["ollama-model"]);
    expect(ollama.paths).toEqual(["/api/tags", "/api/tags"]);
  });

  it("replaces the client on select, so the next call goes to the new server", async () => {
    // The defect this is written against: `registerIpc({ client, … })` captured
    // the client by value, so nothing could re-resolve the provider at runtime
    // and a switch would take effect at the next restart — silently.
    const ollama = await startServer(answers);
    const lmStudio = await startServer(answers);
    const control = createProviderControl(
      await detectProvider(
        { OLLAMA_BASE_URL: ollama.baseUrl, LMSTUDIO_BASE_URL: await closedPortBaseUrl() },
        { timeoutMs: 500 },
      ),
    );

    control.select("lmstudio", lmStudio.baseUrl);

    expect(control.status().provider).toBe("lmstudio");
    expect(control.status().baseUrl).toBe(lmStudio.baseUrl);
    expect(await control.client().listModels()).toEqual(["lmstudio-model"]);
    expect(lmStudio.paths).toEqual(["/v1/models"]);
  });

  it("reports a selected provider as configured, not as detected", async () => {
    // The user chose it. Rendering "detected" over a choice they made by hand
    // would be the same lie in the other direction.
    const control = createProviderControl(
      await detectProvider(
        { OLLAMA_BASE_URL: await closedPortBaseUrl(), LMSTUDIO_BASE_URL: await closedPortBaseUrl() },
        { timeoutMs: 500 },
      ),
    );
    expect(control.status().source).toBe("fallback");

    control.select("lmstudio", DEFAULT_LMSTUDIO_BASE_URL);

    expect(control.status().source).toBe("configured");
    // And the detection failure is no longer the current story.
    expect(control.status().error).toBeNull();
    expect(control.status().probes).toEqual([]);
  });

  it("falls back to the provider's default for an empty base URL", async () => {
    const control = createProviderControl(
      await detectProvider({ SPRITE_MAKER_PROVIDER: "ollama" }),
    );
    control.select("lmstudio", "");
    expect(control.status().baseUrl).toBe(DEFAULT_LMSTUDIO_BASE_URL);
  });
});
