/** Helpers for tests that walk the admin surface declaration. */

/**
 * One path a pattern can serve. Numeric parameters take a plausible id and the
 * rest take a word, which is enough for the router to match the route and for
 * a guard to run. No record needs to exist: a test that uses this is asking
 * what the route does before it looks anything up.
 */
export const oneServedPath = (pattern: string): string =>
  pattern
    .replace(/:(\w+)/g, (_, name: string) =>
      name === "id" || name.endsWith("Id") ? "1" : "value",
    )
    .replace(/\/$/, "");
