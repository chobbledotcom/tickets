import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getStorageBackend,
  runWithStorageConfig,
  storageZoneName,
  uploadRaw,
} from "#shared/storage.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  withLocalStorageEnabled,
  withStorageDisabled,
} from "#test-utils/mocks.ts";
import { STORAGE_TEST_ENV } from "./fixtures.ts";

describeWithEnv("storage environment config", STORAGE_TEST_ENV, () => {
  test("an empty local path keeps storage disabled", async () => {
    using _env = withEnv({ LOCAL_STORAGE_PATH: "" });
    expect(getStorageBackend()).toBe("none");
    await expect(
      uploadRaw(new Uint8Array([1]), "empty-local-path-test/file"),
    ).rejects.toThrow("Storage is not configured");
  });

  test("reads Bunny credentials from their environment keys", () => {
    using _env = withEnv({
      STORAGE_ZONE_KEY: "env-key",
      STORAGE_ZONE_NAME: "env-zone",
    });
    expect(getStorageBackend()).toBe("bunny");
  });

  test("a missing Bunny key does not invent a credential", () => {
    using _env = withEnv({
      STORAGE_ZONE_KEY: undefined,
      STORAGE_ZONE_NAME: "env-zone",
    });
    expect(getStorageBackend()).toBe("none");
  });

  test("a missing Bunny zone does not invent a credential", () => {
    using _env = withEnv({
      STORAGE_ZONE_KEY: "env-key",
      STORAGE_ZONE_NAME: undefined,
    });
    expect(getStorageBackend()).toBe("none");
  });

  test("a scoped config with only the zone name stays disabled", () => {
    runWithStorageConfig(
      { localPath: "", zoneKey: "", zoneName: "myzone" },
      () => expect(getStorageBackend()).toBe("none"),
    );
  });

  test("a scoped config with only the zone key stays disabled", () => {
    runWithStorageConfig(
      { localPath: "", zoneKey: "mykey", zoneName: "" },
      () => expect(getStorageBackend()).toBe("none"),
    );
  });

  test("a scoped Bunny config enables storage", () => {
    runWithStorageConfig({ zoneKey: "mykey", zoneName: "myzone" }, () => {
      expect(getStorageBackend()).toBe("bunny");
    });
  });

  test("a scoped local path enables storage", async () => {
    await withLocalStorageEnabled(async () => {
      await Promise.resolve();
      expect(getStorageBackend()).toBe("local");
    });
  });

  test("an explicit disabled scope overrides environment config", async () => {
    using _env = withEnv({
      STORAGE_ZONE_KEY: "env-key",
      STORAGE_ZONE_NAME: "env-zone",
    });
    await withStorageDisabled(() => {
      expect(getStorageBackend()).toBe("none");
    });
  });

  test("names the zone when Bunny storage is active", () => {
    runWithStorageConfig({ zoneKey: "mykey", zoneName: "myzone" }, () => {
      expect(storageZoneName()).toBe("myzone");
    });
  });

  test("has no zone name under local storage", async () => {
    await withLocalStorageEnabled(async () => {
      await Promise.resolve();
      expect(storageZoneName()).toBe(null);
    });
  });
});
