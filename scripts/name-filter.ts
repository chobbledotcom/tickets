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
