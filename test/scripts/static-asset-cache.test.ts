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
import {
  buildOrReuseStaticAssets,
  deferStaticAssetBuild,
  type StaticAssetBuild,
  type StaticBundle,
} from "#scripts/static-assets/session.ts";

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
        startedAt: async (source: string) =>
          ((await trackFile(source))?.mtime ?? 0) + 1,
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

  describe("buildOrReuseStaticAssets", () => {
    const session = (): StaticAssetBuild => ({
      affected: () => Promise.resolve([]),
      dispose: () => Promise.resolve(),
      rebuild: () => Promise.resolve(true),
      restore: () => Promise.resolve(),
    });

    test("builds straight away when the assets are out of date", async () => {
      const built = { count: 0 };
      const ready = session();

      const result = await buildOrReuseStaticAssets(false, () => {
        built.count += 1;
        return Promise.resolve(ready);
      });

      expect(built.count).toBe(1);
      expect(result).toBe(ready);
    });

    test("waits, and builds nothing, when the assets are current", async () => {
      const built = { count: 0 };

      const result = await buildOrReuseStaticAssets(true, () => {
        built.count += 1;
        return Promise.resolve(session());
      });

      expect(built.count).toBe(0);
      // Still a usable build — it just holds off until something asks.
      await result.dispose();
      expect(built.count).toBe(0);
      expect(await result.rebuild([])).toBe(true);
      expect(built.count).toBe(1);
    });
  });

  describe("deferStaticAssetBuild", () => {
    const bundle: StaticBundle = {
      label: "Admin",
      options: { outfile: "static/admin.js" },
    };

    const fakeBuild = () => {
      const calls = { affected: 0, build: 0, dispose: 0, rebuild: 0 };
      const build: StaticAssetBuild = {
        affected: () => {
          calls.affected += 1;
          return Promise.resolve([bundle]);
        },
        dispose: () => {
          calls.dispose += 1;
          return Promise.resolve();
        },
        rebuild: () => {
          calls.rebuild += 1;
          return Promise.resolve(true);
        },
        restore: () => Promise.resolve(),
      };
      return {
        calls,
        deferred: deferStaticAssetBuild(() => {
          calls.build += 1;
          return Promise.resolve(build);
        }),
      };
    };

    test("does not build when nobody asks for a rebuild", async () => {
      const { calls, deferred } = fakeBuild();

      await deferred.dispose();

      expect(calls.build).toBe(0);
      expect(calls.dispose).toBe(0);
    });

    test("builds once, on the first question about the bundles", async () => {
      const { calls, deferred } = fakeBuild();

      expect(await deferred.affected("src/ui/client/admin.ts")).toEqual([
        bundle,
      ]);
      expect(await deferred.rebuild([bundle])).toBe(true);

      expect(calls.build).toBe(1);
      expect(calls.affected).toBe(1);
      expect(calls.rebuild).toBe(1);
    });

    test("passes a restore through to the real build", async () => {
      const { calls, deferred } = fakeBuild();

      await deferred.restore([bundle]);

      expect(calls.build).toBe(1);
    });

    test("disposes the real build once it has happened", async () => {
      const { calls, deferred } = fakeBuild();

      await deferred.rebuild([bundle]);
      await deferred.dispose();

      expect(calls.dispose).toBe(1);
    });
  });
});
