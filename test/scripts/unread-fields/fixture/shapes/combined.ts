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
`;
