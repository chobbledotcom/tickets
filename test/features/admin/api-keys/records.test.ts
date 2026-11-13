import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
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
import { apiKeyRecord } from "#shared/records/api-keys.ts";
import { setTouchOverride } from "#shared/test-overrides.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { wrapDbClient } from "#test-utils/record-queries.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import {
  createTestApiKeyFull,
  getTestAuthSession,
} from "#test-utils/session.ts";

/** Run one record command against a database whose matching statements answer
 *  with no rows, so a row can vanish between the read and the write. */
const withStubbedStatements = async (
  matches: (sql: string) => boolean,
  run: () => Promise<unknown>,
): Promise<void> => {
  const restore = wrapDbClient({
    batch: () => {},
    execute: (statement) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      return matches(sql) ? Promise.resolve(emptyResultSet()) : null;
    },
  });
  try {
    await run();
  } finally {
    restore();
  }
};

describeWithEnv("API key records", { db: true }, () => {
  describe("database operations", () => {
    test("creates and retrieves an API key", async () => {
      const { apiKey, id } = await createTestApiKeyFull();

      expect(id).toBeGreaterThan(0);
      expect(apiKey).toMatch(/^[\w-]+$/);

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

      const found = await findApiKeyForUser(id, 1);
      expect(found?.name).toBe("Lookup Key");
    });

    test("display reads select only the API key fields they return", async () => {
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

    test("findApiKeyForUser answers null for another user", async () => {
      const { id } = await createTestApiKeyFull("Wrong User");

      expect(await findApiKeyForUser(id, 999)).toBeNull();
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

  test("findApiKeyForUser answers null for an unknown key", async () => {
    expect(await findApiKeyForUser(999_999, 1)).toBeNull();
  });

  describe("record declaration", () => {
    test("refuses a collection read with no request session", () => {
      expect(() => apiKeyRecord.getAll()).toThrow(
        "An API key read requires the request session",
      );
    });

    test("logs the key by the name the caller typed", () => {
      expect(apiKeyRecord.logName({ name: "Deploy key" })).toBe("Deploy key");
    });
  });

  describe("record commands", () => {
    const ownerActor = async () => ({
      session: await getTestAuthSession(),
    });

    test("create answers the stored key with its one-time secret", async () => {
      const actor = await ownerActor();
      const verdict = await apiKeyRecord.create(
        { name: "  Deploy key  " },
        undefined,
        actor,
      );

      if (verdict.kind !== "written") throw new Error("create was refused");
      expect(verdict.row.name).toBe("Deploy key");
      expect(verdict.row.secret).toMatch(/^[\w-]+$/);
      expect(
        await findApiKeyForUser(verdict.row.id, actor.session.userId),
      ).toEqual({ id: verdict.row.id, name: "Deploy key" });
    });

    test("create refuses when the new key cannot be read back", async () => {
      const actor = await ownerActor();
      await withStubbedStatements(
        (sql) => sql.startsWith("SELECT") && sql.includes("FROM api_keys"),
        () =>
          expect(
            apiKeyRecord.create({ name: "Ghost key" }, undefined, actor),
          ).rejects.toThrow(/was created but not read back/),
      );
    });

    test("remove deletes the key its id names", async () => {
      const actor = await ownerActor();
      const { id } = await createTestApiKeyFull("Doomed key");

      expect(await apiKeyRecord.remove(id, undefined, actor)).toEqual({
        kind: "deleted",
      });
      expect(await getApiKeysForUser(1)).toEqual([]);
    });

    test("remove answers not-found for an unknown key", async () => {
      const actor = await ownerActor();

      expect(await apiKeyRecord.remove(999_999, undefined, actor)).toEqual({
        kind: "not-found",
      });
    });

    test("remove answers not-found when the row vanishes before the delete", async () => {
      const actor = await ownerActor();
      const { id } = await createTestApiKeyFull("Vanishing key");
      await withStubbedStatements(
        (sql) => sql.startsWith("DELETE FROM api_keys"),
        async () =>
          expect(await apiKeyRecord.remove(id, undefined, actor)).toEqual({
            kind: "not-found",
          }),
      );
    });

    test("update refuses to rename an existing key", async () => {
      const actor = await ownerActor();
      const { id } = await createTestApiKeyFull("Fixed name");

      expect(
        await apiKeyRecord.update(id, { name: "Renamed" }, undefined, actor),
      ).toEqual({
        kind: "refused",
        message: "An API key cannot be renamed",
      });
    });

    test("update answers not-found for an unknown key", async () => {
      const actor = await ownerActor();

      expect(
        await apiKeyRecord.update(999_999, { name: "Nope" }, undefined, actor),
      ).toEqual({ kind: "not-found" });
    });
  });
});
