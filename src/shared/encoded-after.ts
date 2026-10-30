/** One URI-encoded value placed after a fixed prefix, so a separator in the
 * value cannot read as part of the prefix. */
export const encodedAfter =
  (before: string) =>
  (value: string): string =>
    `${before}${encodeURIComponent(value)}`;
