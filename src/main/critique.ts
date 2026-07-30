/**
 * The vision critique stage — spec §4.4, §4.5, §6.4, §9.
 *
 * The stage is four steps: render the sprite the way a vision encoder can
 * actually read it, ask the critic, repair what it sends back, and — separately,
 * on the pipeline's terms — filter what the revise stage is allowed to see.
 *
 * Four rules govern this file, and each one is a defect that shipped somewhere
 * before it was a rule:
 *
 * **1. Repair runs on the raw JSON, before validation.** `Coord` is
 * non-negative, so `[-5, -5, 3, 3]` — §6.4 names it the most common VLM error —
 * fails `CritiqueReportSchema`. Validating first means a report full of usable
 * findings burns the single reprompt and then degrades to nothing, which is the
 * permanent silent no-op §6.4 was written to prevent.
 *
 * **2. Only genuinely unusable output triggers the reprompt.** Missing `id`,
 * missing `suggest`, a reversed region, a fifth severity word: all repaired,
 * none of them fatal. What is fatal is output that is not a report at all —
 * prose, or JSON with no `issues` array. `repairCritique` is deliberately unable
 * to manufacture `issues`, so `{}` reaches the reprompt rather than being
 * recorded as a clean review that found nothing.
 *
 * **3. A second failure degrades; it never throws and never scores.** A broken
 * critic must not destroy a valid sprite, so `critique()` returns
 * `{ degraded: true, overall: null, readsAs: null, issues: [] }`. `degraded` is
 * what stops §7.2 reporting `no-high-severity` for a critique that never ran,
 * and the null `overall` is what keeps an invented number out of
 * `SessionHistory` and out of every bench-derived quality metric.
 *
 * Transport failures are *not* that case. An `OllamaUnreachableError` or an
 * `OllamaTimeoutError` propagates: §9 requires the round to fail naming the
 * cause, and a degraded report would swallow it.
 *
 * **4. `critique()` returns the RAW report.** Filtering is the pipeline's call —
 * §6.7 stores `critique` (raw) and `filteredIssues` side by side precisely so
 * the confidence floors can be tuned against real data later, and §12 says those
 * floors are first guesses. A stage that filtered on the way out would destroy
 * the data that makes tuning possible.
 */

import type { OllamaClient } from "@main/ollama";
import { buildCritiqueReprompt, buildCritiquePrompt } from "@main/prompts/critique";
import { pickCriticBackground, toPng } from "@main/render";
import { CritiqueReportSchema } from "@shared/schema";
import type {
  CritiqueReport,
  HarnessConfig,
  Issue,
  LintReport,
  Size,
  SpriteDoc,
} from "@shared/schema";

import type { z } from "zod";

export { buildCritiquePrompt };

/** The canvas §6.8's `callTimeoutMs` is quoted against. */
const BASELINE_AREA = 32 * 32;

/**
 * The ceiling on a runaway `issues` array.
 *
 * §6.4 sets no limit and the prompt asks for at most 8. This is not a quality
 * filter — that is `filterIssues`' job — it is a bound on what a looping model
 * can push into `SessionHistory` and into the revise stage's context. Set well
 * above the prompt's ask so a merely enthusiastic critic loses nothing.
 */
const MAX_ISSUES = 32;

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/**
 * The critic's output could not be turned into a `CritiqueReport`.
 *
 * Carries `detail` separately from `message` because the reprompt quotes it back
 * to the model, and carries `raw` because that is the only evidence of what the
 * critic actually said once the report has degraded.
 *
 * Thrown by `parseCritique` and caught by `critique()`. Nothing else in the
 * system should see it: by the time the pipeline holds a report, the question
 * "did the critic parse" is answered by `degraded`.
 */
export class CritiqueParseError extends Error {
  override readonly name = "CritiqueParseError";

  constructor(
    readonly detail: string,
    readonly raw: string,
  ) {
    super(`critic response could not be used: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// coercion helpers — everything here reads untrusted model output
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A finite number, accepting the numeric strings a model routinely emits.
 *
 * `"3"` where the contract says `3` is well-formed intent with a technically
 * wrong type — §6.6 makes the same allowance for the revise tools. Anything that
 * is not a number (`"high"`, `null`, `{}`) returns `undefined`, and callers turn
 * that into the documented repair rather than into a `NaN` that would fail
 * validation two frames later.
 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * A confidence, clamped into the unit interval.
 *
 * Clamping rather than dropping: a critic answering `confidence: 95` means
 * "certain", and the schema's 0..1 bound would otherwise fail the *whole report*
 * over one issue's units. That is the same failure mode as the negative region
 * in rule 1 — one sloppy field destroying a page of usable findings.
 */
function unit(value: number): number {
  return clamp(value, 0, 1);
}

// ---------------------------------------------------------------------------
// repair — spec §6.4's table, on the raw JSON, before validation
// ---------------------------------------------------------------------------

/**
 * `[x0, y0, x1, y1]` clamped to the canvas, or `undefined` if the issue should
 * be dropped.
 *
 * Order matters: round, then normalize a reversed pair, then test for entirely
 * outside, then clamp. Clamping before the outside test would pull
 * `[40, 40, 50, 50]` onto the canvas edge and report a finding at a place the
 * critic never looked at.
 */
function repairRegion(raw: unknown, size: Size): [number, number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;

  const parsed = raw.map(asNumber);
  if (parsed.some((n) => n === undefined)) return undefined;
  const [a, b, c, d] = parsed.map((n) => Math.round(n as number));

  const [x0, x1] = a <= c ? [a, c] : [c, a];
  const [y0, y1] = b <= d ? [b, d] : [d, b];

  const maxX = size.w - 1;
  const maxY = size.h - 1;
  if (x1 < 0 || y1 < 0 || x0 > maxX || y0 > maxY) return undefined;

  return [clamp(x0, 0, maxX), clamp(y0, 0, maxY), clamp(x1, 0, maxX), clamp(y1, 0, maxY)];
}

/** The three severity words, case-normalized; anything else becomes `medium`. */
function repairSeverity(raw: unknown): Issue["severity"] {
  if (typeof raw === "string") {
    const word = raw.trim().toLowerCase();
    if (word === "high" || word === "medium" || word === "low") return word;
  }
  // Not in §6.4's table, and the alternative is worse: an unrecognized severity
  // word would fail the whole report. `medium` is the value that neither
  // suppresses a real problem (as `low` would, under §7.2's `no-high-severity`
  // stop condition) nor manufactures one (as `high` would, by keeping the loop
  // running on a finding the critic never called urgent).
  return "medium";
}

/** One issue, repaired — or `undefined` when §6.4 says to drop it. */
function repairIssue(raw: unknown, index: number, size: Size): Issue | undefined {
  if (!isRecord(raw)) return undefined;

  // The two fields that ARE the finding. Without a region there is nothing to
  // point at, and without a confidence there is nothing to filter on, so §6.4
  // drops the issue rather than inventing either.
  const region = repairRegion(raw.region, size);
  if (region === undefined) return undefined;
  const confidence = asNumber(raw.confidence);
  if (confidence === undefined) return undefined;

  // `suggest` and `suggestConfidence` move together: a missing hint takes
  // `suggestConfidence: 0` with it, because confidence in a suggestion that
  // does not exist is not a number the filter should ever act on.
  const text = typeof raw.suggest === "string" ? raw.suggest : "";
  const hasSuggest = text.trim().length > 0;

  return {
    // Synthesized from the position in the RAW array, so ids stay stable when a
    // sibling is dropped above.
    id: typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id : `issue-${index}`,
    region,
    severity: repairSeverity(raw.severity),
    issue: typeof raw.issue === "string" ? raw.issue : "",
    suggest: hasSuggest ? text : "",
    confidence: unit(confidence),
    suggestConfidence: hasSuggest ? unit(asNumber(raw.suggestConfidence) ?? 0) : 0,
  };
}

/** `1`-`5`, or `null` — never invented, only ever rounded into range. */
function repairOverall(raw: unknown): 1 | 2 | 3 | 4 | 5 | null {
  const parsed = asNumber(raw);
  if (parsed === undefined) return null;
  return clamp(Math.round(parsed), 1, 5) as 1 | 2 | 3 | 4 | 5;
}

/** §6.4: a critic that did not answer is assumed not to be complaining. */
function repairMatchesIntent(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const word = raw.trim().toLowerCase();
    if (word === "false" || word === "no") return false;
    if (word === "true" || word === "yes") return true;
  }
  return true;
}

/**
 * Apply §6.4's repair table to raw parsed JSON — **before** schema validation.
 *
 * Returns `unknown` on purpose: the output is still untrusted, and the only
 * thing that may declare it a `CritiqueReport` is `CritiqueReportSchema`.
 *
 * **What this deliberately does not repair is `issues`.** Every other field has
 * a defensible default, so a repair that also synthesized an empty issue list
 * would turn `{}` — and any prose the model wrapped in braces — into a clean
 * report saying the sprite has no problems. The reprompt exists for exactly
 * that input, and a repair generous enough to satisfy the schema would make the
 * reprompt unreachable.
 *
 * The input is never mutated: §6.7 keeps the raw critique in `SessionHistory`,
 * and a caller holding the parsed JSON should still hold what the model sent.
 */
export function repairCritique(rawJson: unknown, size: Size): unknown {
  if (!isRecord(rawJson)) return rawJson;

  const repaired: Record<string, unknown> = { ...rawJson };

  // `degraded` is the harness's verdict, not the critic's — §6.4. A model that
  // emits it would otherwise mark its own perfectly good report as a failure,
  // and §7.2 would stop the run with `critic-failed`.
  delete repaired.degraded;

  repaired.readsAs = typeof rawJson.readsAs === "string" ? rawJson.readsAs : null;
  repaired.matchesIntent = repairMatchesIntent(rawJson.matchesIntent);
  repaired.overall = repairOverall(rawJson.overall);

  if (Array.isArray(rawJson.issues)) {
    repaired.issues = rawJson.issues
      .slice(0, MAX_ISSUES)
      .map((issue, index) => repairIssue(issue, index, size))
      .filter((issue): issue is Issue => issue !== undefined);
  }

  return repaired;
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

/** ```` ```json … ``` ```` — the fence `format: "json"` is supposed to prevent. */
const FENCED = /```(?:json)?\s*([\s\S]*?)```/;

/**
 * The first JSON value in `raw`, or a `CritiqueParseError`.
 *
 * Three attempts, cheapest first: the whole string, the contents of a markdown
 * fence, then the span from the first `{` to the last `}`. `format: "json"`
 * makes all three unnecessary in the good case, but the reprompt is a scarce
 * resource — spending it on a model that wrapped a correct answer in "Here is
 * my critique:" would be a waste of a whole inference.
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CritiqueParseError("the critic returned an empty response", raw);
  }

  const candidates = [trimmed];
  const fenced = FENCED.exec(trimmed);
  if (fenced !== null) candidates.push(fenced[1].trim());
  const open = trimmed.indexOf("{");
  const close = trimmed.lastIndexOf("}");
  if (open >= 0 && close > open) candidates.push(trimmed.slice(open, close + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // next candidate
    }
  }
  throw new CritiqueParseError("the critic's response was not JSON", raw);
}

/** `issues.0.region: expected array, received undefined` — quoted in the reprompt. */
function describeValidation(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

/**
 * Raw model text → a validated `CritiqueReport`, applying §6.4's repairs.
 *
 * Throws `CritiqueParseError` when the output cannot be used at all. That is the
 * only signal `critique()` reads to decide whether to spend its single reprompt,
 * so everything repairable must have been repaired before this returns.
 */
export function parseCritique(raw: string, size: Size): CritiqueReport {
  const repaired = repairCritique(extractJson(raw), size);
  const result = CritiqueReportSchema.safeParse(repaired);
  if (!result.success) throw new CritiqueParseError(describeValidation(result.error), raw);
  return result.data;
}

// ---------------------------------------------------------------------------
// the two-tier filter — spec §6.4
// ---------------------------------------------------------------------------

/**
 * Drop the hallucinations, withhold the guesses — spec §6.4, pinned literally by
 * plan Wave 7 because the two tiers are trivially invertible.
 *
 * - Below `confidenceFloor`: the problem is probably not real. Drop the issue.
 * - Above it, but below `suggestConfidenceFloor`: the problem is real and the
 *   fix is a guess. **Keep the issue and empty `suggest`.** Dropping it here is
 *   the defect §6.4 exists to name — high confidence with low suggest
 *   confidence is the single most valuable thing a critic can report, and the
 *   revise stage is an agent precisely so it can solve such a case itself.
 *
 * Pure: §6.7 stores the raw report beside the filtered issues, so the input is
 * copied rather than edited. Idempotent, which §7.3's synthetic feedback issue
 * (`confidence: 1`, `suggestConfidence: 0`, `suggest: ""`) relies on.
 */
export function filterIssues(report: CritiqueReport, cfg: HarnessConfig): CritiqueReport {
  const issues = report.issues
    .filter((i) => i.confidence >= cfg.confidenceFloor)
    .map((i) => (i.suggestConfidence >= cfg.suggestConfidenceFloor ? i : { ...i, suggest: "" }));
  return { ...report, issues };
}

// ---------------------------------------------------------------------------
// the stage
// ---------------------------------------------------------------------------

/**
 * The effective timeout for one critic call — spec §6.8, amendment A12, §9.
 *
 * `max(callTimeoutFloorMs, callTimeoutMs × area / 32²)`. The area term is quoted
 * for a 32×32 canvas: a 64×64 sprite is four times the grid text and four times
 * the image, so a flat limit would abort legitimate calls.
 *
 * **The floor is the amendment**, and it is what this function was missing.
 * Pure area scaling made the *smallest* canvas the tightest deadline — a 16×16
 * got `120000 × 256/1024 = 30 s`, and cold-loading a 6-19 GB critic costs 8-25 s
 * of that regardless of what it is looking at. A12 words the rule generally, so
 * every stage that arms a per-call deadline takes the floor, not just the draft.
 *
 * Spelled the same way as `draftTimeoutMs` deliberately: two spellings of one
 * amendment is how one of them ends up not having it. `callTimeoutFloorMs` is a
 * positive int in the schema, so it also carries the old "never a zero-length
 * deadline" guarantee that an explicit `Math.max(1, …)` used to provide here.
 */
export function criticTimeoutMs(cfg: HarnessConfig, size: Size): number {
  return Math.max(
    cfg.callTimeoutFloorMs,
    Math.round((cfg.callTimeoutMs * size.w * size.h) / BASELINE_AREA),
  );
}

/** §6.8: a target, not a multiplier — 16×16 and 64×64 both land near 512px. */
function criticScale(cfg: HarnessConfig, size: Size): number {
  return Math.max(1, Math.floor(cfg.criticTargetPx / size.w));
}

/** What §6.4 requires when the critic could not be parsed twice. */
function degradedReport(): CritiqueReport {
  return {
    readsAs: null,
    matchesIntent: true,
    overall: null,
    degraded: true,
    issues: [],
  };
}

/**
 * Critique one sprite — spec §6.4.
 *
 * Sends the nearest-neighbour upscale **composited onto
 * `pickCriticBackground(doc)`** (§4.5 — `qwen3-vl` reported *"No visible
 * differences"* between transparency and opaque black, and `pico-8` index 0 is
 * `#000000`, so an uncomposited black-outlined sprite has no silhouette at all),
 * the grid as text (§4.4), and `format: "json"` with `think: false`.
 *
 * Returns the **raw, unfiltered** report — see rule 4 in this file's header.
 * Never returns a filtered one, and never throws on a bad critic; it throws only
 * what the transport threw.
 */
export async function critique(
  deps: { client: OllamaClient },
  doc: SpriteDoc,
  lintReport: LintReport,
  cfg: HarnessConfig,
): Promise<CritiqueReport> {
  const { system, user } = buildCritiquePrompt(doc, lintReport);
  const image = toPng(doc, criticScale(cfg, doc.size), pickCriticBackground(doc));
  const timeoutMs = criticTimeoutMs(cfg, doc.size);

  const ask = async (prompt: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await deps.client.vision({
        model: cfg.models.critic,
        system,
        prompt,
        images: [image],
        format: "json",
        think: false,
        signal: controller.signal,
      });
    } finally {
      // Cleared on every path: a pending timer would hold the process open for
      // the remainder of a two-minute budget after the call already answered.
      clearTimeout(timer);
    }
  };

  const first = await ask(user);
  try {
    return parseCritique(first, doc.size);
  } catch (error) {
    if (!(error instanceof CritiqueParseError)) throw error;

    // The single reprompt. A transport failure here propagates — §9 fails the
    // round naming the cause rather than reporting a critique that never ran as
    // merely degraded.
    const second = await ask(buildCritiqueReprompt(user, first, error.detail));
    try {
      return parseCritique(second, doc.size);
    } catch (retryError) {
      if (!(retryError instanceof CritiqueParseError)) throw retryError;
      return degradedReport();
    }
  }
}
