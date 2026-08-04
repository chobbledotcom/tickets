import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { statNumberOrNull } from "#scripts/not-found.ts";
import { withTempDir } from "#test-utils/files.ts";

const fileSizeOrNull = statNumberOrNull((info) => info.size);

describe("reading one number from a path's details", () => {
  test("answers the number for a file that is there", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "sized.txt");
      await Deno.writeTextFile(path, "12345");

      expect(await fileSizeOrNull(path)).toBe(5);
    });
  });

  test("answers null for a path with nothing at it", async () => {
    await withTempDir(async (dir) => {
      expect(await fileSizeOrNull(join(dir, "never-made"))).toBeNull();
    });
  });

  test("answers null when the filesystem does not keep the number", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "sized.txt");
      await Deno.writeTextFile(path, "12345");
      const unkept = statNumberOrNull(() => undefined);

      expect(await unkept(path)).toBeNull();
    });
  });

  test("surfaces a disk that cannot be asked at all", async () => {
    // Anything other than "nothing there" must not read as a missing number.
    using _stat = stub(Deno, "stat", (() =>
      Promise.reject(
        new Deno.errors.PermissionDenied("no access"),
      )) as typeof Deno.stat);

    await expect(fileSizeOrNull("/anywhere")).rejects.toThrow("no access");
  });
});
