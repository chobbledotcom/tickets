/**
 * Shaping text from optional parts.
 */

/** Join the parts that exist, in order, with the separator between them. An
 *  empty or absent part drops out, so an optional part either shows joined to
 *  the required one or leaves the required part alone. */
export const joinedNonEmpty =
  (separator: string) =>
  (parts: (string | undefined)[]): string =>
    parts.filter((part) => part !== undefined && part !== "").join(separator);
