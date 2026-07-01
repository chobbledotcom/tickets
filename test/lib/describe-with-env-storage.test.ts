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
    // Captured in the first test, asserted removed in the second — proving the
    // per-test temp dir is created before and torn down after each test.
    let firstDir: string | null = null;

    describeWithEnv("local storage lifecycle", { storage: "local" }, () => {
      test("allocates a real temp dir and selects the local backend", () => {
        const dir = getTestStoragePath();
        expect(dir).not.toBeNull();
        expect(dirExists(dir!)).toBe(true);
        expect(getStorageBackend()).toBe("local");
        expect(isStorageEnabled()).toBe(true);
        firstDir = dir;
      });

      test("a per-test withStorageDisabled scope overrides the suite default", () => {
        // The previous test's dir was cleaned up in its afterEach.
        expect(firstDir).not.toBeNull();
        expect(dirExists(firstDir!)).toBe(false);
        // This test still has its own live dir…
        expect(getStorageBackend()).toBe("local");
        // …but an explicit scope wins over the suite's env default.
        withStorageDisabled(() => {
          expect(getStorageBackend()).toBe("none");
        });
      });
    });

    afterAll(() => {
      // After the whole suite, the last test's dir is gone too.
      expect(getTestStoragePath()).toBeNull();
    });
  });

  describeWithEnv("no storage option", {}, () => {
    test("leaves storage disabled by default", () => {
      expect(getStorageBackend()).toBe("none");
      expect(getTestStoragePath()).toBeNull();
    });
  });
});
