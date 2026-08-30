/**
 * How a reader reaches a field, and what the scan must not take for one.
 *
 * Two call signatures, the two parts of a tuple, and two arms of a union can
 * each write a field of the same name down. One line covers them all, so it
 * carries every name or it misses the readers of the rest. A member reached
 * through brackets, a call or a `new` needs a step of its own, or it lands on
 * the shape's own path and merges with a field that is really there.
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

export type CalledForIt = { sharedWithTheCall: string } & (() => {
  sharedWithTheCall: string;
});

export type BuiltForIt = { sharedWithTheNew: string } & (new () => {
  sharedWithTheNew: string;
});

// Reads the property, and nothing reads what the call hands back.
export const readTheProperty = (held: CalledForIt): string =>
  held.sharedWithTheCall;

export interface CollidesWithItsCall {
  "()": { sharedWithTheLabel: number };
  (): { sharedWithTheLabel: number };
}

// Reads the field of the property that is literally called "()". Nothing
// reads what the call hands back, and the report labels both the same way.
export const readTheLiteralOne = (held: CollidesWithItsCall): number =>
  held["()"].sharedWithTheLabel;

// A call's input and its result can each reach a field of one name. The
// input stays under its parameter name and the result walks under
// \`result\`, so the line this reads cannot speak for both.
export interface CallsItBothWays {
  (input: { sameAtBothEnds: string }): { input: { sameAtBothEnds: string } };
}

export const readTheInputEnd = (called: CallsItBothWays): string => {
  const held: Parameters<CallsItBothWays>[0] = { sameAtBothEnds: "x" };
  return held.sameAtBothEnds;
};

// The answer an \`infer\` variable names is substituted, so neither arm as
// written is the type a caller holds: the checker hands back \`held\`, and the
// field of the false arm is one no value of this shape ever had.
export type ResolvesThroughInfer = Promise<{ held: number }> extends
  Promise<infer Held> ? Held : { gone: number };

export const readWhatItResolved = (x: ResolvesThroughInfer): number =>
  x.held;

// A property and a method can share one name, and each can hold an \`input\`
// of its own. The data's \`id\` sits under the property, and the method's sits
// under the call, so a read of either stays with its own.
export type HasAPropertyAndAMethodOfOneName = {
  run: { input: { id: number } };
} & {
  run(input: { id: string }): void;
};

// Reads the data the name holds, and never the input the method takes.
export const readTheDataTheNameHolds = (
  mixed: HasAPropertyAndAMethodOfOneName,
): number => mixed.run.input.id;

// \`ReturnType\` names a call whose answer is the shape, so nothing the call
// takes belongs to it. Only what the call hands back is a field.
export type WhatItGivesBack = ReturnType<
  (input: { givenToTheCall: number }) => { given: number }
>;

// Reads what the call hands back, and never the input it takes.
export const readWhatItGives = (out: WhatItGivesBack): number =>
  out.given;

// The brackets pick one key. No value of this holds the key it dropped, nor
// anything under it, so only the checker can say what is left.
export type PickedByAKey = {
  keptByTheKey: { keptInsideTheKey: number };
  droppedByTheKey: { droppedInsideTheKey: number };
}["keptByTheKey"];
`;
