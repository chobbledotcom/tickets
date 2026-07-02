import { expect } from "@std/expect";
import { afterAll, describe, test } from "@std/testing/bdd";
import { getStorageBackend, isStorageEnabled } from "#shared/storage.ts";
import {
  describeWithEnv,
  getTestStoragePath,
  withStorageDisabled,
} from "#test-utils";

const dirExists = (path: string): boolean => {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
};

describe("describeWithEnv storage option", () => {
  describeWithEnv("cdn backend", { storage: "cdn" }, () => {
    test("resolves the Bunny CDN backend for every test", () => {
      expect(getStorageBackend()).toBe("bunny");
      expect(isStorageEnabled()).toBe(true);
      // No temp dir is allocated for the CDN backend.
      expect(getTestStoragePath()).toBeNull();
    });
  });

  describe("local backend", () => {
    // Each test records the live dir it observed; the afterAll then proves that
    // dir was torn down. This holds no matter which subset of tests runs (e.g.
    // under `test:files --filter`), so the cases stay independent.
    let observedDir: string | null = null;

    describeWithEnv("local storage lifecycle", { storage: "local" }, () => {
      test("allocates a real temp dir and selects the local backend", () => {
        const dir = getTestStoragePath();
        expect(dir).not.toBeNull();
        expect(dirExists(dir!)).toBe(true);
        expect(getStorageBackend()).toBe("local");
        expect(isStorageEnabled()).toBe(true);
        observedDir = dir;
      });

      test("a per-test withStorageDisabled scope overrides the suite default", () => {
        // This test has its own live dir…
        const dir = getTestStoragePath();
        expect(dir).not.toBeNull();
        expect(dirExists(dir!)).toBe(true);
        expect(getStorageBackend()).toBe("local");
        // …but an explicit scope wins over the suite's env default.
        withStorageDisabled(() => {
          expect(getStorageBackend()).toBe("none");
        });
        observedDir = dir;
      });
    });

    afterAll(() => {
      // After the suite, the last-observed dir is removed and the path cleared —
      // proving each test's dir is torn down in its afterEach.
      expect(observedDir).not.toBeNull();
      expect(dirExists(observedDir!)).toBe(false);
      expect(getTestStoragePath()).toBeNull();
    });
  });

  // Regression: getStorageBackend() checks the Bunny creds before the local
  // path, so a `storage: "local"` suite must clear any conflicting zone env —
  // otherwise ambient credentials would resolve it to "bunny", not "local".
  describeWithEnv(
    "local backend clears conflicting zone credentials",
    {
      env: { STORAGE_ZONE_KEY: "leak", STORAGE_ZONE_NAME: "leak" },
      storage: "local",
    },
    () => {
      test("selects local even when zone credentials are present in the env", () => {
        expect(getStorageBackend()).toBe("local");
      });
    },
  );

  describeWithEnv("no storage option", {}, () => {
    test("leaves storage disabled by default", () => {
      expect(getStorageBackend()).toBe("none");
      expect(getTestStoragePath()).toBeNull();
    });
  });

  // Regression: the storage option must resolve the backend through a typed
  // StorageConfig (layered under runWithStorageConfig, over env) and must NOT
  // mutate STORAGE_ZONE_*/LOCAL_STORAGE_PATH — reintroducing that env-var route
  // is exactly the race AsyncLocalStorage was added to avoid. A suite that pins
  // sentinel values for all three vars must still resolve local from config, and
  // find every sentinel untouched afterwards. Fails on the prior env-based
  // implementation, which overwrote LOCAL_STORAGE_PATH and cleared the zone vars.
  describeWithEnv(
    "storage option resolves via config, not env vars",
    {
      env: {
        LOCAL_STORAGE_PATH: "sentinel-path",
        STORAGE_ZONE_KEY: "sentinel-key",
        STORAGE_ZONE_NAME: "sentinel-name",
      },
      storage: "local",
    },
    () => {
      test("selects local from config while leaving the env sentinels intact", () => {
        expect(getStorageBackend()).toBe("local");
        expect(Deno.env.get("LOCAL_STORAGE_PATH")).toBe("sentinel-path");
        expect(Deno.env.get("STORAGE_ZONE_KEY")).toBe("sentinel-key");
        expect(Deno.env.get("STORAGE_ZONE_NAME")).toBe("sentinel-name");
      });
    },
  );
});
