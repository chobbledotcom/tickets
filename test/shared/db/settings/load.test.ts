import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { execute, getDb } from "#shared/db/client.ts";
import {
  bumpSettingsVersion,
  CONFIG_KEYS,
  settings,
} from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { statementSql } from "#test-utils/record-queries.ts";

describeWithEnv("db > settings > load", { db: true }, () => {
  test("reloads setting values from primary after a write", async () => {
    await settings.update.paymentProvider("stripe");
    const staleReplicaResult = await getDb().execute({
      args: [CONFIG_KEYS.PAYMENT_PROVIDER],
      sql: "SELECT key, value FROM settings WHERE key = ?",
    });
    const staleVersionResult = await getDb().execute({
      args: [CONFIG_KEYS.SETTINGS_VERSION],
      sql: "SELECT value FROM settings WHERE key = ?",
    });

    await execute("UPDATE settings SET value = ? WHERE key = ?", [
      "square",
      CONFIG_KEYS.PAYMENT_PROVIDER,
    ]);
    await bumpSettingsVersion();

    using _env = withEnv({ DB_URL: "libsql://replica.test" });
    const replicaRead = stub(getDb(), "execute", (statement) =>
      Promise.resolve(
        statementSql(statement).startsWith("SELECT value FROM settings")
          ? staleVersionResult
          : staleReplicaResult,
      ),
    );
    try {
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);
      expect(settings.paymentProvider).toBe("square");
    } finally {
      replicaRead.restore();
    }
  });
});
