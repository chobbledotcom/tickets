import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import {
  lookUpTrackedFiles,
  manifestStillMatches,
  readStaticAssetManifest,
  type StaticAssetManifest,
  trackFile,
  writeStaticAssetManifest,
} from "#scripts/static-assets/cache.ts";
import {
  deferStaticAssetBuild,
  staticAssetsAreUpToDate,
} from "#scripts/static-assets/prepare.ts";
import type {
  StaticAssetBuild,
  StaticBundle,
} from "#scripts/static-assets/session.ts";

const recorded = (path: string, size: number, mtime: number) => ({
  mtime,
  path,
  size,
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

describe("static asset cache", () => {
  describe("manifestStillMatches", () => {
    const input = recorded("/p/src/admin.ts", 10, 500);
    const output = recorded("/p/static/admin.js", 20, 600);
    const record = manifest([input, output], [output.path]);

    test("accepts a build whose every file is untouched", () => {
      expect(
        manifestStillMatches(record, [output.path], disk([input, output])),
      ).toBe(true);
    });

    test("rejects a build when a source file changed size", () => {
      expect(
        manifestStillMatches(
          record,
          [output.path],
          disk([recorded(input.path, 11, 500), output]),
        ),
      ).toBe(false);
    });

    test("rejects a build when a source file was written again", () => {
      expect(
        manifestStillMatches(
          record,
          [output.path],
          disk([recorded(input.path, 10, 501), output]),
        ),
      ).toBe(false);
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
    test("reports the size and modified time of a real file", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const path = join(dir, "asset.js");
        await Deno.writeTextFile(path, "hello");
        const info = await Deno.stat(path);

        expect(await trackFile(path)).toEqual({
          mtime: info.mtime?.getTime() ?? 0,
          path,
          size: 5,
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

        const current = await lookUpTrackedFiles(
          manifest([recorded(present, 3, 1), recorded(gone, 1, 1)], [present]),
        );

        expect(current.get(present)?.size).toBe(3);
        expect(current.get(gone)).toBe(null);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("reading and writing the record", () => {
    test("writes each file once, sorted, dropping any that vanished", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const record = join(dir, "record.json");
        const b = join(dir, "b.js");
        const a = join(dir, "a.js");
        await Deno.writeTextFile(a, "a");
        await Deno.writeTextFile(b, "bb");

        await writeStaticAssetManifest(
          [b, a, b, join(dir, "vanished.js")],
          [b],
          record,
        );
        const written = await readStaticAssetManifest(record);

        expect(written?.files.map((file) => file.path)).toEqual([a, b]);
        expect(written?.files.map((file) => file.size)).toEqual([1, 2]);
        expect(written?.outputs).toEqual([b]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    test("reports no record when the file is not there", async () => {
      const dir = await Deno.makeTempDir();
      try {
        expect(await readStaticAssetManifest(join(dir, "none.json"))).toBe(
          null,
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    test("ignores a record whose shape it does not recognise", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const record = join(dir, "record.json");
        await Deno.writeTextFile(
          record,
          JSON.stringify({ files: [{ path: "a.js" }], outputs: [] }),
        );
        expect(await readStaticAssetManifest(record)).toBe(null);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("staticAssetsAreUpToDate", () => {
    test("says no when this working copy has no record of a build", async () => {
      const dir = await Deno.makeTempDir();
      try {
        expect(await staticAssetsAreUpToDate(join(dir, "none.json"))).toBe(
          false,
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    test("says no when the record is for a different set of assets", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const record = join(dir, "record.json");
        const built = join(dir, "built.js");
        await Deno.writeTextFile(built, "x");
        await writeStaticAssetManifest([built], [built], record);

        expect(await staticAssetsAreUpToDate(record)).toBe(false);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    test("says yes right after the real build recorded itself", async () => {
      expect(await staticAssetsAreUpToDate()).toBe(true);
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
