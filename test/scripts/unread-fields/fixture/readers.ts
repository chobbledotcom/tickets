/**
 * The file in the fixture repository that reads the shapes. A case that
 * needs a new kind of read adds it here.
 */
export const READERS = `
import type { Reached } from "./inner";
import { report, sum } from "./produce.ts";
import {
  type AcceptsOptionsOfItsOwn,
  type Borrowed,
  type BothArmsWriteIt,
  BothSides,
  type Callable,
  type CarriesATuple,
  type CarriesTwoElementsOfOneName,
  type DeletedInParens,
  type ExtendsFarBase,
  type FromAShorthand,
  type HandsAnObjectOver,
  HasAStaticAndAccessors,
  type HoldsAClass,
  type HoldsBothEndsOfAMap,
  type HoldsClasses,
  type HoldsAListOfTheSameName,
  type HoldsThingsInGenerics,
  type HoldsTwoKeyDomains,
  type InlineArmsShareIt,
  type MapsItsValues,
  type NamedByALiteral,
  NamedItsParameter,
  type Passed,
  type FixedByWord,
  type MixedKeyRecord,
  type PassedThroughPartially,
  type PassedThroughReadonly,
  type PassedThroughRequired,
  type ReachesThroughAGeneric,
  type RunsItAsAProperty,
  type ServesSettingsThroughASetter,
  type ServesItsValueThroughAGetter,
  type ServesItThroughAQuotedName,
  type ServesThroughAWorkedOutName,
  type SuppliedInBrackets,
  type UsedAsAKey,
  type WrittenByARest,
  type WrappedInAngles,
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

// Reads the field the shape declares itself, and never the element's. The
// two share a name, so this is what proves they hold two lines.
export const readTheSharedNameNotTheElement = (
  h: HoldsAListOfTheSameName,
): string => h.sharedWithAList;

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

export const readTheClassSide = (): number => BothSides.heldByTheClass;

export const takeOutByAComputedKey = (
  k: UsedAsAKey,
  source: Record<string, number>,
): number => {
  let held = 0;
  ({ [k.namesAKeyInAPattern]: held } = source);
  return held;
};

export const readTheCallableProperty = (c: Callable): string =>
  c.sharedByBothWays;

export const fillBehindAngles = (w: WrappedInAngles): void => {
  (<number> w.filledBehindAngles) = 1;
};

declare const classes: HoldsClasses;

export class BuiltChild extends classes.builtWhenItRuns {}

// A declared class describes one that exists somewhere else, so nothing here
// ever looks the field up.
declare class DescribedChild extends classes.onlyDescribed {}
export type HoldsDescribed = DescribedChild;

// A namespace can be declared too, and the classes inside it are described
// rather than built. The declare sits on the namespace, not on the class.
declare namespace Described {
  class Nested extends classes.onlyInsideADeclaredNamespace {}
}
export type HoldsNested = Described.Nested;

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

export const readATemplatedName = (n: NamedByALiteral): number =>
  n.templated;

// Reads the field the class holds, and never the constructor input of the
// same spelling. One line for both would let this speak for the input.
export const readItsOwnOptions = (a: AcceptsOptionsOfItsOwn): string =>
  a.options.id;

// Reads the field the class holds, and never the input the setter takes.
export const readTheServedField = (s: ServesSettingsThroughASetter): number =>
  s.value.kept;

// Reads beside a setter whose name only exists when the program runs. The
// input through it walks like a plain parameter.
export const readBesideTheWorkedOutName = (
  s: ServesThroughAWorkedOutName,
): number => s.kept.besideAWorkedOutSetter;

// Reads the value a property's call hands back. A class that runs its
// property like a method supplies its input the same way a method does.
export const readAPropertyRun = (s: RunsItAsAProperty): number => {
  s.run({ arrowSpelling: 1 });
  s.send({ writtenOutSpelling: 2 });
  return 0;
};

// Reads the getter's value where the property itself is reached, and never
// a step the walk does not take.
export const readTheServedValue = (
  s: ServesItsValueThroughAGetter,
): number => s.config.dead;

// Reads the field beside a setter whose name is written in quotes.
export const readBesideTheQuotedSetter = (
  s: ServesItThroughAQuotedName,
): number => s.value.besideAQuotedSetter;

// Reads the first of two tuple elements of one name, and never the second.
export const readTheFirstElement = (
  pair: CarriesTwoElementsOfOneName,
): string => pair[0].id;

// Reads the field the outer shape holds itself, and never the one the
// generic carries for it.
export const readTheOuterField = (
  held: ReachesThroughAGeneric,
): string => held.shared;

// Reads a member a pass-through generic kept, at the outer shape's path.
export const readThePassedThrough = (
  held: PassedThroughPartially,
): number | undefined =>
  held.carriedNested?.deepInsideThePartial ?? held.carriedThroughUntouched;

// Reads the string-domain field, and never the symbol-domain one.
export const readTheStringDomain = (
  bag: HoldsTwoKeyDomains,
): string => bag["a-key"].sharedByTwoDomains;

// Reads the value side of the map, and never the key side.
export const readTheValueEnd = (m: HoldsBothEndsOfAMap): number => {
  for (const value of m.bothEnds.values()) return value.sharedAtBothEnds;
  return 0;
};

// Reads the field beside the tuple, and never the one the tuple holds.
export const readBesideTheTuple = (c: CarriesATuple): string =>
  c.sharedWithATuple;

// Reads the field beside the mapping, and never the mapped one.
export const readBesideTheMapping = (m: MapsItsValues): string =>
  m.sharedWithAMapped;

// Reads a member the Readonly pass-through kept, at the outer path.
export const readFrozen = (r: PassedThroughReadonly): number => r.heldNested.deepInsideTheFreeze;

// Reads the word the record named, which is a member like any other.
export const readTheFixedWord = (record: FixedByWord): number => record.fixed.id;

// Reads one member by its bracket, as the union of a domain and a word
// promises.
export const readByBracket = (record: MixedKeyRecord): number =>
  record[7].byBracket;


export const readRequired = (r: PassedThroughRequired): number =>
  r.maybeMissing?.readOnceFilled ?? 0;
`;
