import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { enabledFeaturesAreValidSql } from "#db/admin-feature-sql.ts";
import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { parseEnabledFeatures } from "#shared/admin-features.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const accepts = async (stored: string): Promise<boolean> => {
  const result = await execute(
    sql`SELECT ${enabledFeaturesAreValidSql(sql`${stored}`)} AS valid`,
  );
  return result.rows[0]?.valid === 1;
};

describeWithEnv("db > admin feature setting SQL", { db: true }, () => {
  test("accepts a feature list that lacks a key a newer release adds", async () => {
    const { invoices: _absent, ...saved } = parseEnabledFeatures("");

    expect(await accepts(JSON.stringify(saved))).toBe(true);
  });

  test("accepts every key when each is a boolean", async () => {
    expect(await accepts(JSON.stringify(parseEnabledFeatures("")))).toBe(true);
  });

  test("rejects a key that is not a boolean", async () => {
    const stored = { ...parseEnabledFeatures(""), money: "true" };

    expect(await accepts(JSON.stringify(stored))).toBe(false);
  });

  test("rejects malformed JSON and a value that is not an object", async () => {
    expect(await accepts("not json")).toBe(false);
    expect(await accepts("[]")).toBe(false);
  });
});
