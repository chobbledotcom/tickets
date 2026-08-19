import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import { unwrapKeyWithToken } from "#crypto/keys.ts";
import { generateSecureToken } from "#crypto/utils.ts";
import {
  createApiKey,
  deleteApiKey,
  getApiKeyByToken,
  getApiKeyForUser,
  getApiKeysForUser,
  touchApiKeyLastUsed,
} from "#db/api-keys.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#db/query-log.ts";
import { setTouchOverride } from "#shared/test-overrides.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestApiKeyFull } from "#test-utils/session.ts";

describeWithEnv("API key records", { db: true }, () => {
  describe("database operations", () => {
    test("creates and retrieves an API key", async () => {
      const { apiKey, id } = await createTestApiKeyFull();

      expect(id).toBeGreaterThan(0);
      expect(apiKey).toBeTruthy();

      const found = await getApiKeyByToken(apiKey);
      expect(found).not.toBeNull();
      expect(found!.user_id).toBe(1);
      expect(found!.id).toBe(id);
    });

    test("unwraps DATA_KEY from API key", async () => {
      const { apiKey } = await createTestApiKeyFull();

      const found = await getApiKeyByToken(apiKey);
      const unwrapped = await unwrapKeyWithToken(
        found!.wrapped_data_key,
        apiKey,
      );
      expect(unwrapped).not.toBeNull();
    });

    test("returns null for unknown token", async () => {
      const found = await getApiKeyByToken("nonexistent-token");
      expect(found).toBeNull();
    });

    test("throws for wrong token unwrap", async () => {
      const { apiKey } = await createTestApiKeyFull();

      const found = await getApiKeyByToken(apiKey);
      await expect(
        unwrapKeyWithToken(found!.wrapped_data_key, "wrong-token"),
      ).rejects.toThrow();
    });

    test("lists API keys for a user", async () => {
      const { dataKey } = await createTestApiKeyFull("Key A");
      await createApiKey(1, "Key B", dataKey, generateSecureToken);

      const keys = await getApiKeysForUser(1);
      expect(keys).toHaveLength(2);
      expect(keys[0]!.name).toBe("Key A");
      expect(keys[1]!.name).toBe("Key B");
    });

    test("deletes an API key", async () => {
      const { id } = await createTestApiKeyFull();

      const deleted = await deleteApiKey(id, 1);
      expect(deleted).toBe(true);
      expect(await getApiKeysForUser(1)).toEqual([]);
    });

    test("delete fails for wrong user", async () => {
      const { id } = await createTestApiKeyFull();

      const deleted = await deleteApiKey(id, 999);
      expect(deleted).toBe(false);
      expect(await getApiKeysForUser(1)).toHaveLength(1);
    });

    test("touchApiKeyLastUsed stamps last_used on the stored row only", async () => {
      const { dataKey, id } = await createTestApiKeyFull("Touch Test");
      const other = await createApiKey(
        1,
        "Untouched",
        dataKey,
        generateSecureToken,
      );

      // Fresh keys start with an empty last_used.
      const before = await getApiKeysForUser(1);
      expect(before.find((k) => k.id === id)!.lastUsed).toBe("");

      await touchApiKeyLastUsed(id);

      const after = await getApiKeysForUser(1);
      const touched = after.find((k) => k.id === id)!;
      // The stored value changed to a parseable timestamp…
      expect(touched.lastUsed).not.toBe("");
      expect(Number.isNaN(Date.parse(touched.lastUsed))).toBe(false);
      // …and only the touched key's row was updated.
      expect(after.find((k) => k.id === other.id)!.lastUsed).toBe("");
    });

    test("gets a single API key by ID and user", async () => {
      const { id } = await createTestApiKeyFull("Lookup Key");

      const found = await getApiKeyForUser(id, 1);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Lookup Key");
    });

    test("display reads select only the API key fields they return", async () => {
      const { id } = await createTestApiKeyFull("Narrow read");

      await runWithQueryLogContext(async () => {
        enableQueryLog();
        await getApiKeysForUser(1);
        await getApiKeyForUser(id, 1);
        expect(getQueryLog().map((entry) => entry.sql)).toEqual([
          "SELECT id, name, created, last_used FROM api_keys WHERE user_id = ? ORDER BY id ASC",
          "SELECT id, name FROM api_keys WHERE id = ? AND user_id = ? LIMIT ?",
        ]);
      });
    });

    test("getApiKeyForUser throws for wrong user", async () => {
      const { id } = await createTestApiKeyFull("Wrong User");

      await expect(getApiKeyForUser(id, 999)).rejects.toThrow(
        `API key ${id} not found for user 999`,
      );
    });

    test("lists empty array for user with no keys", async () => {
      const keys = await getApiKeysForUser(999);
      expect(keys).toHaveLength(0);
    });
  });

  test("touchApiKeyLastUsed surfaces the test-override error to its caller", async () => {
    // The fire-and-forget swallowing happens at the request layer; the
    // function itself must still throw so that layer has something to catch.
    setTouchOverride(new Error("touch failed"));
    try {
      await expect(touchApiKeyLastUsed(1)).rejects.toThrow("touch failed");
    } finally {
      setTouchOverride(null);
    }
  });

  test("getApiKeyForUser throws a not-found error for an unknown key", async () => {
    await expect(getApiKeyForUser(999_999, 1)).rejects.toThrow(
      "API key 999999 not found for user 1",
    );
  });
});
