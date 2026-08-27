/**
 * Fields that share one place, and fields a word puts out of reach.
 *
 * Two call signatures, the two parts of a tuple, and two arms of a union can
 * each write a field of the same name down. One line covers them all, so it
 * carries every name or it misses the readers of the rest.
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

export type OneArmOrTheOther =
  | { readonly pickedArm: "first"; readonly declaredByTwoArms: number }
  | { readonly pickedArm: "second"; readonly declaredByTwoArms: number }
  | { readonly pickedArm: "third"; readonly onlyOnTheThirdArm: number }
  | { readonly pickedArm: "fourth" };

// Narrowed to the second arm, so the read points at the second declaration.
// Four arms is what makes this differ from InlineArmsShareIt: the compiler
// relates two near-identical arms and stops relating four.
export const readTheSecondArm = (rule: OneArmOrTheOther): number =>
  rule.pickedArm === "second" ? rule.declaredByTwoArms : 1;

export interface Indexed {
  sharedWithTheIndex: { sharedName: string };
  [key: string]: { sharedName: string };
}

// Reads the named field's own one. Nothing reads the field under the index,
// and the two share a name, so only the step through the brackets tells them
// apart.
export const readTheNamedOne = (held: Indexed): string =>
  held.sharedWithTheIndex.sharedName;
`;
