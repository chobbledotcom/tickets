import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import { findApiKeyForUser, getApiKeysForUser } from "#db/api-keys.ts";
import { apiKeyRecord } from "#shared/records/api-keys.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { deleteConfirmLabel } from "#test-utils/record-labels.ts";
import { wrapDbClient } from "#test-utils/record-queries.ts";
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
  describe("record declaration", () => {
    test("refuses a collection read with no request session", () => {
      expect(() => apiKeyRecord.getAll()).toThrow(
        "An API key read requires the request session",
      );
    });

    test("logs the key by the name the caller typed", () => {
      expect(apiKeyRecord.logName({ name: "Deploy key" })).toBe("Deploy key");
    });

    test("names a key on its pages and its delete page", () => {
      expect([
        apiKeyRecord.activityName,
        deleteConfirmLabel(apiKeyRecord),
        apiKeyRecord.nameOf({
          created: "",
          id: 1,
          lastUsed: "",
          name: "Deploy key",
        }),
      ]).toEqual(["API key", "API key name", "Deploy key"]);
    });
  });

  describe("record rule", () => {
    test("trims the name it stores", async () => {
      expect(await apiKeyRecord.rule({ name: "  Deploy  " }, null)).toEqual({
        ok: true,
        value: { name: "Deploy" },
      });
    });

    test("refuses a name with nothing in it", async () => {
      expect(await apiKeyRecord.rule({ name: "   " }, null)).toEqual({
        error: "Name is required",
        ok: false,
      });
    });

    test("refuses a name past the text box limit", async () => {
      expect(await apiKeyRecord.rule({ name: "k".repeat(251) }, null)).toEqual({
        error: "Name must be 250 characters or fewer",
        ok: false,
      });
    });

    test("accepts a name at the text box limit", async () => {
      const name = "k".repeat(250);

      expect(await apiKeyRecord.rule({ name }, null)).toEqual({
        ok: true,
        value: { name },
      });
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

    test("create answers the key it just made among several", async () => {
      const actor = await ownerActor();
      await createTestApiKeyFull("Older key");

      const verdict = await apiKeyRecord.create(
        { name: "Newer key" },
        undefined,
        actor,
      );

      expect(verdict).toMatchObject({
        kind: "written",
        row: { id: 2, name: "Newer key" },
      });
    });

    test("lists and loads the keys of the session's user", async () => {
      const actor = await ownerActor();
      const { id } = await createTestApiKeyFull("Listed key");

      expect(
        (await apiKeyRecord.getAll(actor)).map((key) => [key.id, key.name]),
      ).toEqual([[id, "Listed key"]]);
      expect(await apiKeyRecord.load(id, actor)).toEqual({
        created: "",
        id,
        lastUsed: "",
        name: "Listed key",
      });
      expect(await apiKeyRecord.load(999_999, actor)).toBe(null);
    });

    test("create refuses a name with nothing in it", async () => {
      const actor = await ownerActor();

      expect(
        await apiKeyRecord.create({ name: " " }, undefined, actor),
      ).toEqual({ kind: "refused", message: "Name is required" });
      expect(await getApiKeysForUser(1)).toEqual([]);
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
