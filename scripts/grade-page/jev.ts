/**
 * The Jev client: one TypeSafe call per page through the OpenCode zen API.
 * The state carries the page's source plus the line-addressed evidence the
 * mechanical pass extracted, and every answer comes back as a score with a
 * confidence. A FAIL the model itself is unsure about (confidence under
 * 0.3) becomes a WARN for human review, not a verdict.
 */

import * as v from "valibot";
import type { FetchTextResult } from "#scripts/fetch-text.ts";
import type { CheckEntry, Verdict } from "./checks.ts";
import type { PageFacts } from "./extract.ts";

export const ZEN_SYSTEMONE_URL = "https://opencode.ai/zen/v1/systemone";
export const DEFAULT_MODEL = "jev-1.13";

/** How much source one call carries. Sits above the longest page in `src/`
 * with headroom, so a real page never truncates: grading a partially
 * visible page is how long files get mis-scored. */
export const MAX_CONTENT_CHARS = 24000;

export type JevFetch = (
  url: string,
  init: RequestInit,
) => Promise<FetchTextResult>;
export type Sleep = (ms: number) => Promise<void>;

/** The key from the environment, or the shared secret file, or nothing. */
export const loadJevKey = (
  getEnv: (key: string) => string | undefined,
  readSecret: () => string | null,
): string | null => {
  const fromEnv = getEnv("OPENCODE_API_KEY");
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv.trim();
  const fromFile = readSecret();
  return fromFile === null ? null : fromFile.trim();
};

const AnswerSchema = v.object({
  confidence: v.optional(v.number()),
  noul: v.optional(v.number()),
  score: v.optional(v.number()),
  type: v.picklist(["noul", "score"]),
});

const ResponseSchema = v.object({
  answers: v.record(v.string(), AnswerSchema),
  model: v.optional(v.string()),
  usage: v.optional(
    v.object({
      input_tokens: v.optional(v.number()),
      output_tokens: v.optional(v.number()),
    }),
  ),
});

export interface JevAnswers {
  [id: string]: {
    type: "noul" | "score";
    noul?: number | undefined;
    score?: number | undefined;
    confidence?: number | undefined;
  };
}

export interface JevUsage {
  inputTokens?: number | undefined;
  model: string;
  outputTokens?: number | undefined;
}

export type JevCallResult =
  | { ok: true; answers: JevAnswers; usage: JevUsage }
  | { ok: false; error: string };

interface JevRequest {
  apiKey: string;
  model: string;
  questions: Record<string, unknown>;
  session: string;
  state: unknown;
}

/** Parse one endpoint reply, or say what is wrong with its shape. */
const parseJevResponse = (text: string, model: string): JevCallResult => {
  const parsed = v.safeParse(ResponseSchema, JSON.parse(text));
  if (!parsed.success) {
    return {
      error: `the answer shape is wrong: ${parsed.issues[0]?.message}`,
      ok: false,
    };
  }
  return {
    answers: parsed.output.answers,
    ok: true,
    usage: {
      inputTokens: parsed.output.usage?.input_tokens,
      model: parsed.output.model ?? model,
      outputTokens: parsed.output.usage?.output_tokens,
    },
  };
};

/** The request one attempt posts. */
const postJson = (body: string, request: JevRequest): RequestInit => ({
  body,
  headers: {
    Authorization: `Bearer ${request.apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": "grade-page/0.1 (tickets)",
    "x-opencode-session": request.session,
  },
  method: "POST",
});

/** One TypeSafe call, with the retries a paid endpoint needs. */
export const callJev = async (
  request: JevRequest,
  fetchText: JevFetch,
  sleep: Sleep,
): Promise<JevCallResult> => {
  const body = JSON.stringify({
    model: request.model,
    questions: request.questions,
    state: request.state,
  });
  let lastError = "no attempt made";
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await fetchText(
      ZEN_SYSTEMONE_URL,
      postJson(body, request),
    ).catch((error: unknown) => {
      // A network failure is worth another attempt, unlike a refusal.
      lastError =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      return null;
    });
    if (result?.ok) return parseJevResponse(result.text, request.model);
    if (result !== null) {
      lastError = `HTTP ${result.status}: ${result.text.slice(0, 300)}`;
      if (result.status === 429) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if ([400, 401, 402].includes(result.status)) break;
    }
    await sleep(1000 + attempt);
  }
  return { error: lastError, ok: false };
};

/** The state one page's questions are asked against. */
export const buildJevState = (facts: PageFacts): Record<string, unknown> => ({
  as_casts: facts.asCasts,
  catch_clauses: facts.catchClauses,
  comments: facts.comments,
  content: facts.content.slice(0, MAX_CONTENT_CHARS),
  content_truncated: facts.content.length > MAX_CONTENT_CHARS,
  fallback_operators: facts.fallbacks,
  file: facts.file,
  for_each_calls: facts.forEachCalls,
  hrefs: facts.hrefs,
  imports: facts.imports,
  jargon_hits: facts.jargonHits,
  kind: facts.kind,
  lines: facts.lines,
  missing_return_types: facts.missingReturnTypes,
  nonnull_assertions: facts.nonNullAssertions,
  sql_statements: facts.sql,
  standards:
    "The rules judged here are the code-quality rules in this repository's " +
    "AGENTS.md. Judge only the page in `content` and the evidence fields, " +
    "not what a perfect file would contain.",
  write_calls: facts.writeCalls,
});

export interface JevCheckResult extends Verdict {
  critical: false;
  engine: "jev";
  label: string;
  weight: number;
}

/** A verdict that asks a person to look, because the call said nothing. */
const forReview = (check: CheckEntry, note: string): JevCheckResult => ({
  critical: false,
  engine: "jev",
  goodness: 0.5,
  label: check.label,
  note,
  status: "WARN",
  weight: check.weight,
});

/** One scored answer as a verdict, confidence rules applied. */
const verdictForScore = (
  score: number,
  confidence: number | undefined,
  check: CheckEntry,
): JevCheckResult => {
  const passAt = check.score_pass ?? 2;
  const warnAt = check.score_warn ?? 1;
  const goodness = score >= passAt ? 1 : score >= warnAt ? 0.5 : 0;
  const status = goodness === 1 ? "PASS" : goodness === 0.5 ? "WARN" : "FAIL";
  // A FAIL the model itself is unsure about asks for a person, not a verdict.
  const unsure =
    status === "FAIL" && confidence !== undefined && confidence < 0.3;
  const confNote =
    confidence === undefined ? "" : ` (conf ${confidence.toFixed(2)})`;
  return {
    critical: false,
    engine: "jev",
    goodness: unsure ? 0.5 : goodness,
    label: check.label,
    note: `score=${score.toFixed(2)}${confNote}`,
    status: unsure ? "WARN" : status,
    weight: check.weight,
  };
};

/** Turn each answer into the same verdict shape the mechanical half uses. */
export const gradeJevAnswers = (
  answers: JevAnswers,
  checks: CheckEntry[],
): Record<string, JevCheckResult> => {
  const results: Record<string, JevCheckResult> = {};
  for (const check of checks) {
    if (check.engine !== "jev" || check.question === undefined) continue;
    const answer = answers[check.id];
    if (answer === undefined) {
      results[check.id] = forReview(check, "no answer returned - human review");
      continue;
    }
    if (answer.type === "score" && answer.score !== undefined) {
      results[check.id] = verdictForScore(
        answer.score,
        answer.confidence,
        check,
      );
      continue;
    }
    results[check.id] = forReview(
      check,
      "the answer carries no score - human review",
    );
  }
  return results;
};
