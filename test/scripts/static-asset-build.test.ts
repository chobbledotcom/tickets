import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { withGeneratedOutputRollback } from "../../scripts/static-assets/output-rollback.ts";
import {
  type BuiltStaticBundle,
  createStaticAssetBuild,
  fileExists,
  type StaticAssetFiles,
  type StaticBundle,
} from "../../scripts/static-assets/session.ts";

interface FakeContext {
  disposeCalls: number;
  rebuildCalls: number;
  value: BuiltStaticBundle["context"];
}

const fakeContext = (rebuildFails = false): FakeContext => {
  const fake: FakeContext = {
    disposeCalls: 0,
    rebuildCalls: 0,
    value: {
      dispose: () => {
        fake.disposeCalls += 1;
        return Promise.resolve();
      },
      rebuild: () => {
        fake.rebuildCalls += 1;
        return rebuildFails
          ? Promise.reject(new Error("Build failed"))
          : Promise.resolve();
      },
    },
  };
  return fake;
};

const bundle = (label: string, outfile: string): StaticBundle => ({
  label,
  options: { outfile },
});

interface Fixture {
  admin: StaticBundle;
  adminContext: FakeContext;
  scanner: StaticBundle;
  scannerContext: FakeContext;
  session: ReturnType<typeof createStaticAssetBuild>;
  stopCalls: { count: number };
  writes: Array<{ contents: Uint8Array; file: string }>;
}

const fixture = (
  scannerFails = false,
  write?: StaticAssetFiles["write"],
): Fixture => {
  const admin = bundle("Admin", "static/admin.js");
  const scanner = bundle("Scanner", "static/scanner.js");
  const adminContext = fakeContext();
  const scannerContext = fakeContext(scannerFails);
  const stopCalls = { count: 0 };
  const writes: Array<{ contents: Uint8Array; file: string }> = [];
  const built: BuiltStaticBundle[] = [
    {
      baseline: new Uint8Array([1, 2]),
      bundle: admin,
      context: adminContext.value,
      inputs: ["client/admin.ts", "client/shared.ts"],
    },
    {
      baseline: new Uint8Array([3, 4]),
      bundle: scanner,
      context: scannerContext.value,
      inputs: ["client/scanner.ts", "client/shared.ts"],
    },
  ];
  return {
    admin,
    adminContext,
    scanner,
    scannerContext,
    session: createStaticAssetBuild(built, {
      resolve: (file) => `/project/${file}`,
      stop: () => {
        stopCalls.count += 1;
      },
      write: (file, contents) => {
        writes.push({ contents, file: `/project/${file}` });
        return write?.(file, contents) ?? Promise.resolve();
      },
    }),
    stopCalls,
    writes,
  };
};

describe("static asset build session", () => {
  test("finds every bundle affected by a source file", () => {
    const { admin, scanner, session } = fixture();

    expect(session.affected("client/shared.ts")).toEqual([admin, scanner]);
    expect(session.affected("client/admin.ts")).toEqual([admin]);
    expect(session.affected("client/other.ts")).toEqual([]);
  });

  test("rebuilds only the selected bundles", async () => {
    const { adminContext, scanner, scannerContext, session } = fixture();

    expect(await session.rebuild([scanner])).toBe(true);
    expect(adminContext.rebuildCalls).toBe(0);
    expect(scannerContext.rebuildCalls).toBe(1);
  });

  test("reports an incremental rebuild failure", async () => {
    const { scanner, scannerContext, session } = fixture(true);

    expect(await session.rebuild([scanner])).toBe(false);
    expect(scannerContext.rebuildCalls).toBe(1);
  });

  test("waits for every selected rebuild after one fails", async () => {
    const { admin, adminContext, scanner, scannerContext, session } = fixture();
    const scannerBuild = Promise.withResolvers<void>();
    adminContext.value.rebuild = () => {
      adminContext.rebuildCalls += 1;
      return Promise.reject(new Error("Admin build failed"));
    };
    scannerContext.value.rebuild = () => {
      scannerContext.rebuildCalls += 1;
      return scannerBuild.promise;
    };

    let settled = false;
    const result = (async () => {
      const value = await session.rebuild([admin, scanner]);
      settled = true;
      return value;
    })();
    await Promise.resolve();
    expect(settled).toBe(false);

    scannerBuild.resolve();
    expect(await result).toBe(false);
    expect(adminContext.rebuildCalls).toBe(1);
    expect(scannerContext.rebuildCalls).toBe(1);
  });

  test("rejects a bundle that was not built in the session", () => {
    const { session } = fixture();

    expect(() => session.restore([bundle("Other", "static/other.js")])).toThrow(
      "Static bundle was not built: Other",
    );
  });

  test("restores the exact baseline files for selected bundles", async () => {
    const { admin, session, writes } = fixture();

    await session.restore([admin]);

    expect(writes).toEqual([
      {
        contents: new Uint8Array([1, 2]),
        file: "/project/static/admin.js",
      },
    ]);
  });

  test("waits for every selected restore write after one fails", async () => {
    const scannerWrite = Promise.withResolvers<void>();
    const { admin, scanner, session, writes } = fixture(false, (file) =>
      file === "static/admin.js"
        ? Promise.reject(new Error("Admin write failed"))
        : scannerWrite.promise,
    );

    let settled = false;
    const result = (async () => {
      try {
        await session.restore([admin, scanner]);
      } finally {
        settled = true;
      }
    })();
    await Promise.resolve();
    expect(settled).toBe(false);

    scannerWrite.resolve();
    await expect(result).rejects.toThrow("Admin write failed");
    expect(writes.map(({ file }) => file)).toEqual([
      "/project/static/admin.js",
      "/project/static/scanner.js",
    ]);
  });

  test("disposes every bundle context", async () => {
    const { adminContext, scannerContext, session, stopCalls } = fixture();

    await session.dispose();

    expect(adminContext.disposeCalls).toBe(1);
    expect(scannerContext.disposeCalls).toBe(1);
    expect(stopCalls.count).toBe(1);
  });

  test("waits for every bundle disposal when one fails", async () => {
    const { adminContext, scannerContext, session, stopCalls } = fixture();
    adminContext.value.dispose = () => {
      adminContext.disposeCalls += 1;
      return Promise.reject(new Error("Admin dispose failed"));
    };

    await expect(session.dispose()).rejects.toThrow("Admin dispose failed");

    expect(adminContext.disposeCalls).toBe(1);
    expect(scannerContext.disposeCalls).toBe(1);
    expect(stopCalls.count).toBe(1);
  });
});

describe("static asset output rollback", () => {
  test("removes partial new output when a build fails", async () => {
    const dir = await Deno.makeTempDir();
    const existing = join(dir, "existing.js");
    const generated = join(dir, "generated.js");
    await Deno.writeTextFile(existing, "keep");
    try {
      await expect(
        withGeneratedOutputRollback(
          [existing, generated],
          async () => {
            await Deno.writeTextFile(existing, "partial");
            await Deno.writeTextFile(generated, "partial");
            throw new Error("Deliberate build failure");
          },
          () => [],
        ),
      ).rejects.toThrow("Deliberate build failure");
      expect(await Deno.readTextFile(existing)).toBe("keep");
      expect(await fileExists(generated)).toBe(false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("keeps generated output after a successful build", async () => {
    const dir = await Deno.makeTempDir();
    const generated = join(dir, "generated.js");
    try {
      expect(
        await withGeneratedOutputRollback(
          [generated],
          async () => {
            await Deno.writeTextFile(generated, "complete");
            return "built";
          },
          () => [],
        ),
      ).toBe("built");
      expect(await Deno.readTextFile(generated)).toBe("complete");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
