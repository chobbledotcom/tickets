/** Sample text the shape tests read, kept here so each focused suite can
 * reach the same pieces without copying them. */

/** A `${…}` group, written so the linter does not read this test's data as a
 * template somebody forgot to tag. */
export const interpolated = (code: string): string => `$\{${code}}`;

/** One template literal's source text, from its parts. */
export const template = (...parts: string[]): string => `\`${parts.join("")}\``;
