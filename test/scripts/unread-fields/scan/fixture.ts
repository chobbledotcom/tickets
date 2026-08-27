import { afterAll, beforeAll } from "@std/testing/bdd";
import type { Finding } from "#scripts/unread-fields/findings.ts";
import { scanUnreadFields } from "#scripts/unread-fields/scan.ts";

/**
 * A whole repository, small enough to hold in your head, covering every way a
 * field can be reached. The scan runs over it once and each test reads one
 * verdict out of the answer.
 */
const FIXTURE: Record<string, string> = {
  "deno.json": JSON.stringify({
    imports: { "#jsx/": "./scripts/jsx/", "#shapes": "./src/shapes.ts" },
  }),

  // Outside the four scanned folders, so its read does not count.
  "outside.ts": `
import { sum } from "./src/produce.ts";

export const ignored = sum.readOnlyFromOutside;
`,

  // Reached by the prefix form of an alias, "#jsx/*". It lives under scripts/
  // so its own fields are not findings.
  "scripts/jsx/jsx-runtime.ts": `
export namespace JSX {
  export type Element = { tag: string };
}
`,

  "src/badge.tsx": `
import type { JSX } from "#jsx/jsx-runtime.ts";

export type BadgeProps = { label: string; supplied: string };

export const Badge = ({ label }: BadgeProps): JSX.Element => ({ tag: label });

export const badge = <Badge label="hi" supplied="nothing reads this" />;
`,

  // A barrel. Its re-exports belong to the file that declares them, so nothing
  // here is counted twice. The last name is not there to be re-exported, so
  // the compiler stands in a symbol that was never written down anywhere.
  "src/barrel.ts": `
export type { Report, Sum } from "#shapes";
export type { Gone } from "./nowhere.ts";
`,

  "src/consume.ts": `
import type { Reached } from "./inner";
import { report, sum } from "./produce.ts";
import {
  type Borrowed,
  type BothArmsWriteIt,
  type ExtendsFarBase,
  type FromAShorthand,
  type HoldsAClass,
  NamedItsParameter,
  type Passed,
  type WrittenByARest,
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
`,

  // Reached by a directory import. The compiler finds it only when the host
  // says truthfully that "src/inner.ts" is not a file.
  "src/inner/index.ts": `
export interface Reached {
  total: number;
}

export interface FarBase {
  paddingSoTheOffsetIsWrongInAnotherFile: number;
  readFromFarAway: number;
}
`,

  // No import and no export, so this file is a script and not a module. It
  // offers nothing for other files to reach.
  "src/plain.ts": `
const kept = 1;
console.log(kept);
`,

  // Every field written, none read: on its own this file proves nothing.
  "src/produce.ts": `
import type { Report, Sum } from "#shapes";

export const sum: Sum = {
  noOneReadsThis: 2,
  readOnlyFromOutside: 4,
  takenOutByPattern: 3,
  total: 1,
};
export const report: Report = {
  headline: "hi",
  onlyTestsRead: "x",
  nested: { deep: 3 },
};
`,

  "src/shapes.ts": `
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
  ) {
    super(onlyTheConstructorNamesIt);
  }
}

export class Carrier {
  onlyOnAClass = 1;
  private notForOutside = 2;

  constructor(
    public heldByTheConstructor: number,
    plainParameter: number,
  ) {
    this.onlyOnAClass = plainParameter;
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
const SHORTHANDS = [{ namedByALocal, readsLikeAField, writtenInFull: 3 }];

export type FromAShorthand = (typeof SHORTHANDS)[number];

export const useTheLocal = (): number => namedByALocal + 1;
`,

  "test/report.test.ts": `
import { report } from "../src/produce.ts";

export const seen = report.onlyTestsRead;
`,
};

const buildFixture = async (root: string): Promise<void> => {
  for (const folder of ["cli", "scripts/jsx", "src/inner", "test"]) {
    await Deno.mkdir(`${root}/${folder}`, { recursive: true });
  }
  for (const [path, text] of Object.entries(FIXTURE)) {
    await Deno.writeTextFile(`${root}/${path}`, text);
  }
};

/** Build the repository, scan it once, and hand the suite its answer. The
 * hooks are registered where this is called, so each suite owns its own copy
 * and no hook reaches a file that did not ask for one. */
export const scannedFixture = (): {
  readonly all: Finding[];
  verdictOf: (owner: string, field: string) => string | undefined;
} => {
  let root = "";
  let findings: Finding[] = [];

  beforeAll(async () => {
    root = await Deno.makeTempDir({ prefix: "unread-fields-" });
    await buildFixture(root);
    findings = await scanUnreadFields(root);
  });

  afterAll(async () => {
    await Deno.remove(root, { recursive: true });
  });

  return {
    get all(): Finding[] {
      return findings;
    },
    verdictOf: (owner, field) =>
      findings.find((f) => f.owner === owner && f.field === field)?.verdict,
  };
};
