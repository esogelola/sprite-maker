/**
 * The loop, driven end to end — plan Wave 12, acceptance criteria 1–8.
 *
 * Wave 11 proved the user could *see* which round was best. This spec proves
 * they can **keep it**, against a real generation, and it is the only test in the
 * project that exercises the sentence §9 uses as its entire mitigation for a
 * revise stage measured to be net-negative: *any round may be accepted, not only
 * the last.*
 *
 * Seven things are asserted live:
 *
 * **1. The first-run state is empty and says so.** No canvas, no dock, no gate,
 * and a filmstrip that explains itself. A design whose depth comes from content
 * collapses when it has none, and gating only the happy state is a known failure
 * mode — so this is captured as evidence before anything is generated.
 *
 * **2. The model pickers are wired both ways.** They list what Ollama has
 * installed, they show what the config is bound to, and choosing one changes
 * `getModels()`. A picker that renders and affords nothing is the defect the
 * plan's interaction contract names first. The binding is put back before the
 * run, because the run must call the model that was warmed — **only the 8B model
 * is ever loaded here**; the 19 GB alternative would evict it.
 *
 * **3. A round becomes a filmstrip frame as it lands**, mid-run, which is the
 * `round` event's whole purpose (§7.1) and where the populated screenshot is
 * taken.
 *
 * **3b. Feedback at the gate appends a round and is recorded on it** (§7.3).
 * This is not decoration: amendment A14's guard ends most live generations after
 * a single round (measured 8 of 9 here), so the gate's own feedback path is how a
 * session grows — and it was the one Wave 12 surface with no live coverage at
 * all. `Round.userFeedback` is checked on the artifact, not on the reply.
 *
 * **4. The dock shows the deterministic lint**, which Wave 3 built and no
 * surface had rendered until Wave 12.
 *
 * **5. Clicking an issue highlights exactly its region** — every cell inside it
 * and no cell outside, checked against `Issue.region` read back from the session.
 *
 * **6. Accepting a scrubbed-back round records THAT round.** The user scrubs
 * back to round 1 of a multi-round session and accepts it, and `acceptedRound`
 * is read back as `1` from the **file on disk**, not from the reply — an accept
 * that never reached the artifact is invisible after a reload, and §11's bars
 * read the artifact. See `WANTED_ROUNDS` for why "multi-round" is not spelled
 * "three".
 *
 * **7. The status bar reads `DONE`** afterwards, from the history rather than
 * from an event.
 *
 * Like every spec here it attaches to a **built** app (`npm run build` first —
 * there is no dev server) and warms the generator before launching, because a
 * cold 6 GB load eats a 16×16 canvas's whole per-call budget (§6.8, A12).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

/**
 * Which server this spec talks to, and the model loaded into it — A16.
 *
 * `e2e/provider.ts` resolves the provider by calling the app's own
 * `detectProvider`, so the warm-up lands wherever the app is about to look
 * rather than at a hardcoded `127.0.0.1:11434`. It also asserts the resolved
 * server actually has `MODEL`, which is what keeps the warm-up from being a
 * silent no-op on a machine running LM Studio — where the same weights are
 * published under a different id.
 */

import { warmModel } from "./provider";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const shot = (name: string): string =>
  fileURLToPath(
    new URL(`../docs/superpowers/specs/screenshots/2026-07-30-wave-12-${name}.png`, import.meta.url),
  );

const CAPTURE = fileURLToPath(
  new URL("../docs/superpowers/specs/captures/2026-07-30-wave-12-loop.txt", import.meta.url),
);

/** The prompt the user ran, and the one Wave 11's capture was taken with. */
const PROMPT = "a dog standing";

/** `App.tsx`'s default, and the canvas a live run completes reliably (A12). */
const SIDE = 16;

/** §6.8's default for **both** roles (amendment A10). The only model loaded. */
const MODEL = "qwen3-vl:8b-instruct-q4_K_M";

/**
 * Rounds the assertion needs, and why the number is two rather than three.
 *
 * **Amendment A14 makes a one-round session the common case.** The revise guard
 * discards a pass that made the sprite measurably worse and stops the run with
 * `revise-regressed`; §7.2 records it firing in 2 of 3 seeded runs, and this spec
 * measured it firing on **8 of 9** live generations of "a dog standing" at 16×16.
 * A one-round session is therefore a *designed* outcome of a healthy pipeline,
 * and a spec that demands three rounds fails the wave for the harness behaving
 * exactly as specified.
 *
 * Two is the floor at which the assertion still discriminates: with two rounds
 * index 0 is not `rounds.length - 1`, so "accepts the round the filmstrip
 * selected" is still distinguishable from "accepts the last round", which is the
 * whole defect this test exists to catch. Holding out for three was tried and is
 * worse than useless — it *discarded* a qualifying two-round session.
 */
const WANTED_ROUNDS = 2;

/** Cold generations allowed before a short session is reported rather than retried. */
const ATTEMPTS = 5;

/**
 * Feedback passes used to grow a short session, per launch — §7.3.
 *
 * The gate's own feedback path appends a round through the same `revise()` the
 * loop uses, so it is both the cheapest way to reach a second round (one revise
 * pass, not a whole cold generation) and the only live exercise this project has
 * of §7.3. The same A14 guard applies to it, which is why there is more than one
 * try and why a failure to grow is retried rather than treated as broken.
 */
const FEEDBACK_TRIES = 3;
const FEEDBACK = ["give it four legs", "make the head rounder", "add a tail"];

/** The round the user keeps: the first one, index 0, `Round.round === 1`. */
const ACCEPT_INDEX = 0;
const ACCEPT_ROUND = 1;

interface IssueJson {
  id: string;
  region: [number, number, number, number];
  severity: string;
  issue: string;
  confidence: number;
  suggestConfidence: number;
}

interface RoundJson {
  round: number;
  doc: { rows: string[]; palette: { id: string } };
  lint: {
    warnings: Array<{ code: string }>;
    metrics: { coverage: number; paletteUsed: number; orphanCount: number; symmetryScore: number };
  };
  critique: { overall: number | null; readsAs: string | null; issues: IssueJson[] } | null;
  filteredIssues: IssueJson[];
  userFeedback: string | null;
  diffFromPrev: unknown[] | null;
  revise: { turns: number; hitCap: boolean; summary: string } | null;
}

interface SessionJson {
  sessionId: string;
  rounds: RoundJson[];
  stopReason: string | null;
  finalState: string;
  outcome: string;
  error: string | null;
  acceptedRound: number | null;
}

/** The half of `window.api` this spec drives from inside the page. */
interface BridgedApi {
  getSession(): Promise<{ ok: boolean; value?: SessionJson | null }>;
  getModels(): Promise<{ generator: string; critic: string }>;
  listModels(): Promise<{ ok: boolean; value?: string[] }>;
  getSessionPath(): Promise<string>;
}

/**
 * Wait until the pipeline is back at the gate, capturing the mid-loop view once.
 *
 * "Back at the gate" is a settled `data-state` **and** a re-enabled Generate:
 * `pending` is set in the renderer the moment a mutation is dispatched, so the
 * pair is race-free at both ends — a click that has not yet produced a `state`
 * event still reads as busy, and a resolved mutation reads as settled only after
 * the renderer has adopted the history.
 *
 * The populated screenshot is taken from inside this loop rather than after it,
 * because "populated mid-loop" is a state that exists only while the pipeline is
 * working: two frames on the strip, a dock full of issues, and a live status
 * line. It is captured once per attempt, whichever stage produces it.
 */
async function waitForGate(page: Page, timeoutMessage: string, mid: { captured: boolean }): Promise<void> {
  const deadline = Date.now() + 14 * 60 * 1000;
  for (;;) {
    const state = await page.getByTestId("state").getAttribute("data-state");
    const settled = state === "AWAITING_USER" || state === "DONE" || state === "FAILED";
    const idle = settled && (await page.getByTestId("generate").isEnabled());

    if (!idle && !mid.captured && (await page.getByTestId("frame").count()) >= 2) {
      await page.screenshot({ path: shot("full") });
      mid.captured = true;
    }
    if (idle) return;
    if (Date.now() > deadline) throw new Error(timeoutMessage);
    await page.waitForTimeout(2000);
  }
}

async function session(page: Page): Promise<SessionJson | null> {
  const result = await page.evaluate(() =>
    (window as unknown as { api: BridgedApi }).api.getSession(),
  );
  expect(result.ok, "getSession answered a failure envelope").toBe(true);
  return result.value ?? null;
}

/** The canvas, read back out of the DOM in §6.1's encoding. */
async function canvasRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const grid = document.querySelector('[data-testid="canvas"]');
    if (grid === null) return [];
    const rows: string[] = [];
    for (const cell of Array.from(grid.querySelectorAll("[data-x]"))) {
      const y = Number(cell.getAttribute("data-y"));
      rows[y] = (rows[y] ?? "") + (cell.getAttribute("data-ch") ?? "?");
    }
    return rows;
  });
}

/** Every highlighted cell, as `[x, y]` pairs. */
async function highlighted(page: Page): Promise<Array<[number, number]>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="canvas"] [data-highlight="true"]')).map(
      (cell) =>
        [Number(cell.getAttribute("data-x")), Number(cell.getAttribute("data-y"))] as [
          number,
          number,
        ],
    ),
  );
}

const painted = (rows: string[]): number => rows.join("").replace(/\./g, "").length;

test("drives a real loop from an empty window to an accepted round", async () => {
  // Three cold generations of up to three rounds each, against a local 8B model:
  // §12 measures one run in minutes, and the config permits 40 model calls per
  // revise pass.
  test.setTimeout(50 * 60 * 1000);

  let best = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const rounds = await runOnce(attempt);
    best = Math.max(best, rounds);
    if (rounds >= WANTED_ROUNDS) return;
  }

  throw new Error(
    `no session reached ${WANTED_ROUNDS} rounds in ${ATTEMPTS} attempts of one generation ` +
      `plus ${FEEDBACK_TRIES} feedback passes each (best: ${best}). ` +
      "§7.2 stops a run on a converged critique, an empty diff, or A14's regression " +
      "guard, so a one-round session is a healthy pipeline rather than a broken one " +
      "— but accepting a round the user scrubbed back to needs a session with " +
      "something to scrub back from.",
  );
});

/** One cold boot: empty state, generate, inspect, scrub back, accept, capture. */
async function runOnce(attempt: number): Promise<number> {
  const resolved = await warmModel(MODEL);
  await mkdir(dirname(shot("empty")), { recursive: true });

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: ["."], cwd: REPO_ROOT });
    app.process().stdout?.on("data", (d: Buffer) => process.stdout.write(`[main] ${d}`));
    app.process().stderr?.on("data", (d: Buffer) => process.stderr.write(`[main] ${d}`));

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // -- 1: the first-run state ---------------------------------------------
    expect(await session(page), "a fresh main process holds no session").toBeNull();
    await expect(page.getByTestId("empty")).toBeVisible();
    await expect(page.getByTestId("filmstrip-empty")).toBeVisible();
    await expect(page.getByTestId("canvas")).toHaveCount(0);
    await expect(page.getByTestId("dock")).toHaveCount(0);
    await expect(page.getByTestId("gate")).toHaveCount(0);
    await expect(page.getByTestId("state")).toHaveAttribute("data-state", "IDLE");
    await page.screenshot({ path: shot("empty") });

    // -- 2: the model pickers, both ways ------------------------------------
    const bound = await page.evaluate(() =>
      (window as unknown as { api: BridgedApi }).api.getModels(),
    );
    expect(bound.generator).toBe(MODEL);
    expect(bound.critic).toBe(MODEL);
    await expect(page.getByTestId("model-generator")).toHaveValue(MODEL);
    await expect(page.getByTestId("model-critic")).toHaveValue(MODEL);

    const listed = await page.evaluate(() =>
      (window as unknown as { api: BridgedApi }).api.listModels(),
    );
    expect(listed.ok, "listModels answered a failure envelope").toBe(true);
    const alternative = (listed.value ?? []).find((m) => m !== MODEL);
    if (alternative === undefined) {
      // A one-model machine cannot exercise a picker; say so rather than pass.
      console.warn("only one model installed — the picker's write path was not exercised");
    } else {
      await page.getByTestId("model-critic").selectOption(alternative);
      await expect
        .poll(async () =>
          page.evaluate(
            async () => (await (window as unknown as { api: BridgedApi }).api.getModels()).critic,
          ),
        )
        .toBe(alternative);
      // Back to the warmed model: the run must call what was loaded, and the
      // 19 GB alternative would evict it on a memory-constrained machine.
      await page.getByTestId("model-critic").selectOption(MODEL);
      await expect
        .poll(async () =>
          page.evaluate(
            async () => (await (window as unknown as { api: BridgedApi }).api.getModels()).critic,
          ),
        )
        .toBe(MODEL);
    }

    // -- 3: the generation, and a frame per round as it lands ---------------
    await page.getByTestId("prompt").fill(PROMPT);
    await page.getByTestId("generate").click();

    const mid = { captured: false };
    await waitForGate(page, `attempt ${attempt}: the run never resolved`, mid);

    let history = await session(page);
    expect(history, "the run produced no session at all").not.toBeNull();

    // -- growing a short session at the gate — §7.3 -------------------------
    // A14's guard ends most runs after one round (see `WANTED_ROUNDS`), and the
    // gate's own feedback path is both the cheap way to a second round and the
    // only live exercise of §7.3 this project has.
    const feedbackSent: string[] = [];
    for (let i = 0; i < FEEDBACK_TRIES && history!.rounds.length < WANTED_ROUNDS; i++) {
      const words = FEEDBACK[i % FEEDBACK.length];
      await expect(page.getByTestId("gate")).toBeVisible();
      await page.getByTestId("feedback").fill(words);
      await page.getByTestId("send-feedback").click();
      feedbackSent.push(words);
      await waitForGate(page, `attempt ${attempt}: the feedback pass never resolved`, mid);
      history = await session(page);
    }

    const rounds = history!.rounds;
    await expect(page.getByTestId("frame")).toHaveCount(rounds.length);
    if (rounds.length < WANTED_ROUNDS) return rounds.length;

    // §7.3 records the user's own words on the round they drove.
    if (feedbackSent.length > 0) {
      const recorded = rounds.map((r) => r.userFeedback);
      expect(
        recorded.some((f) => f !== null && feedbackSent.includes(f)),
        `no round recorded the feedback that grew this session: ${JSON.stringify(recorded)}`,
      ).toBe(true);
    }

    // -- the gate ------------------------------------------------------------
    await expect(page.getByTestId("gate")).toBeVisible();
    await expect(page.getByTestId("state")).toHaveAttribute("data-state", history!.finalState);
    expect(history!.finalState).toBe("AWAITING_USER");
    // Read from the history, not from an event (§8).
    await expect(page.getByTestId("stop-reason")).toHaveAttribute(
      "data-reason",
      String(history!.stopReason),
    );
    await page.screenshot({ path: shot("gate") });

    // -- 4: the dock renders the deterministic lint --------------------------
    await expect(page.getByTestId("dock")).toBeVisible();
    await expect(page.getByTestId("lint")).toBeVisible();
    await expect(page.getByTestId("lint-orphans")).toHaveAttribute(
      "data-count",
      String(rounds[rounds.length - 1].lint.metrics.orphanCount),
    );

    // -- 5: clicking an issue highlights exactly its region ------------------
    const withIssues = rounds.findIndex(
      (r) => r.critique !== null && r.critique.issues.length > 0,
    );
    expect(withIssues, "no round carried a critique with issues to click").toBeGreaterThanOrEqual(0);

    const frames = page.getByTestId("frame");
    await frames.nth(withIssues).click();
    await expect(frames.nth(withIssues)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("issue")).toHaveCount(
      rounds[withIssues].critique!.issues.length,
    );
    expect(await highlighted(page)).toHaveLength(0);

    const issue = rounds[withIssues].critique!.issues[0];
    await page.getByTestId("issue").first().click();
    const [x0, y0, x1, y1] = issue.region;
    const expected = (x1 - x0 + 1) * (y1 - y0 + 1);
    await expect
      .poll(async () => (await highlighted(page)).length, {
        message: `clicking issue ${issue.id} highlighted nothing`,
        timeout: 10 * 1000,
      })
      .toBe(expected);
    for (const [x, y] of await highlighted(page)) {
      expect(x >= x0 && x <= x1 && y >= y0 && y <= y1, `(${x}, ${y}) is outside the region`).toBe(
        true,
      );
    }

    // -- scrubbing still changes the canvas ---------------------------------
    await frames.nth(ACCEPT_INDEX).click();
    await expect
      .poll(async () => (await canvasRows(page)).join("\n"), { timeout: 10 * 1000 })
      .toBe(rounds[ACCEPT_INDEX].doc.rows.join("\n"));
    // The highlight belongs to the round it was clicked in.
    expect(await highlighted(page)).toHaveLength(0);

    // -- 6: accept the round the filmstrip has selected ----------------------
    await expect(page.getByTestId("accept")).toContainText(`round ${ACCEPT_ROUND}`);
    await page.getByTestId("accept").click();

    await expect
      .poll(async () => (await session(page))?.acceptedRound ?? null, {
        message: "the accept never reached the session main holds",
        timeout: 20 * 1000,
      })
      .toBe(ACCEPT_ROUND);

    // The artifact on disk, not the reply: §11's bars read `acceptedRound` off
    // the file, and an accept that never persisted is invisible after a reload.
    const sessionPath = await page.evaluate(() =>
      (window as unknown as { api: BridgedApi }).api.getSessionPath(),
    );
    const persisted = JSON.parse(await readFile(sessionPath, "utf8")) as SessionJson;
    expect(persisted.acceptedRound, `${sessionPath} does not record the accepted round`).toBe(
      ACCEPT_ROUND,
    );
    expect(persisted.rounds[ACCEPT_INDEX].round).toBe(ACCEPT_ROUND);
    expect(persisted.finalState).toBe("DONE");

    // -- 7: and the status bar says so --------------------------------------
    await expect(page.getByTestId("state")).toHaveAttribute("data-state", "DONE");
    await expect(page.getByTestId("status-accepted")).toContainText(`accepted round ${ACCEPT_ROUND}`);
    // The frame marked accepted is the one accepted — 1-based `Round.round`
    // against the frame, never against the array index.
    await expect(frames.nth(ACCEPT_INDEX)).toHaveAttribute("data-accepted", "true");
    await expect(frames.nth(rounds.length - 1)).toHaveAttribute("data-accepted", "false");
    await page.screenshot({ path: shot("accepted") });

    // -- the numbers beside the pictures ------------------------------------
    await mkdir(dirname(CAPTURE), { recursive: true });
    await writeFile(
      CAPTURE,
      [
        "Wave 12 — e2e/loop.spec.ts, live run against a local model server",
        `captured:    ${new Date().toISOString()}`,
        `provider:    ${resolved.provider} at ${resolved.baseUrl} (${resolved.source})`,
        `attempt:     ${attempt} of ${ATTEMPTS} — ${rounds.length} rounds`,
        `feedback:    ${
          feedbackSent.length === 0
            ? "none — the generation reached the round count on its own"
            : `${feedbackSent.length} pass(es) at the gate: ${feedbackSent.map((f) => `"${f}"`).join(", ")}`
        }`,
        `prompt:      "${PROMPT}"  ${SIDE}x${SIDE}  palette ${rounds[0].doc.palette.id}`,
        `models:      generator ${bound.generator} / critic ${bound.critic}`,
        `installed:   ${(listed.value ?? []).join(", ")}`,
        `session:     ${persisted.sessionId}`,
        `session at:  ${sessionPath}`,
        `outcome:     ${persisted.outcome} · ${persisted.finalState} · stopReason ${String(
          persisted.stopReason,
        )}`,
        `error:       ${String(persisted.error)}`,
        "",
        `ACCEPTED:    round ${String(persisted.acceptedRound)} — chosen at filmstrip index ` +
          `${ACCEPT_INDEX}, read back from the file on disk`,
        `highlight:   issue ${issue.id} on round ${rounds[withIssues].round}, region ` +
          `[${issue.region.join(", ")}] → ${expected} cells lit`,
        "",
        "Per round — what the dock renders, and what it is rendered against.",
        "",
        ...rounds.flatMap((r) => {
          const m = r.lint.metrics;
          const q = r.critique;
          return [
            `round ${r.round}`,
            `  painted        ${painted(r.doc.rows)} of ${SIDE * SIDE}`,
            `  coverage       ${m.coverage.toFixed(3)}`,
            `  symmetry       ${m.symmetryScore.toFixed(3)}`,
            `  palette used   ${m.paletteUsed}`,
            `  orphans        ${m.orphanCount}`,
            `  lint warnings  ${
              r.lint.warnings.length === 0
                ? "none"
                : r.lint.warnings.map((w) => w.code).join(", ")
            }`,
            `  critique       ${q === null ? "none" : `${String(q.overall)}/5 — ${String(q.readsAs)}`}`,
            `  issues         ${q === null ? 0 : q.issues.length} raw / ${r.filteredIssues.length} sent to the reviser`,
            ...(q === null
              ? []
              : q.issues.map(
                  (i) =>
                    `    ${i.id} ${i.severity} conf ${i.confidence.toFixed(2)} / suggest ` +
                    `${i.suggestConfidence.toFixed(2)} — ${i.issue}`,
                )),
            `  diffFromPrev   ${
              r.diffFromPrev === null ? "null (no parent)" : `${r.diffFromPrev.length} cells`
            }`,
            `  revise         ${
              r.revise === null
                ? "did not run"
                : `${r.revise.turns} turns, hitCap ${String(r.revise.hitCap)} — "${r.revise.summary}"`
            }`,
            "",
            ...r.doc.rows,
            "",
          ];
        }),
      ].join("\n"),
      "utf8",
    );

    return rounds.length;
  } finally {
    await app?.close();
  }
}
