import ts from "typescript";
import { fieldNameText } from "#scripts/unread-fields/fields/names.ts";
import {
  exportedFields,
  type OwnedField,
} from "#scripts/unread-fields/fields.ts";
import { answered } from "#scripts/unread-fields/host.ts";
import { ownerPath, reaching } from "#scripts/unread-fields/identity.ts";

/**
 * Compile a small repository — `shapes.ts` plus any files passed in `more` —
 * and hand back the fields the scanner sees in `shapes.ts`. Write-only: the
 * caller asserts on the paths and names in the answer.
 */
export const fieldsOf = async (
  source: string,
  more: Record<string, string> = {},
): Promise<OwnedField[]> => {
  const root = await Deno.makeTempDir({ prefix: "unread-fields-fields-" });
  try {
    const files = { ...more, "shapes.ts": source };
    for (const [file, text] of Object.entries(files)) {
      await Deno.writeTextFile(`${root}/${file}`, text);
    }
    const program = ts.createProgram(
      Object.keys(files).map((file) => `${root}/${file}`),
      { strict: true, target: ts.ScriptTarget.ESNext },
    );
    const scanned = answered(
      program.getSourceFile(`${root}/shapes.ts`),
      "the scanned file",
    );
    return exportedFields(program.getTypeChecker())(scanned);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

/** The readable reach of the first name of every field the scan found. */
export const pathsOf = (fields: readonly OwnedField[]): string[] =>
  fields.map((field) =>
    reaching(ownerPath(field.owner), fieldNameText(field.names[0])),
  );
