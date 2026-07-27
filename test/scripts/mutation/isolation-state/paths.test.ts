import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  copyMutationSnapshot,
  rewriteMutationArgs,
  shouldCopySnapshotPath,
} from "#scripts/mutation/isolation-state.ts";
import { withTempDir } from "#test/scripts/mutation/isolation-helpers.ts";
import { pathExists } from "#test-utils/files.ts";

describe("mutation isolation paths", () => {
  test("copies into a snapshot folder that is already there", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "source");
      const snapshot = join(dir, "snapshot");
      await Deno.mkdir(source, { recursive: true });
      await Deno.writeTextFile(join(source, "kept.ts"), "export {};\n");
      // The run's lock makes this folder before the copy starts.
      await Deno.mkdir(snapshot, { recursive: true });

      await copyMutationSnapshot(source, snapshot);

      expect(await pathExists(join(snapshot, "kept.ts"))).toBe(true);
    });
  });

  test("copies source-like files and skips git, reports, secrets, dbs, and generated assets", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "source");
      const snapshot = join(dir, "snapshot");
      await Deno.mkdir(join(source, "src", "ui", "static"), {
        recursive: true,
      });
      await Deno.mkdir(join(source, ".bin"), { recursive: true });
      await Deno.mkdir(join(source, ".git"), { recursive: true });
      await Deno.mkdir(join(source, "coverage"), { recursive: true });
      await Deno.writeTextFile(join(source, "src", "kept.ts"), "export {};\n");
      await Deno.writeTextFile(join(source, ".bin", "stripe-mock"), "mock");
      await Deno.writeTextFile(join(source, ".git", "config"), "git");
      await Deno.writeTextFile(join(source, "coverage", "lcov.info"), "cov");
      await Deno.writeTextFile(join(source, ".env"), "secret");
      await Deno.writeTextFile(join(source, "tickets.db"), "db");
      await Deno.writeTextFile(
        join(source, "src", "ui", "static", "app.js"),
        "js",
      );
      await Deno.writeTextFile(
        join(source, "src", "ui", "static", "style.css"),
        "css",
      );

      await copyMutationSnapshot(source, snapshot);

      expect(await Deno.readTextFile(join(snapshot, "src", "kept.ts"))).toBe(
        "export {};\n",
      );
      expect(
        await Deno.readTextFile(join(snapshot, ".bin", "stripe-mock")),
      ).toBe("mock");
      expect(await pathExists(join(snapshot, ".git", "config"))).toBe(false);
      expect(await pathExists(join(snapshot, "coverage", "lcov.info"))).toBe(
        false,
      );
      expect(await pathExists(join(snapshot, ".env"))).toBe(false);
      expect(await pathExists(join(snapshot, "tickets.db"))).toBe(false);
      expect(
        await pathExists(join(snapshot, "src", "ui", "static", "app.js")),
      ).toBe(false);
      expect(
        await pathExists(join(snapshot, "src", "ui", "static", "style.css")),
      ).toBe(false);
    });
  });

  test("states which paths belong in a snapshot", () => {
    expect(shouldCopySnapshotPath("")).toBe(true);
    expect(shouldCopySnapshotPath("src/shared/dates.ts")).toBe(true);
    expect(shouldCopySnapshotPath(".mutation-runs/run/work")).toBe(false);
    expect(shouldCopySnapshotPath(".jscpd-report/index.html")).toBe(false);
    expect(shouldCopySnapshotPath("coverage-test/lcov.info")).toBe(false);
    expect(shouldCopySnapshotPath("local.db-wal")).toBe(false);
    expect(shouldCopySnapshotPath("src/ui/static/order.js")).toBe(false);
    expect(shouldCopySnapshotPath(".static-assets-cache.json")).toBe(false);
    expect(shouldCopySnapshotPath(".static-assets-build.lock")).toBe(false);
  });

  test("rewrites only absolute project paths", () => {
    const root = "/repo/tickets";
    const snapshot = "/repo/tickets/.mutation-runs/run/work";

    expect(
      rewriteMutationArgs(root, snapshot, [
        "--source",
        "/repo/tickets",
        "/repo/tickets/src/a.ts",
        "test/a.test.ts",
        "--harness",
        "/tmp/outside.ts",
      ]),
    ).toEqual([
      "--source",
      "/repo/tickets/.mutation-runs/run/work",
      "/repo/tickets/.mutation-runs/run/work/src/a.ts",
      "test/a.test.ts",
      "--harness",
      "/tmp/outside.ts",
    ]);
    expect(rewriteMutationArgs("/", "/snapshot", ["/repo/tickets"])).toEqual([
      "/snapshot/repo/tickets",
    ]);
  });
});
