import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import ts from "typescript";
import { fieldNameText } from "#scripts/unread-fields/fields/names.ts";
import {
  exportedFields,
  type OwnedField,
} from "#scripts/unread-fields/fields.ts";
import { ownerPath, reaching } from "#scripts/unread-fields/identity.ts";
import { has } from "#test-utils/says.ts";

/**
 * One field gets one line, and the line names every place the field is
 * written down. The scan looks a name up once for each place, so a place
 * counted twice costs a whole lookup and a place dropped loses its readers.
 */
const SOURCE = `
export type Once = { writtenDownOnce: number };

export type Twice =
  | { writtenDownTwice: number }
  | { writtenDownTwice: number };

interface Detail {
  deep: number;
}

interface Inner {
  detail: Detail;
}

export type Public = Inner;

export interface ExportedDetail {
  ownDeep: number;
}

export interface UsesExportedDetail {
  detail: ExportedDetail;
}

export type ExportedBox<Value> = { value: Value };

export type UsesExportedBox = ExportedBox<{ privateInline: number }>;

export type PicksExportedBox = Pick<
  ExportedBox<{ pickedPrivateInline: number }>,
  "value"
>;

interface ExportedInputBase {
  sourceOwnedInput: number;
}

export type ExportedInput = ExportedInputBase;

export interface ExportedService {
  run(input: ExportedInput): void;
}

export type PicksExportedService = Pick<ExportedService, "run">;

interface Base {
  inherited: Detail;
}

export interface Child extends Base {}

type Box<Value> = { value: Value };

export type NestedBoxes = Box<Box<{ id: number }>>;

export type PicksPrivateBox = Pick<
  Box<{ pickedFromPrivateBox: number }>,
  "value"
>;

export type PicksPrivateArray = Pick<
  Box<Array<{ pickedFromArray: number }>>,
  "value"
>;

export type PicksPrivateMap = Pick<
  Box<Map<{ pickedFromKey: number }, { pickedFromValue: number }>>,
  "value"
>;

export type PicksPrivatePromise = Pick<
  Box<Promise<{ pickedFromPromise: number }>>,
  "value"
>;

export type PicksPrivateCall = Pick<
  Box<
    (input: { pickedFromInput: number }) => Promise<{
      pickedFromOutput: number;
    }>
  >,
  "value"
>;

export type PicksPrivateRecord = Pick<
  Box<Record<"fixed", { pickedFromFixed: number }>>,
  "value"
>;

interface SharedLeaf {
  deep: number;
}

interface SharedHidden {
  nested: SharedLeaf;
}

export type DirectBeforePick = SharedHidden;
export type PickAfterDirect = Pick<SharedHidden, "nested">;

interface ReversedLeaf {
  deep: number;
}

interface ReversedHidden {
  nested: ReversedLeaf;
}

export type PickBeforeDirect = Pick<ReversedHidden, "nested">;
export type DirectAfterPick = ReversedHidden;

export type ReachesPrivateTwoWays =
  & { direct: SharedHidden }
  & Pick<SharedHidden, "nested">;

interface Node {
  next?: Node;
  value: number;
}

export type Tree = Node;

interface Left {
  leftValue: number;
  right?: Right;
}

interface Right {
  left?: Left;
  rightValue: number;
}

export type Mutual = Left;

type Grow<Value> = {
  next: Grow<Value[]>;
  value: Value;
};

export type Growth = Grow<string>;

type Choice =
  | { kind: "kept"; nested: Detail }
  | { kind: "gone"; nested: { gone: number } };

export type Filtered = Extract<Choice, { kind: "kept" }>;

type MakeDetail = (input: { notOutput: number }) => { output: Detail };

export type MadeDetail = ReturnType<MakeDetail>;

type Definition = {
  kind: "fields";
  fields: readonly (
    | { stateField: "one" }
    | { configuredStateField: "two" }
  )[];
};

export type ChosenDefinition = Extract<
  Definition,
  {
    kind: "fields";
    fields: readonly (
      | { stateField: string }
      | { configuredStateField: string }
    )[];
  }
>;

export interface AsyncResult {
  validate(): Promise<{ error: string } | { value: number }>;
}

type WaitFor<Value> = Promise<Value>;

export type AliasedAsyncResult = WaitFor<{ done: number }>;
export type NestedAsyncResult = Promise<Promise<{ done: number }>>;
export type PromiseLikeResult = PromiseLike<{ done: number }>;

namespace Local {
  export type Promise<Value> = { local: Value };
  export type Held = Promise<{ id: number }>;
}

export type LocalPromiseResult = Local.Held;

export type ResultCollision = { result: { shared: string } } & Promise<{
  shared: number;
}>;
`;

describe("one line per field", () => {
  let root = "";
  let found: OwnedField[] = [];

  beforeAll(async () => {
    root = await Deno.makeTempDir({ prefix: "unread-fields-lines-" });
    const file = `${root}/shapes.ts`;
    await Deno.writeTextFile(file, SOURCE);
    const program = ts.createProgram([file], {
      strict: true,
      target: ts.ScriptTarget.ESNext,
    });
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`The program does not hold ${file}`);
    found = exportedFields(program.getTypeChecker())(source);
  });

  afterAll(async () => {
    await Deno.remove(root, { recursive: true });
  });

  const namesFor = (field: string): OwnedField["names"] | undefined =>
    found.find((line) => fieldNameText(line.names[0]) === field)?.names;

  const paths = (): string[] =>
    found.map((field) =>
      reaching(ownerPath(field.owner), fieldNameText(field.names[0])),
    );

  test("names one place for a field written down once", () => {
    // The walk reads the declaration, and the checker hands the same one back
    // as a property of the alias. Two lookups of it answer alike.
    expect(namesFor("writtenDownOnce")).toHaveLength(1);
  });

  test("names both places for a field written down twice", () => {
    expect(namesFor("writtenDownTwice")).toHaveLength(2);
  });

  test("walks through each named type a borrowed field holds", () => {
    has(paths(), "Public.detail.deep");
    has(paths(), "Child.inherited.deep");
  });

  test("keeps an exported target's fields under that target", () => {
    has(paths(), "ExportedDetail.ownDeep");
    has(paths(), "UsesExportedDetail.detail");
    assert(!paths().includes("UsesExportedDetail.detail.ownDeep"));
    has(paths(), "ExportedBox.value");
    assert(!paths().includes("UsesExportedBox.value"));
    has(paths(), "ExportedInput.sourceOwnedInput");
    assert(!paths().includes("PicksExportedService.run"));
    assert(
      !paths().includes(
        'PicksExportedService.run["()"].input.sourceOwnedInput',
      ),
    );
  });

  test("keeps a private type argument under its exported caller", () => {
    has(paths(), "UsesExportedBox.value.privateInline");
    has(paths(), "PicksExportedBox.value.pickedPrivateInline");
    assert(!paths().includes("PicksExportedBox.value"));
  });

  test("walks through each substituted generic value", () => {
    has(paths(), "NestedBoxes.value.value.id");
    has(paths(), "PicksPrivateBox.value");
    has(paths(), "PicksPrivateBox.value.pickedFromPrivateBox");
    has(paths(), 'PicksPrivateArray.value["[]"].pickedFromArray');
    has(paths(), 'PicksPrivateMap.value["keys()"].pickedFromKey');
    has(paths(), 'PicksPrivateMap.value["values()"].pickedFromValue');
    has(paths(), "PicksPrivatePromise.value.result.pickedFromPromise");
    has(paths(), 'PicksPrivateCall.value["()"].input.pickedFromInput');
    has(paths(), 'PicksPrivateCall.value["()"].result.pickedFromOutput');
    has(paths(), "PicksPrivateRecord.value.fixed");
    has(paths(), "PicksPrivateRecord.value.fixed.pickedFromFixed");
  });

  test("walks a private shape for each exported route", () => {
    has(paths(), "DirectBeforePick.nested.deep");
    has(paths(), "PickAfterDirect.nested.deep");
    has(paths(), "PickBeforeDirect.nested.deep");
    has(paths(), "DirectAfterPick.nested.deep");
  });

  test("walks a private shape at each path inside one export", () => {
    has(paths(), "ReachesPrivateTwoWays.direct.nested.deep");
    has(paths(), "ReachesPrivateTwoWays.nested.deep");
  });

  test("stops below a recursive field", () => {
    expect(paths().filter((path) => path.startsWith("Tree."))).toEqual([
      "Tree.next",
      "Tree.value",
    ]);
    expect(paths().filter((path) => path.startsWith("Mutual."))).toEqual([
      "Mutual.leftValue",
      "Mutual.right",
      "Mutual.right.left",
      "Mutual.right.rightValue",
    ]);
    expect(paths().filter((path) => path.startsWith("Growth."))).toEqual([
      "Growth.next",
      "Growth.value",
    ]);
  });

  test("walks the chosen output of a utility type", () => {
    has(paths(), "Filtered.nested.deep");
    assert(!paths().includes("Filtered.nested.gone"));
    has(paths(), "MadeDetail.output.deep");
    assert(!paths().includes("MadeDetail.input.notOutput"));
  });

  test("uses the source fields rather than a utility selector", () => {
    has(paths(), 'ChosenDefinition.fields["[]"].stateField');
    has(paths(), 'ChosenDefinition.fields["[]"].configuredStateField');
    expect(namesFor("stateField")).toHaveLength(1);
    expect(namesFor("configuredStateField")).toHaveLength(1);
  });

  test("walks through the result of a Promise", () => {
    has(paths(), "AsyncResult.validate.result.error");
    has(paths(), "AsyncResult.validate.result.value");
    has(paths(), "AliasedAsyncResult.result.done");
    has(paths(), "NestedAsyncResult.result.done");
    has(paths(), "PromiseLikeResult.result.done");
    has(paths(), "LocalPromiseResult.local.id");
    assert(!paths().includes("LocalPromiseResult.result.id"));
  });

  test("keeps a result step apart from a field of that name", () => {
    const owners = found
      .filter(
        (field) =>
          ownerPath(field.owner).startsWith("ResultCollision.result") &&
          fieldNameText(field.names[0]) === "shared",
      )
      .map((field) => field.owner);
    expect(owners).toEqual([
      [{ name: "ResultCollision" }, { name: "result" }],
      [{ name: "ResultCollision" }, { way: "result" }],
    ]);
  });
});
