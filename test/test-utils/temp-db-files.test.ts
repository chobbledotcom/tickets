// test-groups: run-alone — these tests exercise the isolate-global teardown
// (cleanupTrackedTestDbFiles wipes every tracked DB file and the shared temp
// dir), which would pull the golden DB out from under any file sharing the
// isolate.
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  cleanupTestDbPath,
  cleanupTrackedTestDbFiles,
  createTrackedTestDbFile,
} from "#test-utils/temp-db-files.ts";

const expectMissing = async (path: string): Promise<void> => {
  await expect(Deno.stat(path)).rejects.toThrow(Deno.errors.NotFound);
};

describe("test-utils > temp DB files", () => {
  afterEach(() => {
    cleanupTrackedTestDbFiles();
  });

  test("creates temp DB files in a shared disposable directory", async () => {
    const first = await createTrackedTestDbFile(".db");
    const second = await createTrackedTestDbFile(".db");

    expect(first).not.toBe(second);
    expect(first).toMatch(/tickets-test-db-/);
    expect(second.startsWith(first.slice(0, first.lastIndexOf("/") + 1))).toBe(
      true,
    );
  });

  test("removes DB files and SQLite sidecars", async () => {
    const path = await createTrackedTestDbFile(".db");
    const sidecars = [`${path}-journal`, `${path}-shm`, `${path}-wal`];
    for (const sidecar of sidecars) {
      Deno.writeTextFileSync(sidecar, "left");
    }

    cleanupTestDbPath(path);
    cleanupTestDbPath(path);

    await expectMissing(path);
    for (const sidecar of sidecars) {
      await expectMissing(sidecar);
    }
  });

  test("removes every tracked DB file and the temp directory", async () => {
    const first = await createTrackedTestDbFile(".db");
    const second = await createTrackedTestDbFile(".db");
    const tempDir = first.slice(0, first.lastIndexOf("/"));

    cleanupTrackedTestDbFiles();
    cleanupTrackedTestDbFiles();

    await expectMissing(first);
    await expectMissing(second);
    await expectMissing(tempDir);
  });
});
