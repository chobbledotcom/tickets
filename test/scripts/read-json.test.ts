import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { readJsonOrNull } from "#scripts/read-json.ts";
import { withTempDir } from "#test-utils/files.ts";

const NoteSchema = v.object({ note: v.string() });

/** Write `text` to a file in `folder` and read it back through the schema. */
const readBack = (folder: string, text: string) => {
  const path = join(folder, "note.json");
  Deno.writeTextFileSync(path, text);
  return readJsonOrNull(path, NoteSchema);
};

describe("reading a JSON file that may not be there", () => {
  test("gives back what the file holds", async () => {
    await withTempDir(async (folder) => {
      expect(await readBack(folder, '{ "note": "hello" }')).toEqual({
        note: "hello",
      });
    });
  });

  test("answers nothing for a file that is not there", async () => {
    await withTempDir(async (folder) => {
      expect(
        await readJsonOrNull(join(folder, "missing.json"), NoteSchema),
      ).toBe(null);
    });
  });

  test("answers nothing for text that was left half written", async () => {
    await withTempDir(async (folder) => {
      expect(await readBack(folder, '{ "note": "hel')).toBeNull();
    });
  });

  test("answers nothing for whole text of the wrong shape", async () => {
    await withTempDir(async (folder) => {
      expect(await readBack(folder, '{ "other": 1 }')).toBeNull();
    });
  });

  test("gives up when the file cannot be read at all", async () => {
    await withTempDir(async (folder) => {
      // A folder where a file was expected: not "nothing here", but a disk we
      // cannot make sense of.
      await expect(readJsonOrNull(folder, NoteSchema)).rejects.toThrow();
    });
  });
});
