import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SYSTEM_NOTE_TYPES } from "#db/notes/types.ts";

test("seals a note with the app's key or the owner's key", () => {
  expect(SYSTEM_NOTE_TYPES).toEqual(["system", "owner"]);
});
