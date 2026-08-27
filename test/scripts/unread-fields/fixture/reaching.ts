/**
 * Fields that share one place, and fields a word puts out of reach.
 *
 * Two call signatures, and the two parts of a tuple, can each write a field of
 * the same name down. One line covers both, so it carries both names or it
 * misses the readers of the second.
 */
export const REACHING = `
export interface Formatter {
  (input: { sharedByOverloads: string }): string;
  (input: { sharedByOverloads: string }, extra: number): string;
}

export type Pair = [
  { sharedByTupleParts: string },
  { sharedByTupleParts: string },
];

export class Holder {
  constructor(private options: { suppliedByCallers: string }) {}
}

export class Keeps {
  private held: { keptInsideToo: string } = { keptInsideToo: "" };
}

export class Registry {
  static readonly namesAKeyOfADescribedClass: unique symbol = Symbol();
  static readonly namesAKeyThatRuns: unique symbol = Symbol();
  static readonly onlyNamesAKey: unique symbol = Symbol();
}

export interface UsesAKey {
  [Registry.onlyNamesAKey]: string;
}

declare class Described {
  [Registry.namesAKeyOfADescribedClass]: string;
}
export type HoldsADescribedKey = Described;

export class Runs {
  [Registry.namesAKeyThatRuns] = "x";
}

// Parameters answers with the last overload, so this reads the field the
// second signature writes down and leaves the first one unread.
export const readTheSecondOverload = (format: Formatter): string => {
  const held: Parameters<Formatter>[0] = { sharedByOverloads: "x" };
  return held.sharedByOverloads + format(held);
};

export const readTheSecondTuplePart = (pair: Pair): string =>
  pair[1].sharedByTupleParts;
`;
