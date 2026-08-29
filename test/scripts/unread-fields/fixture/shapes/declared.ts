/**
 * The first part of the fixture repository's shape file: how a shape is
 * written down at all — an interface, a type alias, a base it extends, a
 * class, an export list, and a type taken out of a list's typeof.
 */
export const declared = `
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
`;
