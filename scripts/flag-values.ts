/**
 * Splitting one repeated flag and its values out of a command line.
 */

/** Split argv into the given flag's values and everything else. A flag at the
 * end with nothing after it yields undefined, for the caller to refuse with
 * its own words. */
export const splitFlagValues = (
  args: string[],
  flag: string,
): { rest: string[]; values: (string | undefined)[] } => {
  const rest: string[] = [];
  const values: (string | undefined)[] = [];
  const remaining = [...args];
  while (remaining.length > 0) {
    const value = remaining.shift()!;
    if (value === flag) values.push(remaining.shift());
    else rest.push(value);
  }
  return { rest, values };
};
