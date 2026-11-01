import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { assertNoSymlink, collectTlaSources } from "#scripts/tla/files.ts";
import { tempDir } from "#test-utils/files.ts";

describe("maintained TLA source selection", () => {
  test("keeps nested models and helpers and removes overlapping selections", async () => {
    using dir = tempDir();
    await Deno.mkdir(join(dir.path, "nested"));
    for (const file of ["Model.tla", "nested/Helper.tla", "notes.md"]) {
      await Deno.writeTextFile(join(dir.path, file), "source");
    }
    expect(
      await collectTlaSources([dir.path, join(dir.path, "Model.tla")]),
    ).toEqual([
      resolve(dir.path, "Model.tla"),
      resolve(dir.path, "nested/Helper.tla"),
    ]);
  });

  test("refuses an empty selection instead of a false clean verdict", async () => {
    using dir = tempDir();
    await Deno.writeTextFile(join(dir.path, "notes.md"), "not a model");
    await expect(collectTlaSources([dir.path])).rejects.toThrow(
      /No TLA source/,
    );
  });

  test("refuses both a linked source and a linked parent", async () => {
    using dir = tempDir();
    await Deno.mkdir(join(dir.path, "actual"));
    await Deno.writeTextFile(join(dir.path, "actual/Model.tla"), "source");
    await Deno.symlink("actual/Model.tla", join(dir.path, "leaf.tla"));
    await Deno.symlink("actual", join(dir.path, "linked"));
    for (const path of [
      join(dir.path, "leaf.tla"),
      join(dir.path, "linked/Model.tla"),
    ]) {
      await expect(assertNoSymlink(path)).rejects.toThrow(/symlink/);
      await expect(collectTlaSources([path])).rejects.toThrow(/symlink/);
    }
  });
});
