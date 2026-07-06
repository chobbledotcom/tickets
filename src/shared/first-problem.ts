/**
 * Walk a list of things in order and stop at the first one that's a problem.
 *
 * Lots of our save-time checks share the same shape: look at each thing in a
 * set (each parent/child edge, each name in a batch), ask "is this one OK?",
 * and surface just the first thing that isn't. This is that shape, once.
 */

/**
 * Looks at one thing and says what's wrong with it: a user-facing message when
 * there's a problem, or null when it's fine. May do async work (a lookup) to
 * decide.
 */
export type Check<T> = (item: T) => string | null | Promise<string | null>;

/**
 * Run `check` over each item in order and return the first problem message it
 * finds, or null when every item is fine (including when there are none).
 */
export const firstProblem = async <T>(
  items: readonly T[],
  check: Check<T>,
): Promise<string | null> => {
  for (const item of items) {
    const problem = await check(item);
    if (problem) return problem;
  }
  return null;
};
