import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { setupTestDbEnvironment } from "#test-utils/db.ts";
import { clearTestEncryptionKey, withEnv } from "#test-utils/env.ts";

describe("test database environment", () => {
  test("restores the previous database environment during cleanup", async () => {
    using _outside = withEnv({
      DB_URL: "file:outside.db",
      DISABLE_AGGREGATE_TRIGGERS_FOR_TEST: "outside",
    });
    const cleanup = await setupTestDbEnvironment();

    try {
      expect(Deno.env.get("DB_URL")).not.toBe("file:outside.db");
      expect(Deno.env.get("DISABLE_AGGREGATE_TRIGGERS_FOR_TEST")).toBe("1");
    } finally {
      cleanup();
      clearTestEncryptionKey();
    }

    expect(Deno.env.get("DB_URL")).toBe("file:outside.db");
    expect(Deno.env.get("DISABLE_AGGREGATE_TRIGGERS_FOR_TEST")).toBe("outside");
  });

  test("replaces an active test database without keeping its environment", async () => {
    using _outside = withEnv({ DB_URL: "file:outside.db" });
    await setupTestDbEnvironment();
    const firstUrl = Deno.env.get("DB_URL");
    const cleanup = await setupTestDbEnvironment();

    try {
      expect(Deno.env.get("DB_URL")).not.toBe(firstUrl);
    } finally {
      cleanup();
      clearTestEncryptionKey();
    }

    expect(Deno.env.get("DB_URL")).toBe("file:outside.db");
  });
});
