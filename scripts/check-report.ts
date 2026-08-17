/**
 * How every repo-wide check reports itself: a success line when clean,
 * otherwise each finding, a count, and where the rule is written down.
 */

/** Where a check writes its output. */
export interface CheckOutput {
  log: (line: string) => void;
  logError: (line: string) => void;
}

export interface CheckReport extends CheckOutput {
  /** Each finding, already formatted for a reader. */
  found: string[];
  /** Where the rule lives, e.g. `"Comments are short" in AGENTS.md`. */
  guide: string;
  /** What one finding is called, e.g. `comment`. */
  noun: string;
  /** What to say when nothing was found. */
  success: string;
}

/** The console, which is where both entry scripts send their output. */
export const consoleOutput: CheckOutput = {
  log: console.log,
  logError: console.error,
};

/** Report a check's findings and return its process exit code. */
export const reportCheck = ({
  found,
  guide,
  log,
  logError,
  noun,
  success,
}: CheckReport): number => {
  if (found.length === 0) {
    log(success);
    return 0;
  }
  for (const line of found) logError(line);
  logError(`\n${found.length} ${noun} issue(s) found. See ${guide}.`);
  return 1;
};
