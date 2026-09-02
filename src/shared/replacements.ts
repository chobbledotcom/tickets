/**
 * One text change made of several replacements, applied in the order given.
 *
 * Kept in its own tiny, import-free module for the same reason as the HTML
 * escaper beside it: the browser bundles use it, and must not drag anything
 * else in with it.
 */

/** One pattern and what replaces every match of it. */
type Replacement = readonly [pattern: RegExp, replacement: string];

/**
 * Apply each replacement to the text, in order. Order matters when one
 * replacement can produce something a later one matches — an escaper puts its
 * escape character first for exactly that reason.
 */
export const replacing =
  (...replacements: readonly Replacement[]): ((text: string) => string) =>
  (text) =>
    replacements.reduce(
      (changed, [pattern, replacement]) =>
        changed.replace(pattern, replacement),
      text,
    );
