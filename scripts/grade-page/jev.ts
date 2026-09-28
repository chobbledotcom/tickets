/**
 * The Jev client: one TypeSafe call per page through the OpenCode zen API.
 * The state carries the page's source plus the line-addressed evidence the
 * mechanical pass extracted, and every answer comes back as a score with a
 * confidence. A PASS or a FAIL the model itself is unsure about
 * (confidence under 0.3) becomes a WARN for human review, not a verdict.
 */

import * as v from "valibot";
import type { FetchTextResult } from "#scripts/fetch-text.ts";
import type { CheckEntry, Verdict } from "./checks.ts";
import type { PageFacts } from "./extract.ts";

export const ZEN_SYSTEMONE_URL = "https://opencode.ai/zen/v1/systemone";
export const DEFAULT_MODEL = "jev-1.13";

export type JevFetch = (
  url: string,
  init: RequestInit,
) => Promise<FetchTextResult>;
export type Sleep = (ms: number) => Promise<void>;

/** The key from the environment, or the shared secret file, or nothing.
 * A key of only spaces is no key, so it never reaches the paid endpoint. */
export const loadJevKey = (
  getEnv: (key: string) => string | undefined,
  readSecret: () => string | null,
): string | null => {
  const fromEnv = getEnv("OPENCODE_API_KEY")?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const fromFile = readSecret()?.trim();
  return fromFile === undefined || fromFile === "" ? null : fromFile;
};

/** Every question is a 0-3 score question, so every answer carries one. */
const AnswerSchema = v.object({
  confidence: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  score: v.pipe(v.number(), v.minValue(0), v.maxValue(3)),
  type: v.literal("score"),
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

export type JevAnswers = Record<string, v.InferOutput<typeof AnswerSchema>>;

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

export const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** Parse one endpoint reply, or say what is wrong with it. */
const parseJevResponse = (text: string, request: JevRequest): JevCallResult => {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // A proxy or an outage can answer 200 with an HTML error page.
    return {
      error: `the answer is not JSON: ${text.slice(0, 300)}`,
      ok: false,
    };
  }
  const parsed = v.safeParse(ResponseSchema, body);
  if (!parsed.success) {
    return {
      error: `the answer shape is wrong: ${parsed.issues[0]?.message}`,
      ok: false,
    };
  }
  const { answers, model, usage } = parsed.output;
  const unanswered = Object.keys(request.questions).filter(
    (id) => answers[id] === undefined,
  );
  if (unanswered.length > 0) {
    return { error: `no answer for ${unanswered.join(", ")}`, ok: false };
  }
  return {
    answers,
    ok: true,
    usage: {
      inputTokens: usage?.input_tokens,
      model: model ?? request.model,
      outputTokens: usage?.output_tokens,
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

const ATTEMPTS = 3;

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
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const result = await fetchText(
      ZEN_SYSTEMONE_URL,
      postJson(body, request),
    ).catch((error: unknown) => {
      // A network failure is worth another attempt, unlike a refusal.
      lastError = errorText(error);
      return null;
    });
    if (result?.ok) return parseJevResponse(result.text, request);
    if (result !== null) {
      lastError = `HTTP ${result.status}: ${result.text.slice(0, 300)}`;
      if ([400, 401, 402].includes(result.status)) break;
    }
    if (attempt < ATTEMPTS) {
      const rateLimited = result?.status === 429;
      await sleep((rateLimited ? 5000 : 1000) * attempt);
    }
  }
  return { error: lastError, ok: false };
};

/** The state one page's questions are asked against. */
export const buildJevState = (facts: PageFacts): Record<string, unknown> => ({
  as_casts: facts.asCasts,
  catch_clauses: facts.catchClauses,
  comments: facts.comments,
  content: facts.content,
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
  // An answer the model itself is unsure about asks for a person, whichever
  // way it leans, so an unsure answer never decides a PASS or a FAIL.
  const unsure = confidence !== undefined && confidence < 0.3;
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
    // callJev refuses a reply that leaves a question unanswered.
    if (answer === undefined) {
      throw new Error(`Jev returned no answer for ${check.id}`);
    }
    results[check.id] = verdictForScore(answer.score, answer.confidence, check);
  }
  return results;
};
