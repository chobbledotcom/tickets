/** Joining display names the way a sentence reads. */

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

/** Join display names into one phrase ("A, B and C"). */
export const nameList = (names: string[]): string => listFormat.format(names);
