/**
 * How the runner hands a `--filter` value to the test child.
 *
 * The value cannot travel as deno's own `--filter`: that flag matches only
 * the names registered with `Deno.test`, so it would drop every suite before
 * the leaf filter inside the child sees it. The runner strips it from the
 * child's arguments and sets `TICKETS_TEST_FILTER` instead (see
 * test/test-utils/test-name-filter.ts for the child side).
 */

import { TEST_NAME_FILTER_ENV } from "#test-utils/test-name-filter.ts";
import { splitFlagValues } from "./flag-values.ts";
import { hasReporterArg } from "./tap-estimate.ts";

export { TEST_NAME_FILTER_ENV };

/** The `--filter` argument the runner received, if any. */
export interface ExtractedNameFilter {
  /** The arguments without their `--filter` occurrences. */
  args: string[];
  nameFilter?: string;
}

/** Pulls `--filter <value>` and `--filter=<value>` out of the arguments. Like
 * repeated flags elsewhere, the last occurrence wins. */
export const extractNameFilter = (
  args: readonly string[],
): ExtractedNameFilter => {
  // Normalize the equals form so one splitter sees both shapes in order.
  const separate = args.flatMap((arg) =>
    arg.startsWith("--filter=")
      ? ["--filter", arg.slice("--filter=".length)]
      : [arg],
  );
  const { rest, values } = splitFlagValues(separate, "--filter");
  if (values.includes(undefined)) {
    throw new Error("--filter needs a name or a /regular-expression/");
  }
  const nameFilter = (values as string[]).at(-1);
  return nameFilter === undefined ? { args: rest } : { args: rest, nameFilter };
};

/** Refuses the one argument combination the runner cannot honor: with a
 * custom reporter the pass-through shape has no parsed TAP, so a filtered
 * run that matched nothing would exit 0 and the no-match rule would not
 * hold. */
export const rejectReporterWithFilter = (
  args: readonly string[],
  nameFilter: string | undefined,
): void => {
  if (nameFilter !== undefined && hasReporterArg(args)) {
    throw new Error(
      "A filtered run cannot use a custom reporter: the runner cannot tell whether any test matched.",
    );
  }
};
