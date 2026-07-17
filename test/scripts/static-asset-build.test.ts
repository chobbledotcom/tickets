import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type BuiltStaticBundle,
  createStaticAssetBuild,
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
  writes: Array<{ contents: Uint8Array; file: string }>;
}

const fixture = (scannerFails = false): Fixture => {
  const admin = bundle("Admin", "static/admin.js");
  const scanner = bundle("Scanner", "static/scanner.js");
  const adminContext = fakeContext();
  const scannerContext = fakeContext(scannerFails);
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
      write: (file, contents) => {
        writes.push({ contents, file: `/project/${file}` });
        return Promise.resolve();
      },
    }),
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

  test("disposes every bundle context", async () => {
    const { adminContext, scannerContext, session } = fixture();

    await session.dispose();

    expect(adminContext.disposeCalls).toBe(1);
    expect(scannerContext.disposeCalls).toBe(1);
  });

  test("waits for every bundle disposal when one fails", async () => {
    const { adminContext, scannerContext, session } = fixture();
    adminContext.value.dispose = () => {
      adminContext.disposeCalls += 1;
      return Promise.reject(new Error("Admin dispose failed"));
    };

    await expect(session.dispose()).rejects.toThrow("Admin dispose failed");

    expect(adminContext.disposeCalls).toBe(1);
    expect(scannerContext.disposeCalls).toBe(1);
  });
});
