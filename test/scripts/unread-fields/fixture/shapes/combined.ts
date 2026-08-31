/**
 * The second part of the fixture's shape file: how shapes combine — the same
 * nested name under two paths, unions and their arms, a conditional and its
 * answer, filters, and the containers that hold many members at once.
 */
export const combined = `
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

// A field and a list of the same name are two fields. One is h.sharedName
// and the other is h[0].sharedName, so one line for both would let a read of
// either speak for the one nothing reads.
export type HoldsAListOfTheSameName = { sharedWithAList: string } & Array<{
  sharedWithAList: number;
}>;

// A set and a map hold many the same way a list does. Each spelling needs
// its own field, or a name can leave the list of them unnoticed.
export interface HoldsManyOtherWays {
  inASet: Set<{ insideASet: number }>;
  inAMap: Map<string, { insideAMap: number }>;
  inAReadonlySet: ReadonlySet<{ insideAReadonlySet: number }>;
  inAReadonlyMap: ReadonlyMap<string, { insideAReadonlyMap: number }>;
}

// Every other way to write something reached one member at a time. All of
// them take the same step, so each spelling needs its own field here.
export interface WritesAListEveryWay {
  withBrackets: { insideBrackets: number }[];
  readonly withReadonly: readonly { insideReadonly: number }[];
  namedReadonly: ReadonlyArray<{ insideNamedReadonly: number }>;
}

// A map's key and its value are two calls apart, \`keys()\` and \`values()\`,
// so a field of one name on each side stays two fields, and the one only
// \`keys()\` reaches can leave the report as unread as it is.
export interface HoldsBothEndsOfAMap {
  bothEnds: Map<{ sharedAtBothEnds: string }, { sharedAtBothEnds: number }>;
}

// A tuple element is reached one index at a time, exactly as a list element
// is, so the field the tuple holds stays a step away from the field beside
// it.
export type CarriesATuple = { sharedWithATuple: string } & [{
  sharedWithATuple: number;
}];

// Each element of a tuple is reached by its own place, so two elements of
// one name stay two fields, exactly as two parameters do.
export type CarriesTwoElementsOfOneName = [{ id: string }, { id: number }];

// The value a mapped type holds is reached through a key, so it takes the
// same step an index signature does, and the field beside the mapping stays
// its own.
export type MapsItsValues = { sharedWithAMapped: string } & {
  [K in "one"]: { sharedWithAMapped: number };
};

// A generic puts its argument somewhere of its own, under a named member the
// way this one does, so the argument's fields never reach the outer shape's
// path. Before, both \`shared\` declarations shared one key.
type Carries<What> = { value: What };

export type ReachesThroughAGeneric = { shared: string } & Carries<
  { shared: number; keptInsideTheBox: number }
>;

// A generic that hands its argument's members on unchanged, as \`Partial\`
// does, keeps every member at the outer shape's path. \`Readonly\` and
// \`Required\` do the same.
export type PassedThroughPartially = Partial<{
  carriedThroughUntouched: number;
  keptCompletelyUnread: number;
  carriedNested: { deepInsideThePartial: number };
}>;

export type PassedThroughReadonly = Readonly<{
  frozenButRead: number;
  heldNested: { deepInsideTheFreeze: number };
}>;

export type PassedThroughRequired = Required<{
  maybeMissing?: { readOnceFilled: number };
}>;

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

// A \`Record\` keyed by words rather than a key domain names one member per
// word, reached as \`record.fixed\`, so its argument stays with the checker.
export type FixedByWord = Record<"fixed", { id: number }>;

// A union of a domain and a word is still a domain to the checker, so the
// member is reached by bracket, once per key.
export type MixedKeyRecord = Record<number | "five", { byBracket: number }>;
`;
