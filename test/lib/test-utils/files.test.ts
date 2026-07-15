import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  pathExists,
  tempDir,
  withTempDir,
  withTempFile,
} from "#test-utils/files.ts";

describe("temporary paths", () => {
  test("removes a directory and everything inside it on disposal", async () => {
    const dir = tempDir({ prefix: "tickets-files-test-" });
    const path = dir.path;
    await Deno.writeTextFile(`${path}/nested.txt`, "test");

    dir.dispose();

    expect(await pathExists(path)).toBe(false);
    expect(() => dir.dispose()).not.toThrow();
  });

  test("removes a file after its callback", async () => {
    let path = "";
    await withTempFile(async (tempPath) => {
      path = tempPath;
      await Deno.writeTextFile(path, "test");
      expect(await pathExists(path)).toBe(true);
    });
    expect(await pathExists(path)).toBe(false);
  });

  test("removes a directory after its callback throws", async () => {
    let path = "";
    await expect(
      withTempDir((tempPath) => {
        path = tempPath;
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect(await pathExists(path)).toBe(false);
  });
});
