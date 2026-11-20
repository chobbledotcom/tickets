import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { denoGuideAccess } from "#scripts/model-guides/access.ts";
import { tempDir } from "#test-utils/files.ts";

describe("denoGuideAccess", () => {
  test("reads a file and treats an absent directory as empty", async () => {
    expect(await denoGuideAccess.read("deno.json")).toContain(
      '"name": "tickets"',
    );
    expect(
      await denoGuideAccess.list("docs/model-guides-does-not-exist"),
    ).toEqual([]);
  });

  test("lists files, skips directories, and raises other read errors", async () => {
    using directory = tempDir();
    await Deno.writeTextFile(`${directory.path}/one.md`, "one\n");
    await Deno.mkdir(`${directory.path}/nested`);
    expect(await denoGuideAccess.list(directory.path)).toEqual(["one.md"]);
    await expect(denoGuideAccess.list("deno.json")).rejects.toThrow();
  });
});
