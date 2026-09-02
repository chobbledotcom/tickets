import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
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

  test("walks a carried call's inputs and result by name and by place", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `${carried}
export type CarriesHelpers = Pick<CarriedByAPick, "helper" | "sender">;
`,
      ),
    );

    expect(paths).toContain('CarriesHelpers.helper["()"].input.givenToAHelper');
    expect(paths).toContain('CarriesHelpers.sender["()"]["0"].taken');
  });

  test("walks a carried construct signature's inputs and result", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `${carried}
export type CarriesFactories = Pick<CarriedByAPick, "factory">;
`,
      ),
    );

    expect(paths).toContain(
      'CarriesFactories.factory["new ()"].seed.givenToAFactory',
    );
    expect(paths).toContain(
      'CarriesFactories.factory["new ()"].result.madeByTheFactory',
    );
  });

  test("walks a carried container's element", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `${carried}
export type CarriesCollections = Pick<CarriedByAPick, "items" | "pair">;
`,
      ),
    );

    expect(paths).toContain('CarriesCollections.items["[]"].insideAPickedSet');
    expect(paths).toContain('CarriesCollections.pair["1"].insideAPickedTuple');
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

    expect(paths).toContain('CarriesLetter.letter["[]"].insideARecordValue');
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

    expect(paths).toContain('KeepsBoth.first["[]"].keptFirst');
    expect(paths).toContain('KeepsBoth.second["[]"].keptSecond');
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

    expect(paths).toContain("CarriesEither.either.leftish");
    expect(paths).toContain("CarriesEither.either.rightish");
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

    expect(paths).toContain("CarriesTyped.typed.insideTheValue");
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

    expect(paths).toContain('CarriesCall.run["()"].name.readByName');
    expect(paths).not.toContain('CarriesCall.run["()"].value');
  });
});
