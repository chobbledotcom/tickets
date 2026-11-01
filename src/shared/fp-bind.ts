/** Give `fn` its first argument later: `bindFirst(fn)(a)(...rest)` calls
 * `fn(a, ...rest)`. Lets a plain multi-argument function keep currying's
 * partial application without writing a returned closure at the call site. */
export const bindFirst =
  <A, Rest extends unknown[], R>(
    fn: (first: A, ...rest: Rest) => R,
  ): ((first: A) => (...rest: Rest) => R) =>
  (first) =>
  (...rest) =>
    fn(first, ...rest);

/** A function that always returns the same value, whatever it is called with. */
export const constant =
  <T>(value: T) =>
  (_unused: unknown): T =>
    value;
