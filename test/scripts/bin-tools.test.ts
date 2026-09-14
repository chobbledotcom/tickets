import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ensureInstalled, isFileAt, withTempDir } from "#scripts/bin-tools.ts";
import { removeTree } from "#scripts/process.ts";

const tempBase = async (): Promise<string> => {
  const dir = await Deno.makeTempDir({ prefix: "bin-tools-" });
  return dir;
};

describe("isFileAt", () => {
  test("is true for a regular file", async () => {
    const dir = await tempBase();
    try {
      const path = join(dir, "file");
      await Deno.writeTextFile(path, "x");
      expect(await isFileAt(path)).toBe(true);
    } finally {
      await removeTree(dir);
    }
  });

  test("is false for a missing path", async () => {
    const dir = await tempBase();
    try {
      expect(await isFileAt(join(dir, "missing"))).toBe(false);
    } finally {
      await removeTree(dir);
    }
  });

  test("is false for a directory", async () => {
    const dir = await tempBase();
    try {
      expect(await isFileAt(dir)).toBe(false);
    } finally {
      await removeTree(dir);
    }
  });
});

describe("withTempDir", () => {
  test("runs the body with a created folder and removes it afterwards", async () => {
    const parent = await tempBase();
    try {
      let seen: string | undefined;
      const result = await withTempDir(parent, "work-", async (tempDir) => {
        seen = tempDir;
        await Deno.writeTextFile(join(tempDir, "in.txt"), "x");
        expect((await Deno.stat(tempDir)).isDirectory).toBe(true);
        return 42;
      });
      expect(result).toBe(42);
      expect(seen?.startsWith(join(parent, "work-"))).toBe(true);
      await expect(Deno.stat(seen!)).rejects.toThrow();
    } finally {
      await removeTree(parent);
    }
  });

  test("removes the folder even when the body throws", async () => {
    const parent = await tempBase();
    try {
      let seen: string | undefined;
      await expect(
        withTempDir(parent, "work-", async (tempDir) => {
          seen = tempDir;
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await expect(Deno.stat(seen!)).rejects.toThrow();
    } finally {
      await removeTree(parent);
    }
  });
});

describe("ensureInstalled", () => {
  test("installs when the binary is missing, inside the lock", async () => {
    const dir = await tempBase();
    try {
      const binaryPath = join(dir, "tool");
      let lockRuns = 0;
      let installs = 0;
      await ensureInstalled({
        binaryPath,
        install: async () => {
          installs += 1;
          await Deno.writeTextFile(binaryPath, "x");
        },
        lock: async (body) => {
          lockRuns += 1;
          return body();
        },
      });
      expect(installs).toBe(1);
      expect(lockRuns).toBe(1);
      expect(await Deno.readTextFile(binaryPath)).toBe("x");
    } finally {
      await removeTree(dir);
    }
  });

  test("skips the install when the binary already exists", async () => {
    const dir = await tempBase();
    try {
      const binaryPath = join(dir, "tool");
      await Deno.writeTextFile(binaryPath, "present");
      const lock = async <Result>(
        _body: () => Promise<Result>,
      ): Promise<Result> => {
        throw new Error("lock must not run");
      };
      await expect(
        ensureInstalled({
          binaryPath,
          install: () => {
            throw new Error("install must not run");
          },
          lock,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await removeTree(dir);
    }
  });

  test("re-checks inside the lock, so a competing installer is skipped", async () => {
    const dir = await tempBase();
    try {
      const binaryPath = join(dir, "tool");
      let installs = 0;
      await ensureInstalled({
        binaryPath,
        install: async () => {
          installs += 1;
        },
        lock: async (body) => {
          // A competing process lands the binary before our install runs.
          await Deno.writeTextFile(binaryPath, "x");
          return body();
        },
      });
      expect(installs).toBe(0);
    } finally {
      await removeTree(dir);
    }
  });

  test("trusts the usefulness test over the file on disk", async () => {
    const dir = await tempBase();
    try {
      // Nothing lands on disk; the checksum test the caller passes decides.
      const binaryPath = join(dir, "never-created");
      await expect(
        ensureInstalled({
          binaryPath,
          install: () => {
            throw new Error("install must not run");
          },
          isUsable: async () => true,
          lock: async (body) => body(),
        }),
      ).resolves.toBeUndefined();
    } finally {
      await removeTree(dir);
    }
  });
});
