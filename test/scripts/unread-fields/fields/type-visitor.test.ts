import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { has } from "#test-utils/says.ts";
import { fieldsOf, pathsOf } from "./fields-of-source.ts";

/**
 * How the type-side walker reaches the members a resolved generic hands it.
 * A `Pick` hides its own argument, so the node-side walk cannot serve these
 * fields: only the checker's answer carries them.
 */
describe("what the type walker reaches through", () => {
  const carried = `
interface CarriedByAPick {
  helper: (input: { givenToAHelper: number }) => string;
  sender: ({ taken }: { taken: number }) => void;
  factory: {
    new (seed: { givenToAFactory: number }): { madeByTheFactory: number };
  };
  items: Set<{ insideAPickedSet: number }>;
  pair: [number, { insideAPickedTuple: number }];
}
`;

  test("walks a carried call's inputs by name and by place", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `${carried}
export type CarriesHelpers = Pick<CarriedByAPick, "helper" | "sender">;
`,
      ),
    );

    has(paths, 'CarriesHelpers.helper["()"].input.givenToAHelper');
    has(paths, 'CarriesHelpers.sender["()"]["0"].taken');
  });

  test("walks a carried construct signature's inputs and result", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `${carried}
export type CarriesFactories = Pick<CarriedByAPick, "factory">;
`,
      ),
    );

    has(paths, 'CarriesFactories.factory["new ()"].seed.givenToAFactory');
    has(paths, 'CarriesFactories.factory["new ()"].result.madeByTheFactory');
  });

  test("walks a carried container's element", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `${carried}
export type CarriesCollections = Pick<CarriedByAPick, "items" | "pair">;
`,
      ),
    );

    has(paths, 'CarriesCollections.items["[]"].insideAPickedSet');
    has(paths, 'CarriesCollections.pair["1"].insideAPickedTuple');
  });

  test("walks a carried record's value without the written node", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
interface Lettered {
  letter: Record<string, { insideARecordValue: number }>;
}

export type CarriesLetter = Pick<Lettered, "letter">;
`,
      ),
    );

    has(paths, 'CarriesLetter.letter["[]"].insideARecordValue');
  });

  test("answers two carried records from one built index", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
interface Kept {
  first: Record<string, { keptFirst: number }>;
  second: Record<number, { keptSecond: number }>;
}

export type KeepsBoth = Pick<Kept, "first" | "second">;
`,
      ),
    );

    has(paths, 'KeepsBoth.first["[]"].keptFirst');
    has(paths, 'KeepsBoth.second["[]"].keptSecond');
  });

  test("stops at a type parameter without a substitution", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
interface Empty {}

export interface CarriesItsParameter<Value> extends Empty {
  boxed: Value;
}
`,
      ),
    );

    expect(paths).toEqual(["CarriesItsParameter.boxed"]);
  });

  test("writes each arm of a union it carries", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
interface Either {
  either: { leftish: number } | { rightish: string };
}

export type CarriesEither = Pick<Either, "either">;
`,
      ),
    );

    has(paths, "CarriesEither.either.leftish");
    has(paths, "CarriesEither.either.rightish");
  });

  test("records a carried value typed by a plain object's own shape", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
const typed = { insideTheValue: 1 };

interface HoldsTyped {
  typed: typeof typed;
}

export type CarriesTyped = Pick<HoldsTyped, "typed">;
`,
      ),
    );

    has(paths, "CarriesTyped.typed.insideTheValue");
  });

  test("stops at a signature parameter with no type yet", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
interface WithGenericCall {
  run: <Value>(
    value: Value,
    name: { readByName: number },
  ) => void;
}

export type CarriesCall = Pick<WithGenericCall, "run">;
`,
      ),
    );

    has(paths, 'CarriesCall.run["()"].name.readByName');
    assert(!paths.includes('CarriesCall.run["()"].value'));
  });
});
