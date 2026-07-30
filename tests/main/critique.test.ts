/**
 * `main/critique.ts` — spec §4.4, §4.5, §6.4, §9 and plan Wave 7.
 *
 * Four things this file is really about, each a defect the stage would
 * otherwise ship with:
 *
 * **1. The two-tier filter is trivially invertible.** `confidence 0.9 /
 * suggestConfidence 0.4` must KEEP the issue and empty its `suggest`. Dropping
 * it destroys exactly the signal §6.4 says is the valuable one — *something is
 * definitely wrong here, but my fix is a guess* — and no type, schema or
 * compiler can tell the two behaviours apart.
 *
 * **2. Repair runs on the raw JSON, before validation.** `Coord` is
 * non-negative, so `[-5,-5,3,3]` — §6.4 names it the most common VLM error —
 * fails the schema. A stage that validates first burns its single reprompt on a
 * report full of usable findings and then degrades it to nothing.
 *
 * **3. A degraded report must be reachable and must never lie.** Two
 * unparseable responses yield `degraded: true` with `overall: null`. Never a
 * throw (a broken critic must not destroy a valid sprite) and never a score (an
 * invented `overall` lands in `SessionHistory` and pollutes every bench metric).
 * The counterpart is that repair must *not* be able to manufacture a valid
 * empty report out of `{}` — that would be a silent pass instead of a reprompt.
 *
 * **4. The image is composited.** §4.5's probe recorded `qwen3-vl` reporting
 * *"No visible differences"* between transparent and opaque black. The
 * assertions below decode the PNG the stub recorded and read its pixels, rather
 * than checking that some background argument was passed somewhere.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  CritiqueParseError,
  buildCritiquePrompt,
  criticTimeoutMs,
  critique,
  filterIssues,
  parseCritique,
  repairCritique,
} from "@main/critique";
import { lint } from "@main/lint";
import { OllamaTimeoutError, OllamaUnreachableError } from "@main/ollama";
import type { OllamaClient, VisionRequest } from "@main/ollama";
import { pickCriticBackground } from "@main/render";
import {
  CritiqueReportSchema,
  DEFAULT_HARNESS_CONFIG,
  HarnessConfigSchema,
} from "@shared/schema";
import type { CritiqueReport, HarnessConfig, Issue, Size, SpriteDoc } from "@shared/schema";

import { BLACK_OUTLINE, BLANK, SOLID_BLOCK, SPRITE_32, SPRITE_64 } from "../fixtures/sprites";
import { createStubClient } from "../stubs/ollama";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const SIZE_16: Size = { w: 16, h: 16 };
const SIZE_32: Size = { w: 32, h: 32 };

const CFG = DEFAULT_HARNESS_CONFIG;

/**
 * §6.1's row encoding, spelled out here rather than derived.
 *
 * `index.toString(16)` would agree with a bug that used it on both sides; a
 * literal is the test restating the spec instead of restating the code.
 */
const HEX_DIGITS = "0123456789abcdef";

/** A config override that still goes through the strict schema. */
function cfgWith(patch: Partial<HarnessConfig>): HarnessConfig {
  return HarnessConfigSchema.parse({ ...DEFAULT_HARNESS_CONFIG, ...patch });
}

/** One raw issue as a *model* would emit it — untyped on purpose. */
function rawIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "i1",
    region: [1, 2, 3, 4],
    severity: "high",
    issue: "the outline is broken",
    suggest: "close it at (3,4)",
    confidence: 0.9,
    suggestConfidence: 0.8,
    ...overrides,
  };
}

/** One raw report as a model would emit it. */
function rawReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    readsAs: "a green tree on a dark trunk",
    matchesIntent: true,
    overall: 4,
    issues: [rawIssue()],
    ...overrides,
  };
}

/** Repair, then validate — the exact order `parseCritique` uses. */
function repairAndParse(raw: unknown, size: Size = SIZE_32): CritiqueReport {
  return CritiqueReportSchema.parse(repairCritique(raw, size));
}

/** A validated report, for the `filterIssues` half of the suite. */
function reportOf(issues: Array<Partial<Issue>>): CritiqueReport {
  return CritiqueReportSchema.parse({
    readsAs: "a tree",
    matchesIntent: true,
    overall: 3,
    issues: issues.map((patch, i) => ({
      id: `i${i}`,
      region: [0, 0, 1, 1],
      severity: "medium",
      issue: "something",
      suggest: "do a thing",
      confidence: 1,
      suggestConfidence: 1,
      ...patch,
    })),
  });
}

/** `#rrggbb` → channels, parsed here so no assertion compares a helper with itself. */
function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function pixelAt(png: PNG, x: number, y: number): [number, number, number, number] {
  const at = (y * png.width + x) * 4;
  return [png.data[at], png.data[at + 1], png.data[at + 2], png.data[at + 3]];
}

/** The single image the stub recorded for call `n`, decoded. */
function decodedImage(images: Buffer[] | undefined): PNG {
  expect(images).toBeDefined();
  expect(images).toHaveLength(1);
  return PNG.sync.read(images![0]);
}

/**
 * A hand-rolled client for the two things the stub cannot express: the
 * `AbortSignal` (which `RecordedCall` does not carry, and `tests/stubs/ollama.ts`
 * belongs to Waves 6 and 8 as much as to this one) and a call that hangs until
 * that signal fires.
 */
function hangingClient(): OllamaClient & { requests: VisionRequest[] } {
  const requests: VisionRequest[] = [];
  return {
    requests,
    async listModels() {
      return [];
    },
    async generate() {
      throw new Error("not used");
    },
    async chatWithTools() {
      throw new Error("not used");
    },
    vision(req: VisionRequest): Promise<string> {
      requests.push(req);
      return new Promise((_resolve, reject) => {
        const signal = req.signal;
        if (signal === undefined) return; // hang forever: the test will time out and say so
        if (signal.aborted) reject(new OllamaTimeoutError(req.model, 0));
        signal.addEventListener("abort", () => reject(new OllamaTimeoutError(req.model, 0)));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// buildCritiquePrompt — spec §4.4, §7.4
// ---------------------------------------------------------------------------

describe("buildCritiquePrompt", () => {
  it("carries every row of the grid verbatim — §4.4's text channel", () => {
    const { user } = buildCritiquePrompt(SPRITE_32, lint(SPRITE_32));
    for (const row of SPRITE_32.rows) expect(user).toContain(row);
  });

  it("pins each row to its own y — the grid is a coordinate system, not a bag of lines", () => {
    // `toContain(row)` above is blind to order and to the row/label pairing, and
    // both are load-bearing: §4.4 gives the text channel the coordinates, so a
    // grid emitted bottom-up (or with the index dropped) hands the critic a
    // y-mirrored canvas and every region it reports comes back mirrored too.
    // Line equality is the assertion that says which row is which.
    const { user } = buildCritiquePrompt(SPRITE_32, lint(SPRITE_32));
    const lines = user.split("\n");
    SPRITE_32.rows.forEach((row, y) => {
      expect(lines).toContain(`${String(y).padStart(2, "0")} ${row}`);
    });
  });

  it("carries every palette index with its hex", () => {
    const { user } = buildCritiquePrompt(BLACK_OUTLINE, lint(BLACK_OUTLINE));
    BLACK_OUTLINE.palette.colors.forEach((hex, index) => {
      expect(user).toContain(hex);
      expect(user).toMatch(new RegExp(`${index.toString(16)}\\b[^\\n]*${hex}`, "i"));
    });
  });

  it("labels each palette entry with the §6.1 hex character, not its decimal index", () => {
    // BLACK_OUTLINE has four colours, where the decimal index and the hex
    // character are the same glyph and the distinction cannot be observed.
    // SPRITE_32 is on `pico-8`: index 11 is written `b` in every row of the
    // grid, so a table printing `11` beside it tells the model one thing and
    // shows it another — and every coordinate keyed to a colour is then read off
    // a legend the grid does not use.
    const { user } = buildCritiquePrompt(SPRITE_32, lint(SPRITE_32));
    expect(SPRITE_32.palette.colors.length).toBe(16);
    SPRITE_32.palette.colors.forEach((hex, index) => {
      expect(user).toContain(hex);
      expect(user).toMatch(new RegExp(`\\s${HEX_DIGITS[index]}\\s+${hex}`, "i"));
    });
  });

  it("names the canvas size and the intent", () => {
    const { user } = buildCritiquePrompt(SPRITE_32, lint(SPRITE_32));
    expect(user).toContain("32×32");
    expect(user).toContain(SPRITE_32.intent.subject);
  });

  it("carries the linter's findings so the critic does not re-derive them", () => {
    const report = lint(SPRITE_32);
    const { user } = buildCritiquePrompt(SPRITE_32, report);
    expect(report.warnings.length).toBeGreaterThan(0);
    for (const w of report.warnings) expect(user).toContain(w.code);
    expect(user).toContain("symmetry");
  });

  it("says so explicitly when the linter found nothing", () => {
    const report = lint(SOLID_BLOCK);
    expect(report.warnings).toHaveLength(0);
    const { user } = buildCritiquePrompt(SOLID_BLOCK, report);
    expect(user.toLowerCase()).toContain("no deterministic warnings");
  });

  it("states the JSON contract, both confidences and the region convention", () => {
    const { system } = buildCritiquePrompt(SPRITE_32, lint(SPRITE_32));
    for (const field of [
      "readsAs",
      "matchesIntent",
      "overall",
      "issues",
      "region",
      "severity",
      "suggest",
      "confidence",
      "suggestConfidence",
    ]) {
      expect(system).toContain(field);
    }
    expect(system).toContain("[x0, y0, x1, y1]");
    // The separation is the whole point of the two fields (§6.4). A prompt that
    // does not say so gets one number written into both.
    expect(system.toLowerCase()).toContain("is the problem real");
    expect(system.toLowerCase()).toContain("is this fix correct");
  });

  it("keeps the system prompt free of per-document facts", () => {
    // §4.4 assigns the grid, palette and intent to the user turn. A system
    // prompt that varies per document cannot be cached and, more importantly,
    // hides half the contract from the assertions above.
    const a = buildCritiquePrompt(SPRITE_32, lint(SPRITE_32));
    const b = buildCritiquePrompt(SPRITE_64, lint(SPRITE_64));
    expect(a.system).toBe(b.system);
    expect(a.user).not.toBe(b.user);
  });

  it("tells the critic the transparency was composited — §4.5", () => {
    const { user } = buildCritiquePrompt(SPRITE_32, lint(SPRITE_32));
    expect(user).toContain(pickCriticBackground(SPRITE_32));
  });
});

// ---------------------------------------------------------------------------
// repairCritique — spec §6.4's table, on the raw JSON
// ---------------------------------------------------------------------------

describe("repairCritique", () => {
  it("synthesizes a missing id from the issue's index", () => {
    const report = repairAndParse(
      rawReport({ issues: [rawIssue({ id: undefined }), rawIssue({ id: undefined })] }),
    );
    expect(report.issues).toHaveLength(2);
    expect(report.issues[0].id).not.toBe(report.issues[1].id);
    for (const issue of report.issues) expect(issue.id.length).toBeGreaterThan(0);
  });

  it("repairs an empty-string id, which the schema also refuses", () => {
    const report = repairAndParse(rawReport({ issues: [rawIssue({ id: "" })] }));
    expect(report.issues[0].id.length).toBeGreaterThan(0);
  });

  it("repairs a missing suggest to \"\" with suggestConfidence 0", () => {
    const report = repairAndParse(
      rawReport({ issues: [rawIssue({ suggest: undefined, suggestConfidence: 0.9 })] }),
    );
    expect(report.issues[0].suggest).toBe("");
    expect(report.issues[0].suggestConfidence).toBe(0);
  });

  it("repairs a missing suggestConfidence to 0 rather than inventing one", () => {
    const report = repairAndParse(
      rawReport({ issues: [rawIssue({ suggestConfidence: undefined })] }),
    );
    expect(report.issues[0].suggestConfidence).toBe(0);
    expect(report.issues[0].suggest).toBe("close it at (3,4)");
  });

  it("repairs a missing matchesIntent to true", () => {
    const report = repairAndParse(rawReport({ matchesIntent: undefined }));
    expect(report.matchesIntent).toBe(true);
  });

  it("repairs a missing overall and readsAs to null, never to a score", () => {
    const report = repairAndParse(rawReport({ overall: undefined, readsAs: undefined }));
    expect(report.overall).toBeNull();
    expect(report.readsAs).toBeNull();
  });

  it("repairs an out-of-range overall to the 1-5 band", () => {
    expect(repairAndParse(rawReport({ overall: 7 })).overall).toBe(5);
    expect(repairAndParse(rawReport({ overall: 0 })).overall).toBe(1);
    expect(repairAndParse(rawReport({ overall: 3.4 })).overall).toBe(3);
    expect(repairAndParse(rawReport({ overall: "4" })).overall).toBe(4);
    expect(repairAndParse(rawReport({ overall: "excellent" })).overall).toBeNull();
  });

  it("clamps a region that runs off the far edge", () => {
    const report = repairAndParse(rawReport({ issues: [rawIssue({ region: [30, 30, 99, 99] })] }));
    expect(report.issues[0].region).toEqual([30, 30, 31, 31]);
  });

  it("clamps a negative region rather than failing validation — the common VLM error", () => {
    const report = repairAndParse(rawReport({ issues: [rawIssue({ region: [-5, -5, 3, 3] })] }));
    expect(report.issues[0].region).toEqual([0, 0, 3, 3]);
  });

  it("normalizes a reversed region", () => {
    const report = repairAndParse(rawReport({ issues: [rawIssue({ region: [9, 8, 2, 1] })] }));
    expect(report.issues[0].region).toEqual([2, 1, 9, 8]);
  });

  it("clamps against the actual canvas, not a hard-coded 32", () => {
    const report = repairAndParse(
      rawReport({ issues: [rawIssue({ region: [0, 0, 40, 40] })] }),
      SIZE_16,
    );
    expect(report.issues[0].region).toEqual([0, 0, 15, 15]);
  });

  it("rounds fractional coordinates", () => {
    const report = repairAndParse(rawReport({ issues: [rawIssue({ region: [1.4, 2.6, 3, 4] })] }));
    expect(report.issues[0].region).toEqual([1, 3, 3, 4]);
  });

  it("coerces numeric strings in the region and the confidences", () => {
    const report = repairAndParse(
      rawReport({
        issues: [rawIssue({ region: ["1", "2", "3", "4"], confidence: "0.7" })],
      }),
    );
    expect(report.issues[0].region).toEqual([1, 2, 3, 4]);
    expect(report.issues[0].confidence).toBe(0.7);
  });

  it("drops an issue whose region is entirely outside the canvas", () => {
    const past = repairAndParse(rawReport({ issues: [rawIssue({ region: [40, 40, 50, 50] })] }));
    expect(past.issues).toHaveLength(0);
    const before = repairAndParse(rawReport({ issues: [rawIssue({ region: [-9, -9, -3, -3] })] }));
    expect(before.issues).toHaveLength(0);
  });

  it("drops an issue missing its region or its confidence", () => {
    expect(repairAndParse(rawReport({ issues: [rawIssue({ region: undefined })] })).issues).toHaveLength(0);
    expect(repairAndParse(rawReport({ issues: [rawIssue({ region: [1, 2, 3] })] })).issues).toHaveLength(0);
    expect(repairAndParse(rawReport({ issues: [rawIssue({ confidence: undefined })] })).issues).toHaveLength(0);
    expect(repairAndParse(rawReport({ issues: [rawIssue({ confidence: "high" })] })).issues).toHaveLength(0);
    expect(repairAndParse(rawReport({ issues: ["not an object"] })).issues).toHaveLength(0);
  });

  it("keeps the surviving issues when one is dropped", () => {
    const report = repairAndParse(
      rawReport({
        issues: [
          rawIssue({ id: undefined, region: [99, 99, 99, 99] }),
          rawIssue({ id: undefined, issue: "the second one" }),
        ],
      }),
    );
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].issue).toBe("the second one");
  });

  it("clamps a confidence outside the unit interval instead of failing the report", () => {
    const report = repairAndParse(
      rawReport({ issues: [rawIssue({ confidence: 95, suggestConfidence: -1 })] }),
    );
    expect(report.issues[0].confidence).toBe(1);
    expect(report.issues[0].suggestConfidence).toBe(0);
  });

  it("normalizes severity and defaults an unrecognized one to medium", () => {
    expect(repairAndParse(rawReport({ issues: [rawIssue({ severity: "HIGH" })] })).issues[0].severity).toBe("high");
    expect(repairAndParse(rawReport({ issues: [rawIssue({ severity: "critical" })] })).issues[0].severity).toBe("medium");
    expect(repairAndParse(rawReport({ issues: [rawIssue({ severity: undefined })] })).issues[0].severity).toBe("medium");
  });

  it("repairs a missing issue description to \"\" rather than losing the finding", () => {
    const report = repairAndParse(rawReport({ issues: [rawIssue({ issue: undefined })] }));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].issue).toBe("");
  });

  it("strips a model-supplied degraded flag — it is the harness's verdict, not the critic's", () => {
    const report = repairAndParse(rawReport({ degraded: true }));
    expect(report.degraded).toBe(false);
  });

  it("cannot manufacture a valid report out of an empty object", () => {
    // The counterweight to every repair above: if `{}` repaired into a clean
    // empty report, an unparseable critic would be recorded as a silent pass
    // instead of reaching the reprompt.
    expect(() => repairAndParse({})).toThrow();
    expect(() => repairAndParse({ issues: "none" })).toThrow();
    expect(() => repairAndParse([])).toThrow();
    expect(() => repairAndParse("a report")).toThrow();
    expect(() => repairAndParse(null)).toThrow();
  });

  it("caps a runaway issues array well above the 8 the prompt asks for", () => {
    const many = Array.from({ length: 200 }, () => rawIssue());
    const report = repairAndParse(rawReport({ issues: many }));
    expect(report.issues.length).toBeGreaterThanOrEqual(8);
    expect(report.issues.length).toBeLessThan(200);
  });

  it("does not mutate the raw JSON it was handed", () => {
    const raw = rawReport({ issues: [rawIssue({ id: undefined, region: [-5, -5, 3, 3] })] });
    const before = structuredClone(raw);
    repairCritique(raw, SIZE_32);
    expect(raw).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// parseCritique
// ---------------------------------------------------------------------------

describe("parseCritique", () => {
  it("parses a clean response and never reports itself degraded", () => {
    const report = parseCritique(JSON.stringify(rawReport()), SIZE_32);
    expect(report.degraded).toBe(false);
    expect(report.overall).toBe(4);
    expect(report.issues).toHaveLength(1);
  });

  it("parses JSON wrapped in a markdown fence", () => {
    const raw = "```json\n" + JSON.stringify(rawReport()) + "\n```";
    expect(parseCritique(raw, SIZE_32).issues).toHaveLength(1);
  });

  it("parses JSON with prose around it", () => {
    const raw = `Here is my critique:\n${JSON.stringify(rawReport())}\nHope that helps.`;
    expect(parseCritique(raw, SIZE_32).issues).toHaveLength(1);
  });

  it("throws CritiqueParseError on output that is not JSON at all", () => {
    expect(() => parseCritique("The sprite looks great to me!", SIZE_32)).toThrow(
      CritiqueParseError,
    );
    expect(() => parseCritique("", SIZE_32)).toThrow(CritiqueParseError);
  });

  it("throws CritiqueParseError naming the offending field when validation fails", () => {
    let message = "";
    try {
      parseCritique(JSON.stringify({ readsAs: "a tree", matchesIntent: true }), SIZE_32);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("issues");
  });

  it("applies the repair table, so a report missing only id still parses", () => {
    const report = parseCritique(
      JSON.stringify(rawReport({ issues: [rawIssue({ id: undefined })] })),
      SIZE_32,
    );
    expect(report.issues).toHaveLength(1);
    expect(report.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterIssues — spec §6.4's two tiers
// ---------------------------------------------------------------------------

describe("filterIssues", () => {
  it("drops an issue below confidenceFloor entirely", () => {
    const out = filterIssues(reportOf([{ confidence: 0.2 }]), CFG);
    expect(out.issues).toHaveLength(0);
  });

  it("KEEPS confidence 0.9 / suggestConfidence 0.4 and empties only the suggest", () => {
    // The case this whole file exists for. Dropping the issue here destroys
    // §6.4's valuable cell: the problem is real, the fix is a guess.
    const before = reportOf([
      {
        id: "keep-me",
        region: [3, 4, 5, 6],
        severity: "high",
        issue: "the left ear is one pixel short",
        suggest: "add a pixel at (3,4)",
        confidence: 0.9,
        suggestConfidence: 0.4,
      },
    ]);
    const out = filterIssues(before, CFG);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].suggest).toBe("");
    // Everything else survives untouched — a "repair" that also drops the
    // region or downgrades the severity would pass a suggest-only assertion.
    expect(out.issues[0]).toEqual({ ...before.issues[0], suggest: "" });
  });

  it("keeps the suggest at 0.9 / 0.6", () => {
    const out = filterIssues(reportOf([{ confidence: 0.9, suggestConfidence: 0.6 }]), CFG);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].suggest).toBe("do a thing");
  });

  it("treats both floors as inclusive", () => {
    const out = filterIssues(
      reportOf([{ confidence: CFG.confidenceFloor, suggestConfidence: CFG.suggestConfidenceFloor }]),
      CFG,
    );
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].suggest).toBe("do a thing");
  });

  it("honours the configured floors rather than the defaults", () => {
    const strict = cfgWith({ confidenceFloor: 0.95, suggestConfidenceFloor: 0.99 });
    expect(filterIssues(reportOf([{ confidence: 0.9 }]), strict).issues).toHaveLength(0);
    const loose = cfgWith({ confidenceFloor: 0, suggestConfidenceFloor: 0 });
    const out = filterIssues(reportOf([{ confidence: 0, suggestConfidence: 0 }]), loose);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].suggest).toBe("do a thing");
  });

  it("preserves everything about the report but its issues", () => {
    const before = reportOf([{ confidence: 0.1 }]);
    const out = filterIssues(before, CFG);
    expect(out.readsAs).toBe(before.readsAs);
    expect(out.overall).toBe(before.overall);
    expect(out.matchesIntent).toBe(before.matchesIntent);
    expect(out.degraded).toBe(before.degraded);
  });

  it("does not mutate the report it was given — Wave 9 stores both", () => {
    const before = reportOf([{ confidence: 0.9, suggestConfidence: 0.1 }, { confidence: 0.1 }]);
    const snapshot = structuredClone(before);
    filterIssues(before, CFG);
    expect(before).toEqual(snapshot);
  });

  it("is idempotent on §7.3's synthetic user-feedback issue", () => {
    const synthetic = reportOf([
      { severity: "high", issue: "make the ears bigger", suggest: "", confidence: 1, suggestConfidence: 0 },
    ]);
    const once = filterIssues(synthetic, CFG);
    const twice = filterIssues(once, CFG);
    expect(once.issues).toHaveLength(1);
    expect(twice).toEqual(once);
  });
});

// ---------------------------------------------------------------------------
// critique() — the call, the image, and the reprompt budget
// ---------------------------------------------------------------------------

describe("critique", () => {
  const GOOD = JSON.stringify(rawReport());

  it("sends exactly one image, format json and think false, to the critic model", async () => {
    const client = createStubClient({ vision: [GOOD] });
    await critique({ client }, SPRITE_32, lint(SPRITE_32), CFG);

    expect(client.calls).toHaveLength(1);
    const call = client.calls[0];
    expect(call.method).toBe("vision");
    expect(call.model).toBe(CFG.models.critic);
    expect(call.images).toHaveLength(1);
    expect(call.format).toBe("json");
    expect(call.think).toBe(false);
    expect(call.system).toBe(buildCritiquePrompt(SPRITE_32, lint(SPRITE_32)).system);
    for (const row of SPRITE_32.rows) expect(call.prompt).toContain(row);
  });

  it("upscales to criticTargetPx — max(1, floor(targetPx / w))", async () => {
    for (const doc of [BLACK_OUTLINE, SPRITE_32, SPRITE_64] as SpriteDoc[]) {
      const client = createStubClient({ vision: [GOOD] });
      await critique({ client }, doc, lint(doc), CFG);
      const png = decodedImage(client.calls[0].images);
      const scale = Math.max(1, Math.floor(CFG.criticTargetPx / doc.size.w));
      expect(png.width).toBe(doc.size.w * scale);
      expect(png.height).toBe(doc.size.h * scale);
      expect(png.width).toBeLessThanOrEqual(CFG.criticTargetPx);
    }
  });

  it("never scales below 1, even when the target is smaller than the canvas", async () => {
    const client = createStubClient({ vision: [GOOD] });
    await critique({ client }, BLACK_OUTLINE, lint(BLACK_OUTLINE), cfgWith({ criticTargetPx: 8 }));
    const png = decodedImage(client.calls[0].images);
    expect(png.width).toBe(16);
  });

  it("composites transparency onto pickCriticBackground — §4.5", async () => {
    // BLACK_OUTLINE is §4.5's motivating sprite: a black ring that vanishes
    // into an uncomposited (or naively black) background.
    const client = createStubClient({ vision: [GOOD] });
    await critique({ client }, BLACK_OUTLINE, lint(BLACK_OUTLINE), CFG);
    const png = decodedImage(client.calls[0].images);
    const scale = png.width / BLACK_OUTLINE.size.w;
    const background = rgb(pickCriticBackground(BLACK_OUTLINE));

    // (0,0) is transparent in this fixture; (2,2) is index 0, the black outline.
    expect(BLACK_OUTLINE.rows[0][0]).toBe(".");
    expect(BLACK_OUTLINE.rows[2][2]).toBe("0");
    expect(pixelAt(png, 0, 0)).toEqual([...background, 255]);
    expect(pixelAt(png, 2 * scale, 2 * scale)).toEqual([
      ...rgb(BLACK_OUTLINE.palette.colors[0]),
      255,
    ]);
    // Nothing anywhere in the critic's image may be transparent — a vision
    // encoder cannot see alpha at all.
    for (let i = 3; i < png.data.length; i += 4) expect(png.data[i]).toBe(255);
  });

  it("composites a fully blank canvas too", async () => {
    const client = createStubClient({ vision: [GOOD] });
    await critique({ client }, BLANK, lint(BLANK), CFG);
    const png = decodedImage(client.calls[0].images);
    expect(pixelAt(png, 0, 0)).toEqual([...rgb(pickCriticBackground(BLANK)), 255]);
  });

  it("returns the RAW, unfiltered report — Wave 9 stores both halves", async () => {
    const client = createStubClient({
      vision: [JSON.stringify(rawReport({ issues: [rawIssue({ confidence: 0.05 })] }))],
    });
    const report = await critique({ client }, SPRITE_32, lint(SPRITE_32), CFG);
    // Below `confidenceFloor`, and still present: filtering is the pipeline's
    // call, and §6.7 keeps the raw report so the floors can be tuned later.
    expect(report.issues).toHaveLength(1);
    expect(filterIssues(report, CFG).issues).toHaveLength(0);
  });

  it("does not degrade a response that is merely missing ids", async () => {
    const client = createStubClient({
      vision: [JSON.stringify(rawReport({ issues: [rawIssue({ id: undefined })] }))],
    });
    const report = await critique({ client }, SPRITE_32, lint(SPRITE_32), CFG);
    expect(client.calls).toHaveLength(1); // no reprompt burned
    expect(report.degraded).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].id.length).toBeGreaterThan(0);
  });

  it("reprompts exactly once, carrying the validation error and the image again", async () => {
    const client = createStubClient({ vision: ["I think it looks nice.", GOOD] });
    const report = await critique({ client }, SPRITE_32, lint(SPRITE_32), CFG);

    expect(client.calls).toHaveLength(2);
    const second = client.calls[1].prompt ?? "";
    expect(second).toContain("I think it looks nice.");
    expect(second.toLowerCase()).toContain("json");
    // And it asks for a critique, not merely for well-formed JSON. §6.4 blesses
    // an empty `issues` array as a verdict on a sprite that works, and §7.2
    // reads `{degraded: false, issues: []}` as `no-high-severity` — a pass. A
    // reprompt that offers one as the fallback for a model that is struggling
    // therefore reintroduces, through wording, the silent pass `degraded`
    // exists to prevent. Uncertainty belongs in `confidence` instead.
    expect(second).not.toMatch(/empty (array|list|report)/i);
    expect(second).toContain("confidence");
    expect(client.calls[1].images).toHaveLength(1);
    expect(client.calls[1].format).toBe("json");
    expect(client.calls[1].think).toBe(false);
    expect(report.degraded).toBe(false);
    expect(report.overall).toBe(4);
  });

  it("reprompts once on a schema failure too, not only on non-JSON", async () => {
    const client = createStubClient({ vision: [JSON.stringify({ readsAs: "a tree" }), GOOD] });
    const report = await critique({ client }, SPRITE_32, lint(SPRITE_32), CFG);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1].prompt).toContain("issues");
    expect(report.degraded).toBe(false);
  });

  it("degrades after the second failure — never a throw, never a score", async () => {
    const client = createStubClient({ vision: ["nope", "still nope"] });
    const report = await critique({ client }, SPRITE_32, lint(SPRITE_32), CFG);

    expect(client.calls).toHaveLength(2); // exactly one reprompt, not two
    expect(report.degraded).toBe(true);
    expect(report.overall).toBeNull();
    expect(report.readsAs).toBeNull();
    expect(report.issues).toEqual([]);
    expect(report.matchesIntent).toBe(true);
    // And it is a document the rest of the system can carry.
    expect(() => CritiqueReportSchema.parse(report)).not.toThrow();
  });

  it("propagates a transport error rather than degrading — §9 needs the cause", async () => {
    const unreachable = new OllamaUnreachableError("http://127.0.0.1:11434");
    const first = createStubClient({ vision: [unreachable] });
    await expect(critique({ client: first }, SPRITE_32, lint(SPRITE_32), CFG)).rejects.toThrow(
      OllamaUnreachableError,
    );
    expect(first.calls).toHaveLength(1);

    // Including on the reprompt: a critic that answers once and then dies is a
    // failed round, not a degraded critique.
    const second = createStubClient({ vision: ["nope", unreachable] });
    await expect(critique({ client: second }, SPRITE_32, lint(SPRITE_32), CFG)).rejects.toThrow(
      OllamaUnreachableError,
    );
    expect(second.calls).toHaveLength(2);
  });

  it("arms an AbortSignal with the floored, area-scaled callTimeoutMs — §6.8, §9", async () => {
    const client = hangingClient();
    // Both terms dialled down, because A12 made the *floor* the operative one on
    // a 16×16: leaving `callTimeoutFloorMs` at its 45 s default would keep this
    // test hanging for 45 seconds and then still pass, which is the worst of
    // both outcomes.
    const cfg = cfgWith({ callTimeoutMs: 20, callTimeoutFloorMs: 5 });
    await expect(critique({ client }, BLACK_OUTLINE, lint(BLACK_OUTLINE), cfg)).rejects.toThrow(
      OllamaTimeoutError,
    );
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("criticTimeoutMs — spec §6.8, amendment A12", () => {
  it("gives a 16×16 the FLOOR, not 120000 × 256/1024", () => {
    // The defect A12 exists to fix, and the one this stage was still carrying
    // after Wave 6b fixed it in `draft.ts` only: pure area scaling made the
    // *smallest* canvas the tightest deadline, and 30 s does not cover a cold
    // load of a 6 GB critic plus a vision call.
    expect(criticTimeoutMs(CFG, { w: 16, h: 16 })).toBe(CFG.callTimeoutFloorMs);
    expect(criticTimeoutMs(CFG, { w: 16, h: 16 })).toBe(45000);
    expect(criticTimeoutMs(CFG, { w: 16, h: 16 })).not.toBe(30000);
    expect(criticTimeoutMs(CFG, { w: 16, h: 16 })).not.toBe(CFG.callTimeoutMs / 4);
  });

  it("still scales with canvas area above the floor — §6.8", () => {
    expect(criticTimeoutMs(CFG, { w: 32, h: 32 })).toBe(CFG.callTimeoutMs);
    expect(criticTimeoutMs(CFG, { w: 64, h: 64 })).toBe(CFG.callTimeoutMs * 4);
  });

  it("honours a raised floor over a larger area term", () => {
    expect(criticTimeoutMs(cfgWith({ callTimeoutFloorMs: 200000 }), { w: 32, h: 32 })).toBe(200000);
  });

  it("never returns zero", () => {
    expect(
      criticTimeoutMs(cfgWith({ callTimeoutMs: 1, callTimeoutFloorMs: 1 }), { w: 16, h: 16 }),
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// contract test — real `qwen3-vl` output, captured once
//
// Plan task 7.5. The point is drift: when a future model or prompt change makes
// the critic emit a shape this stage cannot digest, this test goes red rather
// than the pipeline quietly reporting `critic-failed` in production.
// ---------------------------------------------------------------------------

const CAPTURE_PATH = fileURLToPath(
  new URL(
    "../../docs/superpowers/specs/captures/2026-07-29-wave-7-critic-sample.txt",
    import.meta.url,
  ),
);

/** The capture is a document; this line separates its prose from `payload.response`. */
const CAPTURE_SENTINEL = "----- BEGIN VERBATIM RESPONSE -----\n";

/** Exactly what `qwen3-vl` sent, with none of the surrounding write-up. */
function capturedResponse(): string {
  // Deliberately not the whole file: `parseCritique` tolerates prose around the
  // JSON, so feeding it the write-up too would test this suite's own header
  // rather than the model's output.
  const file = readFileSync(CAPTURE_PATH, "utf8");
  const at = file.indexOf(CAPTURE_SENTINEL);
  expect(at).toBeGreaterThan(-1);
  return file.slice(at + CAPTURE_SENTINEL.length);
}

describe("real critic output", () => {
  it("has a committed capture", () => {
    // Absent, this whole section would pass vacuously — the same trap plan
    // task 4.6 names for the golden PNG.
    expect(existsSync(CAPTURE_PATH)).toBe(true);
  });

  it("would FAIL validation unrepaired — clamping is not a hypothetical", () => {
    // Three of the four regions `qwen3-vl` actually emitted name x1 or y1 = 32
    // on a 32×32 canvas. `Coord` has no upper bound, so these do not fail the
    // schema — they fail nothing, and an unrepaired report would hand the
    // revise stage four out-of-bounds edits.
    const raw = JSON.parse(capturedResponse()) as { issues: Array<{ region: number[] }> };
    const outOfBounds = raw.issues.filter((i) => i.region.some((c) => c > 31));
    expect(outOfBounds.length).toBeGreaterThan(0);
  });

  it("parses the captured qwen3-vl response without a reprompt", async () => {
    const raw = capturedResponse();
    const report = parseCritique(raw, SIZE_32);

    expect(report.degraded).toBe(false);
    expect(report.overall).toBe(3);
    expect(report.issues).toHaveLength(4);
    for (const issue of report.issues) {
      const [x0, y0, x1, y1] = issue.region;
      expect(x0).toBeLessThanOrEqual(x1);
      expect(y0).toBeLessThanOrEqual(y1);
      expect(x1).toBeLessThan(32); // clamped from the model's 32
      expect(y1).toBeLessThan(32);
    }

    // The real model's own two-tier case: 0.95 confidence, 0.3 suggest
    // confidence. Every issue survives the filter; every `suggest` is withheld.
    const filtered = filterIssues(report, CFG);
    expect(filtered.issues).toHaveLength(4);
    for (const issue of filtered.issues) expect(issue.suggest).toBe("");
    for (const issue of report.issues) expect(issue.suggest).not.toBe("");
  });

  it("drives the whole stage on one call", async () => {
    const client = createStubClient({ vision: [capturedResponse()] });
    const report = await critique({ client }, SPRITE_32, lint(SPRITE_32), CFG);
    expect(client.calls).toHaveLength(1); // no reprompt burned on real output
    expect(report.degraded).toBe(false);
  });
});
