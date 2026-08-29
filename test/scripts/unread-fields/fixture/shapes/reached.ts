/**
 * The fourth part of the fixture's shape file: how a reader reaches a member
 * — call and construct signatures, parameters and destructured parameters,
 * bracket and paren and rest spellings, arms that both write a field, and
 * the shorthands.
 */
export const reached = `
export interface Callable {
  sharedByBothWays: string;
  (): { sharedByBothWays: string };
}

export interface Constructable {
  new (): { handedBackByNew: string };
}

// Under strict, undefined does not extend string. Without it, it does. So
// the arm this answers with says whether the scan read deno.json.
export type StrictnessDecides = undefined extends string
  ? { onlyWhenLoose: number }
  : { onlyWhenStrict: number };

export interface TakesTwoObjects {
  send(
    first: { sameNameInBothParameters: string },
    second: { sameNameInBothParameters: string },
  ): void;
}

export interface TakesADestructuredObject {
  handle({ passedIn }: { onlyInsideADestructured: string }): void;
}

export type OmittedAway = Omit<
  { keptByOmit: string; removedByOmit: string },
  "removedByOmit"
>;

export type PickedOut = Pick<
  { keptByPick: string; notPicked: string },
  "keptByPick"
>;

export interface WrappedInAngles {
  filledBehindAngles: number;
}

export interface HoldsClasses {
  builtWhenItRuns: new () => object;
  onlyDescribed: new () => object;
  onlyInsideADeclaredNamespace: new () => object;
}

export interface UsedAsAKey {
  namesAKeyInAPattern: string;
}

export interface SuppliedInBrackets {
  filledThroughBrackets: number;
}

export interface WrittenThroughParens {
  filledBehindABang: number;
  filledBehindACast: number;
  filledBehindSatisfies: number;
  filledInsideParens: number;
}

interface FirstArm {
  whichArm: "first";
  writtenByBothArms: number;
}

interface SecondArm {
  onlyOnTheSecondArm: number;
  whichArm: "second";
  writtenByBothArms: number;
}

export type BothArmsWriteIt = FirstArm | SecondArm;

const namedByALocal = 1;
const readsLikeAField = 2;
const readInItsOwnFile = 4;
const SHORTHANDS = [
  { namedByALocal, readInItsOwnFile, readsLikeAField, writtenInFull: 3 },
];

export type FromAShorthand = (typeof SHORTHANDS)[number];

export const useTheLocal = (): number => namedByALocal + 1;

export const readItHere = (one: FromAShorthand): number => one.readInItsOwnFile;
`;
