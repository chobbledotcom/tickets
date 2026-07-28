import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  readRunRecord,
  readRunRecords,
  writeRunRecord,
} from "#scripts/mutation/isolation-records.ts";
import {
  markRunning,
  newRunRecord,
  recordPath,
  runRoot,
  workRoot,
} from "#scripts/mutation/isolation-state.ts";
import {
  runIdNamed,
  withTempDir,
  writeMovedRunRecord,
} from "#test/scripts/mutation/isolation-helpers.ts";

describe("the record a mutation run keeps on disk", () => {
  test("keeps the last complete record readable while writing a new one", async () => {
    await withTempDir(async (root) => {
      const record = newRunRecord("swap", [], root);
      await writeRunRecord(record);

      // Stop the swap half way, which is where a reader could catch a partly
      // written record if the new text went straight into run.json.
      const rename = Deno.rename;
      const swapping = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      using _rename = stub(Deno, "rename", (async (
        from: string | URL,
        to: string | URL,
      ) => {
        swapping.resolve();
        await held.promise;
        await rename(from, to);
      }) as typeof Deno.rename);

      const writing = writeRunRecord(markRunning(record, 4242));
      // Read only once the swap is under way, or this would prove nothing.
      await swapping.promise;
      expect(await readRunRecord(recordPath("swap", root))).toMatchObject({
        status: "copying",
      });

      held.resolve();
      await writing;
      expect(await readRunRecord(recordPath("swap", root))).toMatchObject({
        pid: 4242,
        status: "running",
      });
    });
  });

  test("writes, reads, sorts, and ignores broken records", async () => {
    await withTempDir(async (root) => {
      expect(await readRunRecords(root)).toEqual([]);

      const older = newRunRecord(
        runIdNamed("older"),
        [],
        root,
        "2026-07-09T10:00:00.000Z",
      );
      const newer = newRunRecord(
        runIdNamed("newer"),
        [],
        root,
        "2026-07-09T11:00:00.000Z",
      );
      await writeRunRecord(older);
      await writeRunRecord(newer);
      // Named the way a real run is, so the half-written record inside it is
      // actually read and turned down — a fixture called "broken" would be
      // skipped on its name alone and never reach that decision.
      await Deno.mkdir(join(root, ".mutation-runs", runIdNamed("broken")), {
        recursive: true,
      });
      await Deno.writeTextFile(join(root, ".mutation-runs", "not-a-dir"), "");
      await Deno.writeTextFile(
        join(root, ".mutation-runs", runIdNamed("broken"), "run.json"),
        "{not-json",
      );

      const records = await readRunRecords(root);
      expect(records.map((record) => record.id)).toEqual([
        runIdNamed("newer"),
        runIdNamed("older"),
      ]);
      expect(await readRunRecord(join(root, "missing.json"))).toBeNull();
    });
  });

  test("leaves alone a folder this runner did not name", async () => {
    await withTempDir(async (root) => {
      // A perfectly readable record, in a folder no mutation run ever made —
      // somebody's copied backup of an old one. Reading it would put it on the
      // list, and `--clean all` would then delete somebody else's folder.
      const ours = newRunRecord(runIdNamed("ours"), [], root);
      await writeRunRecord(ours);
      const strayFolder = join(root, ".mutation-runs", "mutation-backups");
      await Deno.mkdir(strayFolder, { recursive: true });
      await Deno.writeTextFile(
        join(strayFolder, "run.json"),
        JSON.stringify({ ...ours, id: "mutation-backups" }),
      );

      expect((await readRunRecords(root)).map(({ id }) => id)).toEqual([
        runIdNamed("ours"),
      ]);
    });
  });

  test("ignores a record that is whole but missing its fields", async () => {
    await withTempDir(async (root) => {
      const folder = join(root, ".mutation-runs", runIdNamed("half"));
      await Deno.mkdir(folder, { recursive: true });
      // Valid JSON, but nothing a reader can use — sorting on its createdAt
      // would have thrown.
      await Deno.writeTextFile(join(folder, "run.json"), "{}");

      expect(await readRunRecord(join(folder, "run.json"))).toBeNull();
      expect(await readRunRecords(root)).toEqual([]);
    });
  });

  test("writes the record so a person can read it", async () => {
    await withTempDir(async (root) => {
      const record = newRunRecord(runIdNamed("readable"), ["src/a.ts"], root);
      await writeRunRecord(record);

      const written = await Deno.readTextFile(
        join(root, ".mutation-runs", runIdNamed("readable"), "run.json"),
      );

      // Indented and one line per field, so `cat run.json` is worth doing.
      expect(written.split("\n")[1]).toBe('  "args": [');
      expect(written.endsWith("}\n")).toBe(true);
    });
  });

  test("reads records from the current run directory", async () => {
    await withTempDir(async (root) => {
      const { id, record } = await writeMovedRunRecord(root);

      expect(await readRunRecords(root)).toEqual([
        {
          ...record,
          root: runRoot(id, root),
          workRoot: workRoot(id, root),
        },
      ]);
    });
  });

  test("surfaces unreadable run directories", async () => {
    await withTempDir(async (root) => {
      const fileRoot = join(root, "file-root");
      await Deno.writeTextFile(fileRoot, "");

      await expect(readRunRecords(fileRoot)).rejects.toThrow(
        Deno.errors.NotADirectory,
      );
    });
  });
});
