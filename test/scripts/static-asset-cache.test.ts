import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import {
  type CompletedStaticAssetBuild,
  lookUpTrackedFiles,
  manifestStillMatches,
  readStaticAssetManifest,
  type StaticAssetManifest,
  staticAssetsAreUpToDate,
  trackFile,
  writeStaticAssetManifest,
} from "#scripts/static-assets/cache.ts";

const recorded = (path: string, hash: string, mtime: number) => ({
  hash,
  mtime,
  path,
});

const manifest = (
  files: StaticAssetManifest["files"],
  outputs: string[],
): StaticAssetManifest => ({ files, outputs });

/** Look-up table standing in for the disk in the pure freshness check. */
const disk =
  (entries: StaticAssetManifest["files"]) =>
  (path: string): StaticAssetManifest["files"][number] | null =>
    entries.find((entry) => entry.path === path) ?? null;

// The tests write their files now, so a build that "began" a minute from now
// is one whose every input had already settled before it started reading.
const startedAt = Date.now() + 60_000;

/** A build that began before its inputs were last saved — the racy case. */
const startedBeforeInputsSettled = Date.now() - 60_000;

/**
 * A throwaway directory holding a record, one source file and one built asset,
 * cleaned up afterwards. Both files are written before the body runs, unless
 * `leaveAssetMissing` asks for the build-produced-nothing case. `write` records
 * a build over them, defaulting to the ordinary one: this source and this
 * asset, both settled before the build began.
 */
const withBuildDir = async (
  body: (files: {
    asset: string;
    dir: string;
    record: string;
    source: string;
    write: (over?: Partial<CompletedStaticAssetBuild>) => Promise<void>;
  }) => Promise<void>,
  leaveAssetMissing = false,
): Promise<void> => {
  const dir = await Deno.makeTempDir();
  const files = {
    asset: join(dir, "built.js"),
    dir,
    record: join(dir, "record.json"),
    source: join(dir, "source.ts"),
  };
  try {
    await Deno.writeTextFile(files.source, "a");
    if (!leaveAssetMissing) await Deno.writeTextFile(files.asset, "bb");
    await body({
      ...files,
      write: (over = {}) =>
        writeStaticAssetManifest(
          {
            inputs: [files.source],
            outputs: [files.asset],
            startedAt,
            ...over,
          },
          files.record,
        ),
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

describe("static asset cache", () => {
  describe("manifestStillMatches", () => {
    const input = recorded("/p/src/admin.ts", "aaa", 500);
    const output = recorded("/p/static/admin.js", "bbb", 600);
    const record = manifest([input, output], [output.path]);

    test("accepts a build whose every file is untouched", () => {
      expect(
        manifestStillMatches(record, [output.path], disk([input, output])),
      ).toBe(true);
    });

    test("rejects a build when a source file's contents changed", () => {
      expect(
        manifestStillMatches(
          record,
          [output.path],
          disk([recorded(input.path, "changed", 500), output]),
        ),
      ).toBe(false);
    });

    test("accepts a build when only a file's modified time moved", () => {
      // Re-saving the same bytes, or a checkout that rewrites timestamps, is
      // not a reason to rebuild — the assets would come out identical.
      expect(
        manifestStillMatches(
          record,
          [output.path],
          disk([recorded(input.path, input.hash, 999), output]),
        ),
      ).toBe(true);
    });

    test("rejects a build when an output file is gone", () => {
      expect(manifestStillMatches(record, [output.path], disk([input]))).toBe(
        false,
      );
    });

    test("rejects a build that produced a different set of assets", () => {
      expect(
        manifestStillMatches(
          record,
          [output.path, "/p/static/extra.js"],
          disk([input, output]),
        ),
      ).toBe(false);
    });

    test("rejects a build whose assets were renamed", () => {
      expect(
        manifestStillMatches(
          record,
          ["/p/static/other.js"],
          disk([input, output]),
        ),
      ).toBe(false);
    });
  });

  describe("trackFile", () => {
    test("reports the content hash and modified time of a real file", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const path = join(dir, "asset.js");
        await Deno.writeTextFile(path, "hello");
        const info = await Deno.stat(path);

        // SHA-256 of "hello".
        expect(await trackFile(path)).toEqual({
          hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          mtime: info.mtime?.getTime() ?? 0,
          path,
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    test("reports null for a file that is not there", async () => {
      const dir = await Deno.makeTempDir();
      try {
        expect(await trackFile(join(dir, "missing.js"))).toBe(null);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("lookUpTrackedFiles", () => {
    test("pairs every recorded path with how it looks now", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const present = join(dir, "present.js");
        const gone = join(dir, "gone.js");
        await Deno.writeTextFile(present, "abc");

        const look = await lookUpTrackedFiles(
          manifest(
            [recorded(present, "abc", 1), recorded(gone, "gone", 1)],
            [present],
          ),
        );

        expect(look(present)?.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(look(gone)).toBe(null);
        expect(look(join(dir, "never-recorded.js"))).toBe(null);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("reading and writing the record", () => {
    test("writes each file once, in a settled order", async () => {
      await withBuildDir(async ({ asset, record, source, write }) => {
        await write({ inputs: [source, source] });
        const written = await readStaticAssetManifest(record);

        expect(written?.files.map((file) => file.path)).toEqual(
          [asset, source].sort(),
        );
        expect(
          written?.files.every((file) => /^[0-9a-f]{64}$/.test(file.hash)),
        ).toBe(true);
        expect(written?.outputs).toEqual([asset]);
      });
    });

    test("reports no record when the file is not there", async () => {
      await withBuildDir(async ({ record }) => {
        expect(await readStaticAssetManifest(record)).toBe(null);
      });
    });

    test("refuses to record a build that left an asset missing", async () => {
      await withBuildDir(async ({ asset, record, write }) => {
        await expect(write()).rejects.toThrow(
          `did not leave every asset on disk: ${asset}`,
        );
        expect(await readStaticAssetManifest(record)).toBe(null);
      }, true);
    });

    test("keeps the previous record when a write is interrupted", async () => {
      await withBuildDir(async ({ asset, dir, record, source, write }) => {
        await Deno.writeTextFile(source, "x");
        await Deno.writeTextFile(asset, "built");
        await write();

        await expect(
          write({ outputs: [join(dir, "gone.js")] }),
        ).rejects.toThrow("did not leave every asset on disk");

        expect((await readStaticAssetManifest(record))?.outputs).toEqual([
          asset,
        ]);
      });
    });

    // One rule at the two timings that matter. A build only owns assets it
    // wrote itself; a source that moved after it started reading is one it
    // cannot vouch for, so nothing is recorded and the next run rebuilds.
    const timings = [
      {
        name: "records nothing when a source was saved while the build ran",
        recorded: false,
        startedAt: () => Promise.resolve(startedBeforeInputsSettled),
      },
      {
        name: "still records when only the assets were written during the build",
        recorded: true,
        // A whole second clear of the source's own save, because modified
        // times are compared at second granularity — see startOfSecond.
        startedAt: async (source: string) =>
          ((await trackFile(source))?.mtime ?? 0) + 1_000,
      },
    ];

    for (const timing of timings) {
      test(timing.name, async () => {
        await withBuildDir(async ({ asset, record, source, write }) => {
          await write({ startedAt: await timing.startedAt(source) });

          expect(
            (await readStaticAssetManifest(record))?.outputs ?? null,
          ).toEqual(timing.recorded ? [asset] : null);
        });
      });
    }

    test("records nothing when a source vanished under the build", async () => {
      await withBuildDir(async ({ dir, record, write }) => {
        // The build read it, then it was renamed or deleted before we looked.
        await write({ inputs: [join(dir, "deleted-since.ts")] });

        expect(await readStaticAssetManifest(record)).toBe(null);
      });
    });

    test("leaves no working file behind when two runs record at once", async () => {
      await withBuildDir(async ({ asset, dir, record, write }) => {
        await Promise.all([write(), write(), write()]);

        expect((await readStaticAssetManifest(record))?.outputs).toEqual([
          asset,
        ]);
        const left = [];
        for await (const entry of Deno.readDir(dir)) left.push(entry.name);
        expect(left.filter((name) => name.endsWith(".pending"))).toEqual([]);
      });
    });

    test("ignores a record left half-written", async () => {
      await withBuildDir(async ({ record }) => {
        await Deno.writeTextFile(record, '{"files":[{"path":"a.js"');
        expect(await readStaticAssetManifest(record)).toBe(null);
      });
    });

    test("ignores a record whose shape it does not recognise", async () => {
      await withBuildDir(async ({ record }) => {
        await Deno.writeTextFile(
          record,
          JSON.stringify({ files: [{ path: "a.js" }], outputs: [] }),
        );
        expect(await readStaticAssetManifest(record)).toBe(null);
      });
    });
  });

  describe("staticAssetsAreUpToDate", () => {
    test("says no when this working copy has no record of a build", async () => {
      await withBuildDir(async ({ record }) => {
        expect(await staticAssetsAreUpToDate(record)).toBe(false);
      });
    });

    test("says no when the record is for a different set of assets", async () => {
      await withBuildDir(async ({ asset, record, source, write }) => {
        await Deno.writeTextFile(source, "x");
        await Deno.writeTextFile(asset, "built");
        await write();

        expect(await staticAssetsAreUpToDate(record)).toBe(false);
      });
    });

    test("says yes right after the real build recorded itself", async () => {
      expect(await staticAssetsAreUpToDate()).toBe(true);
    });
  });
});
