/**
 * The one file in the fixture repository that declares shapes. Every way a
 * field can be written down lives here, so a case that needs a new shape
 * adds it here and nowhere else.
 */
export const SHAPES = `
export interface Sum {
  total: number;
  noOneReadsThis: number;
  readOnlyFromOutside: number;
  takenOutByPattern: number;
}

export type Report = {
  headline: string;
  onlyTestsRead: string;
  nested: { deep: number };
  [key: string]: unknown;
};

class BaseClass {
  fromAClass = 1;
}

interface HiddenBase extends BaseClass {
  fromABaseNobodySees: number;
  shadowed: number;
}

import type { FarBase } from "./inner/index.ts";

export interface ExtendsFarBase extends FarBase {}

export interface Extends extends HiddenBase {
  ofItsOwn: number;
  shadowed: number;
}

export namespace Wrapped {
  export import Self = Wrapped;

  export interface Inner {
    onlyInsideNamespace: number;
  }
}

export interface Passed {
  kept: number;
  carriedBySpread: number;
}

interface NotExported {
  hidden: number;
}

interface IntersectedBase {
  fromAnIntersection: number;
}

export type Intersects = IntersectedBase & {
  ofItsOwnAgain: number;
};

interface ListExported {
  onlyInAList: number;
}

export type { ListExported };

interface NamedDirectly {
  reachedThroughAnAlias: number;
}

export type Renamed = NamedDirectly;

interface AnsweredOnce {
  answeredTwice: boolean;
}

export type AnsweredAgain = AnsweredOnce & { answeredTwice: boolean };

export class NamedItsParameter extends Error {
  constructor(
    public onlyTheConstructorNamesIt: string,
    public takenOutByADestructure: string,
    public takenOutByAnAssignment: string,
  ) {
    super(onlyTheConstructorNamesIt);
    let held = "";
    ({ takenOutByAnAssignment: held } = this);
    console.log(held);
  }
}

export class Carrier {
  onlyOnAClass = 1;
  private notForOutside = 2;

  constructor(
    public heldByTheConstructor: number,
    public readByThisInside: number,
    plainParameter: number,
  ) {
    this.onlyOnAClass = plainParameter + this.readByThisInside;
  }

  keep(): number {
    return this.notForOutside;
  }
}

export interface Borrowed {
  onlyItsTypeIsUsed: number;
  takenAwayByDelete?: number;
}

export class Answerer {
  answersAQuestion(): number {
    return 1;
  }

  get readsLikeAField(): number {
    return 2;
  }

  private keptInside(): number {
    return 3;
  }
}

const MADE_UP_LIST = [{ writtenInAList: 1 }] as const;

export type FromAList = (typeof MADE_UP_LIST)[number];

interface HasAnIdOfItsOwn {
  sharedNameDifferentField: number;
}

export type NestsTheSameName = HasAnIdOfItsOwn & {
  inside: { sharedNameDifferentField: string };
};

interface WentWell {
  sharedByTheNames: true;
  onlyWhenItWentWell: string;
}

interface WentBadly {
  sharedByTheNames: false;
  onlyWhenItWentBadly: string;
}

export type EitherNamed = WentWell | WentBadly;

export type OnlyWhenItFits<R> = R extends { checkedNotDeclared: number }
  ? { answeredByTheBranch: string }
  : never;

export type PickedByAFilter = Extract<EitherWay, { sharedByBothArms: true }>;

// The two filters below name a field nothing else in the repository declares,
// so a leak from the filter argument shows up as that name and nothing else.
export type NarrowedByAFilter = Extract<EitherWay, { onlyNamedByAFilter: true }>;
export type KeptByAFilter = Exclude<EitherWay, { alsoOnlyByAFilter: true }>;

export interface HoldsThingsInGenerics {
  inAnArray: Array<{ insideAnArray: number }>;
  inARecord: Record<string, { insideARecord: number }>;
}

export type InlineArmsShareIt =
  | { whichInlineArm: "first"; sharedByInlineArms: number }
  | {
      whichInlineArm: "second";
      sharedByInlineArms: number;
      onlyOnTheSecondInlineArm: number;
    };

export type EitherWay =
  | { sharedByBothArms: true; onlyOnTheFirst: string }
  | { sharedByBothArms: false; onlyOnTheSecond: string };

export type Renamings = {
  [K in keyof Borrowed as \`re\${Capitalize<K & string>}\`]: number;
};

export const hide = (n: NotExported): number => n.hidden;

export interface WrittenByARest {
  filledByAnArrayRest: number[];
  filledByAnObjectRest: object;
}

export class DeclaresATypeInAMethod {
  measure(): number {
    const inTheBody: { onlyInsideTheMethod: string } = {
      onlyInsideTheMethod: "x",
    };
    return inTheBody.onlyInsideTheMethod.length;
  }
}

export interface HoldsAClass {
  builtOnByAChild: new () => { madeByTheChild: number };
}

export interface HandsAnObjectOver {
  takesAnObject: (made: { insideAParameter: number }) => void;
  mapped<T extends { onlyInAConstraint: number }>(value: T): void;
}

export interface NamedByALiteral {
  "quoted-name": string;
  1: string;
  plainName: string;
}

export class TakesObjectsInMethods {
  send(value: { sameNameInBoth: string }): void {
    console.log(value);
  }

  post(value: { sameNameInBoth: number }): void {
    console.log(value);
  }
}

export interface DeletedInParens {
  takenAwayInParens?: number;
}

export class KeepsAHashPrivate {
  #kept: { onlyInsideAHashPrivate: string } = { onlyInsideAHashPrivate: "x" };

  show(): string {
    return this.#kept.onlyInsideAHashPrivate;
  }
}

export interface NameHoldsADot {
  "hasADotInIts.name": string;
  hasADotInIts: { name: string };
}

export class KeepsSecretsInside {
  private state: { onlyInsideAPrivate: string } = { onlyInsideAPrivate: "x" };

  read(): string {
    return this.state.onlyInsideAPrivate;
  }
}

interface NamesItsKeys {
  reachedOnlyByKeyof: string;
}

export type JustTheKeys = keyof NamesItsKeys;
export type JustTheInlineKeys = keyof { alsoOnlyByKeyof: string };
export type StillHandsOneOut = readonly { keptByReadonly: number }[];

export interface WrittenThroughParens {
  filledInsideParens: number;
}

interface FirstArm {
  whichArm: "first";
  writtenByBothArms: number;
}

interface SecondArm {
  whichArm: "second";
  writtenByBothArms: number;
  onlyOnTheSecondArm: number;
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

export const readItHere = (one: FromAShorthand): number =>
  one.readInItsOwnFile;
`;
