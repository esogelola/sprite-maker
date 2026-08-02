/**
 * `main/provider.ts` — spec amendment A15.
 *
 * The provider is chosen once, at startup, from the environment. Two properties
 * matter and neither can be checked by reading the switch:
 *
 * **Which client actually came back.** `createLlmClient` returns an `LlmClient`
 * and nothing about that value says which implementation it is — deliberately,
 * because that is the whole point of the interface. So these tests do not
 * inspect the object; they point the provider's own base-URL variable at a local
 * server and read **which path it requests**. `/api/tags` is Ollama and
 * `/v1/models` is LM Studio, and no amount of correct-looking wiring can fake
 * the wrong one.
 *
 * **That an unknown name stops the app.** The failure mode this guards is not a
 * crash — it is a run that silently used Ollama when the user asked for
 * something else, produced numbers, and attributed them to the wrong provider.
 * `SPRITE_MAKER_PROVIDER=lmstduio` has to be fatal at startup.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLlmClient,
  DEFAULT_PROVIDER,
  PROVIDERS,
  UnknownProviderError,
} from "@main/provider";

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

interface Fixture {
  baseUrl: string;
  /** Every path requested, in order. `/api/tags` is Ollama; `/v1/models` is not. */
  paths: string[];
}

/** Answers any listing request in both dialects, so only the *path* identifies. */
async function startServer(): Promise<Fixture> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    // Both envelopes at once: `models` is Ollama's, `data` is OpenAI's. A client
    // reading the wrong one would still succeed here, which keeps this fixture
    // measuring the routing rather than the parsing.
    res.end(
      JSON.stringify({ models: [{ name: "ollama-model" }], data: [{ id: "lmstudio-model" }] }),
    );
  });
  openServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, paths };
}

describe("createLlmClient — provider selection", () => {
  it("defaults to Ollama when SPRITE_MAKER_PROVIDER is unset", async () => {
    const fixture = await startServer();
    const client = createLlmClient({ OLLAMA_BASE_URL: fixture.baseUrl });

    expect(await client.listModels()).toEqual(["ollama-model"]);
    expect(fixture.paths).toEqual(["/api/tags"]);
    expect(DEFAULT_PROVIDER).toBe("ollama");
  });

  it("treats an empty SPRITE_MAKER_PROVIDER as unset rather than as a typo", async () => {
    // `export SPRITE_MAKER_PROVIDER=` is a shell that has not chosen, not a user
    // who misspelled something — making an empty variable fatal would break
    // environments that set it unconditionally.
    const fixture = await startServer();
    const client = createLlmClient({ SPRITE_MAKER_PROVIDER: "", OLLAMA_BASE_URL: fixture.baseUrl });

    await client.listModels();
    expect(fixture.paths).toEqual(["/api/tags"]);
  });

  it("selects Ollama explicitly", async () => {
    const fixture = await startServer();
    const client = createLlmClient({
      SPRITE_MAKER_PROVIDER: "ollama",
      OLLAMA_BASE_URL: fixture.baseUrl,
    });

    await client.listModels();
    expect(fixture.paths).toEqual(["/api/tags"]);
  });

  it("selects LM Studio, which asks a different endpoint", async () => {
    const fixture = await startServer();
    const client = createLlmClient({
      SPRITE_MAKER_PROVIDER: "lmstudio",
      LMSTUDIO_BASE_URL: fixture.baseUrl,
    });

    expect(await client.listModels()).toEqual(["lmstudio-model"]);
    expect(fixture.paths).toEqual(["/v1/models"]);
  });

  it("reads each provider's base URL from its own variable", async () => {
    // Not one shared `BASE_URL`. Pointing Ollama's variable at LM Studio's port
    // is a mistake neither server can detect — separate variables are what keep
    // it from being the default experience when someone switches provider.
    const lmStudio = await startServer();
    const ollama = await startServer();

    const client = createLlmClient({
      SPRITE_MAKER_PROVIDER: "lmstudio",
      LMSTUDIO_BASE_URL: lmStudio.baseUrl,
      OLLAMA_BASE_URL: ollama.baseUrl,
    });
    await client.listModels();

    expect(lmStudio.paths).toEqual(["/v1/models"]);
    expect(ollama.paths).toEqual([]);
  });

  it("ignores LMSTUDIO_BASE_URL when the provider is Ollama", async () => {
    const ollama = await startServer();
    const lmStudio = await startServer();

    const client = createLlmClient({
      SPRITE_MAKER_PROVIDER: "ollama",
      OLLAMA_BASE_URL: ollama.baseUrl,
      LMSTUDIO_BASE_URL: lmStudio.baseUrl,
    });
    await client.listModels();

    expect(ollama.paths).toEqual(["/api/tags"]);
    expect(lmStudio.paths).toEqual([]);
  });

  it("lists both providers, in the order the error message reports them", () => {
    expect([...PROVIDERS]).toEqual(["ollama", "lmstudio"]);
  });
});

describe("createLlmClient — an unrecognised provider", () => {
  it("throws rather than falling through to the default", () => {
    // The failure this exists to prevent is silent: a run configured for LM
    // Studio that quietly used Ollama would produce real numbers attributed to
    // the wrong provider, which is worse than not starting.
    expect(() => createLlmClient({ SPRITE_MAKER_PROVIDER: "lmstduio" })).toThrow(
      UnknownProviderError,
    );
  });

  it("names the value it was given and the values it accepts", () => {
    const error = (() => {
      try {
        createLlmClient({ SPRITE_MAKER_PROVIDER: "openai" });
        return null;
      } catch (e: unknown) {
        return e as UnknownProviderError;
      }
    })();

    expect(error).not.toBeNull();
    expect(error?.name).toBe("UnknownProviderError");
    expect(error?.requested).toBe("openai");
    // All three facts a typo needs: what was asked for, what exists, and which
    // variable to edit.
    expect(error?.message).toContain("openai");
    expect(error?.message).toContain("ollama");
    expect(error?.message).toContain("lmstudio");
    expect(error?.message).toContain("SPRITE_MAKER_PROVIDER");
  });

  it("rejects a near miss in case or whitespace instead of guessing", () => {
    // Normalising these would be a kindness that hides a config the user can see
    // and fix. An app that starts on `Ollama` teaches that the variable is
    // fuzzy, and the next value it silently accepts will be one that matters.
    for (const requested of ["Ollama", "LMStudio", " ollama", "lm-studio", "lm studio"]) {
      expect(() => createLlmClient({ SPRITE_MAKER_PROVIDER: requested })).toThrow(
        UnknownProviderError,
      );
    }
  });

  it("throws before any network call is attempted", async () => {
    const fixture = await startServer();
    expect(() =>
      createLlmClient({ SPRITE_MAKER_PROVIDER: "nope", OLLAMA_BASE_URL: fixture.baseUrl }),
    ).toThrow(UnknownProviderError);
    expect(fixture.paths).toEqual([]);
  });
});
