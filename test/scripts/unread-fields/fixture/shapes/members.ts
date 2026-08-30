/**
 * The third part of the fixture's shape file: how a class member is written
 * — methods, accessors, private and hash-private state, statics, quoted and
 * computed names, `keyof`, and a conditional the checker has already
 * answered.
 */
export const members = `
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

const WORKED_OUT_WHEN_IT_RUNS = "keptOut";

export interface NamedByALiteral {
  "quoted-name": string;
  1: string;
  plainName: string;
  ["quoted-in-brackets"]: string;
  [2]: string;
  [WORKED_OUT_WHEN_IT_RUNS]: string;
  [\`templated\`]: number;
}

export class HasAStaticAndAccessors {
  static madeOnTheClass = 1;
  #held = "";

  static make(): number {
    return 2;
  }

  get bothWays(): string {
    return this.#held;
  }

  set bothWays(next: string) {
    this.#held = next;
  }

  set writeOnly(next: string) {
    this.#held = next;
  }
}

// A setter is nobody's to read, but the input it takes is everybody's to
// supply, so the input walks under the setter's own name. The \`kept\` a
// caller supplies is not the \`kept\` the field holds, though both sit under
// \`value\`.
export class ServesSettingsThroughASetter {
  value: { kept: number };

  set settings(value: { kept: string }) {}
}

// A setter whose name is worked out when the program runs has no name to
// walk under, so the input takes the path of a plain parameter.
export class ServesThroughAWorkedOutName {
  kept: { besideAWorkedOutSetter: number };

  set [WORKED_OUT_WHEN_IT_RUNS](held: { throughTheWorkedOutName: number }) {}
}

// A getter's value reads as the property's own, so its return type walks on
// the property's path with no step between.
export class ServesItsValueThroughAGetter {
  get config(): { dead: number } {
    return { dead: 1 };
  }
}

// A property can hold a call the same way a method does, so its input takes
// the same \`()\` step the method's does. A function expression written out
// in full is one more spelling of the same call.
export class RunsItAsAProperty {
  run = (input: { arrowSpelling: number }): void => {};

  send = function (input: { writtenOutSpelling: number }): void {}
}

// A setter's name can be written in quotes rather than as a plain word, and
// the input still walks under it.
export class ServesItThroughAQuotedName {
  value: { besideAQuotedSetter: number };

  set ["settings"](held: { throughTheQuotedSetter: number }) {}
}

export type DroppedByAFilter = Extract<
  { whichArm: "kept"; keptByTheFilter: number } | {
    whichArm: "gone";
    droppedByTheFilter: number;
  },
  { whichArm: "kept" }
>;

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

export class BothSides {
  static heldByTheClass = 1;
  heldByAValue = 1;
}

export type ResolvedByItsCheck = true extends true
  ? { keptByTheAnswer: number }
  : { droppedByTheAnswer: number };

class OneShape {
  namedTwiceOverAllTheSame = 1;
}

export { OneShape, OneShape as AlsoOneShape };

export class RunsABlockWhenMade {
  static {
    const local: { hiddenInsideTheBlock: number } = { hiddenInsideTheBlock: 1 };
    void local;
  }

  reachedOnAValue = 1;
}
`;
