import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import ts from "typescript";
import { fieldNameText } from "#scripts/unread-fields/fields/names.ts";
import {
  exportedFields,
  type OwnedField,
} from "#scripts/unread-fields/fields.ts";

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
    found = exportedFields(program.getTypeChecker(), source);
  });

  afterAll(async () => {
    await Deno.remove(root, { recursive: true });
  });

  const namesFor = (field: string): OwnedField["names"] | undefined =>
    found.find((line) => fieldNameText(line.names[0]) === field)?.names;

  test("names one place for a field written down once", () => {
    // The walk reads the declaration, and the checker hands the same one back
    // as a property of the alias. Two lookups of it answer alike.
    expect(namesFor("writtenDownOnce")).toHaveLength(1);
  });

  test("names both places for a field written down twice", () => {
    expect(namesFor("writtenDownTwice")).toHaveLength(2);
  });
});
