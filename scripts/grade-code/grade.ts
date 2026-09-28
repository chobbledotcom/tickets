/**
 * Grade one file: the mechanical checks always run, and the Jev questions
 * run when the run has Jev settings. Everything the grade needs arrives as
 * a dependency, so tests drive this without the network or the repository.
 */

import { activeChecks, type GradeContext, runMechanical } from "./checks.ts";
import { type CodeFacts, codeKind, extractCode } from "./extract.ts";
import {
  buildJevState,
  callJev,
  errorText,
  gradeJevAnswers,
  type JevCheckResult,
  type JevFetch,
  type Sleep,
} from "./jev.ts";
import { type CodeResult, type ReportRow, summarise } from "./report.ts";

export interface GradeDeps {
  fetchText: JevFetch;
  now: () => number;
  readFile: (path: string) => Promise<string>;
  sleep: Sleep;
}

export interface JevSettings {
  apiKey: string;
  model: string;
}

/** What one grading pass needs besides the file itself. A run without
 * Jev settings grades every file on the mechanical checks alone. */
export interface GradeCall {
  ctx: GradeContext;
  jev: JevSettings | null;
}

/** A session name per file, so one sweep stays traceable in the API logs. */
const sessionFor = (file: string): string =>
  `grade-code-${file.replace(/[^a-z0-9]/gi, "").slice(-40)}`;

/** Grade one file into a result row, mechanical checks plus Jev judgement. */
export const gradeCode = async (
  deps: GradeDeps,
  call: GradeCall,
  file: string,
): Promise<CodeResult> => {
  const started = deps.now();
  try {
    const facts = extractCode(file, await deps.readFile(file));
    const results: Record<string, ReportRow> = runMechanical(facts, call.ctx);
    const jevOutcome = await askJev(deps, call.jev, facts);
    Object.assign(results, jevOutcome.results);
    const { counts, letter, score } = summarise(results);
    return {
      checks: results,
      counts,
      error: null,
      file,
      jev: jevOutcome.jev,
      jevError: jevOutcome.jevError,
      kind: facts.kind,
      letter,
      lines: facts.lines,
      score,
      seconds: (deps.now() - started) / 1000,
    };
  } catch (error) {
    return {
      checks: {},
      counts: { FAIL: 0, PASS: 0, WARN: 0 },
      error: errorText(error),
      file,
      jev: null,
      jevError: null,
      kind: codeKind(file),
      letter: "E",
      lines: 0,
      score: null,
      seconds: (deps.now() - started) / 1000,
    };
  }
};

/** What asking Jev added to a file's grade. */
interface JevOutcome {
  jev: CodeResult["jev"];
  jevError: string | null;
  results: Record<string, JevCheckResult>;
}

/** Ask the judgement questions, when the run has Jev settings. */
const askJev = async (
  deps: GradeDeps,
  settings: JevSettings | null,
  facts: CodeFacts,
): Promise<JevOutcome> => {
  const jevChecks = activeChecks(facts).filter(
    (check) => check.engine === "jev" && check.question !== undefined,
  );
  if (jevChecks.length === 0 || settings === null) {
    return { jev: null, jevError: null, results: {} };
  }
  const callStarted = deps.now();
  const call = await callJev(
    {
      apiKey: settings.apiKey,
      model: settings.model,
      questions: Object.fromEntries(
        jevChecks.map((check) => [check.id, check.question]),
      ),
      session: sessionFor(facts.file),
      state: buildJevState(facts),
    },
    deps.fetchText,
    deps.sleep,
  );
  if (!call.ok) return { jev: null, jevError: call.error, results: {} };
  const inOut =
    call.usage.inputTokens === undefined
      ? undefined
      : `${call.usage.inputTokens} in / ${
          call.usage.outputTokens ?? "?"
        } out tokens`;
  return {
    jev: {
      model: call.usage.model,
      seconds: (deps.now() - callStarted) / 1000,
      ...(inOut === undefined ? {} : { tokens: inOut }),
    },
    jevError: null,
    results: gradeJevAnswers(call.answers, jevChecks),
  };
};
