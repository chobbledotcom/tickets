import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { unwrapKeyWithToken } from "#crypto/keys.ts";
import { generateSecureToken } from "#crypto/utils.ts";
import {
  createApiKey,
  deleteApiKey,
  findApiKeyForUser,
  getApiKeyByToken,
  getApiKeysForUser,
  touchApiKeyLastUsed,
} from "#db/api-keys.ts";
import { enableQueryLog, getQueryLog } from "#db/query-log.ts";
import { setTouchOverride } from "#shared/test-overrides.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { createTestApiKeyFull } from "#test-utils/session.ts";

describeWithEnv("db > api keys", { db: true }, () => {
  describe("creating and finding a key", () => {
    test("hands back the token once and finds the key by it", async () => {
      const { dataKey, id } = await createTestApiKeyFull();
      const second = await createApiKey(
        1,
        "Second",
        dataKey,
        () => "fixed-token",
      );

      expect(second).toEqual({ apiKey: "fixed-token", id: id + 1 });
      const found = await getApiKeyByToken("fixed-token");
      expect(found).toEqual({
        created: found?.created,
        id: id + 1,
        key_index: await hmacHash("fixed-token"),
        last_used: "",
        user_id: 1,
        wrapped_data_key: found?.wrapped_data_key,
      });
      expect(Number.isNaN(Date.parse(found?.created ?? ""))).toBe(false);
    });

    test("wraps the data key under the token, and only that token", async () => {
      const { apiKey } = await createTestApiKeyFull();
      const found = await getApiKeyByToken(apiKey);
      if (found === null) throw new Error("the key was not stored");

      const unwrapped = await unwrapKeyWithToken(
        found.wrapped_data_key,
        apiKey,
      );
      expect(unwrapped.type).toBe("secret");
      await expect(
        unwrapKeyWithToken(found.wrapped_data_key, "wrong-token"),
      ).rejects.toThrow();
    });

    test("answers null for a token no key carries", async () => {
      expect(await getApiKeyByToken("nonexistent-token")).toBeNull();
    });
  });

  describe("listing a user's keys", () => {
    test("lists each key with its decrypted name, oldest first", async () => {
      const { dataKey, id } = await createTestApiKeyFull("Key A");
      await createApiKey(1, "Key B", dataKey, generateSecureToken);

      const keys = await getApiKeysForUser(1);
      expect(
        keys.map(({ id, lastUsed, name }) => ({ id, lastUsed, name })),
      ).toEqual([
        { id, lastUsed: "", name: "Key A" },
        { id: id + 1, lastUsed: "", name: "Key B" },
      ]);
      expect(keys.map((key) => Number.isNaN(Date.parse(key.created)))).toEqual([
        false,
        false,
      ]);
    });

    test("lists nothing for a user with no keys", async () => {
      expect(await getApiKeysForUser(999)).toEqual([]);
    });

    test("finds one key by id only for its own user", async () => {
      const { id } = await createTestApiKeyFull("Lookup Key");

      expect(await findApiKeyForUser(id, 1)).toEqual({
        id,
        name: "Lookup Key",
      });
      expect(await findApiKeyForUser(id, 999)).toBeNull();
      expect(await findApiKeyForUser(999_999, 1)).toBeNull();
    });

    test("selects only the fields each display read returns", async () => {
      const { id } = await createTestApiKeyFull("Narrow read");

      await withRequestContext(async () => {
        enableQueryLog();
        await getApiKeysForUser(1);
        await findApiKeyForUser(id, 1);
        expect(getQueryLog().map((entry) => entry.sql)).toEqual([
          "SELECT id, name, created, last_used FROM api_keys WHERE user_id = ? ORDER BY id ASC",
          "SELECT id, name FROM api_keys WHERE id = ? AND user_id = ? LIMIT ?",
        ]);
      });
    });
  });

  describe("deleting a key", () => {
    test("deletes the key of its own user", async () => {
      const { id } = await createTestApiKeyFull();

      expect(await deleteApiKey(id, 1)).toBe(true);
      expect(await getApiKeysForUser(1)).toEqual([]);
    });

    test("refuses to delete another user's key", async () => {
      const { id } = await createTestApiKeyFull("Kept");

      expect(await deleteApiKey(id, 999)).toBe(false);
      expect((await getApiKeysForUser(1)).map((key) => key.name)).toEqual([
        "Kept",
      ]);
    });
  });

  describe("stamping last use", () => {
    test("stamps last_used on the touched row only", async () => {
      const { dataKey, id } = await createTestApiKeyFull("Touch Test");
      const other = await createApiKey(
        1,
        "Untouched",
        dataKey,
        generateSecureToken,
      );

      await touchApiKeyLastUsed(id);

      const after = await getApiKeysForUser(1);
      const touched = after.find((key) => key.id === id);
      expect(Number.isNaN(Date.parse(touched?.lastUsed ?? ""))).toBe(false);
      expect(after.find((key) => key.id === other.id)?.lastUsed).toBe("");
    });

    test("throws the test-override error to its caller", async () => {
      // The request layer swallows the failure, so this function must throw.
      setTouchOverride(new Error("touch failed"));
      try {
        await expect(touchApiKeyLastUsed(1)).rejects.toThrow("touch failed");
      } finally {
        setTouchOverride(null);
      }
    });
  });
});
