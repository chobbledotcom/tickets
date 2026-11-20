import { stopProcess } from "#scripts/process.ts";
import {
  CHECK_PHASES,
  type CheckerResult,
  requireCounterexample,
} from "#scripts/verify-models/check.ts";
import type { ModelCheck } from "#scripts/verify-models/jobs.ts";

/** The uncached suite takes about 46 minutes with two workers. */
export const COMMAND_TIMEOUT_MS = {
  check: 30 * 60_000,
  prepare: 15 * 60_000,
  version: 60_000,
} as const;

/** Stop a stalled child, retain both streams, and never return a timed-out
 *  verdict as evidence for a negative control. */
export const outputOf = async (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CheckerResult> => {
  const child = new Deno.Command(command, {
    args,
    cwd,
    stderr: "piped",
    stdout: "piped",
  }).spawn();
  const output = child.output();
  let stopping: Promise<void> | undefined;
  const deadline = Promise.withResolvers<Deno.CommandOutput>();
  const timer = setTimeout(() => {
    stopping = stopProcess(child, 5_000);
    stopping.then(() => output).then(deadline.resolve, deadline.reject);
  }, timeoutMs);
  try {
    const result = await Promise.race([output, deadline.promise]);
    await stopping;
    const decoder = new TextDecoder();
    const text = `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`;
    if (stopping !== undefined) {
      throw new Error(
        `${command} timed out after ${timeoutMs / 1000} seconds. Read ${cwd}.\n${text}`,
      );
    }
    return { output: text, success: result.success };
  } finally {
    clearTimeout(timer);
  }
};

type CheckRunner = (check: ModelCheck) => Promise<CheckerResult>;

/** The checks that passed before with the same inputs. */
export type PassStore = {
  readonly known: (check: ModelCheck) => Promise<boolean>;
  readonly record: (check: ModelCheck) => Promise<void>;
};

const checkName = (check: ModelCheck): string => {
  if (check.kind === "proof") return CHECK_PHASES[check.phase].name;
  return `${check.name} ${check.kind === "scope" ? "scope" : "counterexample"}`;
};

/** What the checker refused, for a check that must pass. */
const refusedName = (check: ModelCheck): string =>
  check.kind === "proof" ? "proof" : `scope of ${check.name}`;

const checkOne = async (
  check: ModelCheck,
  run: CheckRunner,
  passes: PassStore,
): Promise<void> => {
  const label = `${check.module}: ${checkName(check)}`;
  if (await passes.known(check)) {
    console.log(`Passed ${label} (same inputs as an earlier pass).`);
    return;
  }
  console.log(`Check ${label}.`);
  const started = performance.now();
  const result = await run(check);
  if (check.kind === "control") {
    requireCounterexample(result, check.name, check.directory);
  } else if (!result.success) {
    throw new Error(
      `${check.module} ${refusedName(check)} failed. Read ${check.directory}.\n${result.output}`,
    );
  }
  await passes.record(check);
  console.log(`Passed ${label} (${secondsSince(started)} seconds).`);
};

/** The time since a start, in seconds, as a check line prints it. */
export const secondsSince = (started: number): string =>
  ((performance.now() - started) / 1000).toFixed(3);

/** Keep a fixed number of tasks active. Stop new work on failure, and await
 *  every active task before the caller returns. */
export const runPool = async <Item>(
  items: readonly Item[],
  workers: number,
  task: (item: Item) => Promise<void>,
): Promise<void> => {
  const pending = items.values();
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const next = pending.next();
      if (next.done) return;
      try {
        await task(next.value);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  // Each check is one JVM. Never start the whole queue.
  const results = await Promise.allSettled(
    Array.from({ length: workers }, worker),
  );
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
};

export const runChecks = (
  checks: readonly ModelCheck[],
  run: CheckRunner,
  workers: number,
  passes: PassStore,
): Promise<void> =>
  runPool(checks, workers, (check) => checkOne(check, run, passes));
