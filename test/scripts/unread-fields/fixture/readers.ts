/**
 * The file in the fixture repository that reads the shapes. A case that
 * needs a new kind of read adds it here.
 */
export const READERS = `
import type { Reached } from "./inner";
import { report, sum } from "./produce.ts";
import {
  type Borrowed,
  type BothArmsWriteIt,
  type DeletedInParens,
  type ExtendsFarBase,
  type FromAShorthand,
  type HandsAnObjectOver,
  HasAStaticAndAccessors,
  type HoldsAClass,
  type HoldsThingsInGenerics,
  type InlineArmsShareIt,
  type NamedByALiteral,
  NamedItsParameter,
  type Passed,
  type SuppliedInBrackets,
  type UsedAsAKey,
  type WrittenByARest,
  type WrittenThroughParens,
} from "./shapes.ts";

export type ItsType = Borrowed["onlyItsTypeIsUsed"];

export const drop = (b: Borrowed): void => {
  delete b.takenAwayByDelete;
};

export const shown = String(sum.total) + report.headline;

export const unpack = (held: NamedItsParameter): string => {
  const { takenOutByADestructure } = held;
  return takenOutByADestructure;
};

export const reach = (r: Reached): number => r.total;

export const far = (f: ExtendsFarBase): number => f.readFromFarAway;

export const forward = ({ kept, ...rest }: Passed): Passed => ({
  ...rest,
  kept: kept + 1,
});

export const takeDeepOut = (): number => {
  let deep = 0;
  ({ deep } = report.nested);
  return deep;
};

export const takePatternOut = (): number => {
  let takenOutByPattern = 0;
  ({ takenOutByPattern } = sum);
  return takenOutByPattern;
};

export const fillByRest = (w: WrittenByARest, from: number[]): void => {
  [...w.filledByAnArrayRest] = from;
};

export const fillByObjectRest = (w: WrittenByARest, from: object): void => {
  ({ ...w.filledByAnObjectRest } = from);
};

export const buildOn = (h: HoldsAClass): unknown =>
  class Child extends h.builtOnByAChild {};

export const throughTheSecondArm = (either: BothArmsWriteIt): number =>
  either.whichArm === "second"
    ? either.writtenByBothArms + either.onlyOnTheSecondArm
    : 0;

export const readInFull = (one: FromAShorthand): number => one.writtenInFull;

export const readInsideAnArray = (h: HoldsThingsInGenerics): number =>
  h.inAnArray[0].insideAnArray;

export const dropInParens = (d: DeletedInParens): void => {
  delete (d.takenAwayInParens);
};

export const roundTrip = (h: HasAStaticAndAccessors): string => {
  h.writeOnly = "x";
  h.bothWays = "y";
  return h.bothWays;
};

export const throughOneInlineArm = (u: InlineArmsShareIt): number =>
  u.whichInlineArm === "second"
    ? u.sharedByInlineArms + u.onlyOnTheSecondInlineArm
    : 0;

export const handOver = (h: HandsAnObjectOver): void => {
  h.takesAnObject({ insideAParameter: 1 });
};

export const takeOutByAComputedKey = (
  k: UsedAsAKey,
  source: Record<string, number>,
): number => {
  let held = 0;
  ({ [k.namesAKeyInAPattern]: held } = source);
  return held;
};

export const madeInBrackets: SuppliedInBrackets = {
  ["filledThroughBrackets"]: 1,
};

export const fillInsideParens = (w: WrittenThroughParens): void => {
  (w.filledInsideParens) = 1;
  w.filledBehindABang! = 1;
  (w.filledBehindACast as number) = 1;
  (w.filledBehindSatisfies satisfies number) = 1;
};

export const readAQuotedName = (n: NamedByALiteral): string =>
  n["quoted-name"];

export const readANameInBrackets = (n: NamedByALiteral): string =>
  n["quoted-in-brackets"];
`;
