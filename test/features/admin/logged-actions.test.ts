import { assert, assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllActivityLog } from "#db/activity-log.ts";
import { withTransaction } from "#db/client.ts";
import {
  appendWithCreationLog,
  confirmDeleteWithLog,
} from "#routes/admin/logged-actions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withTestSession } from "#test-utils/session.ts";

describeWithEnv("admin > logged actions", { db: true }, () => {
  test("the confirmed delete removes the row and logs its name", async () => {
    const deleted: number[] = [];
    await confirmDeleteWithLog(
      async (id) => {
        deleted.push(id);
      },
      "Attribute",
      (row: { id: number; name: string }) => row.name,
    )({ id: 7, name: "Colour" });

    expect(deleted).toEqual([7]);
    assertArrayIncludes(
      (await withTestSession(() => getAllActivityLog())).map((e) => e.message),
      ["Attribute 'Colour' deleted"],
    );
  });

  test("the create hook appends to the collection and logs with the transaction", async () => {
    const appended: number[] = [];
    const order = {
      append: async ({ key }: { key: number }) => {
        appended.push(key);
      },
    };

    await withTransaction(async (tx) => {
      await appendWithCreationLog(order, "Question", "Postcode")(tx, 3);
    });

    expect(appended).toEqual([3]);
    assertArrayIncludes(
      (await withTestSession(() => getAllActivityLog())).map((e) => e.message),
      ["Question 'Postcode' created"],
    );
  });

  test("a rolled-back creation leaves no log line", async () => {
    const order = {
      append: async () => {},
    };
    // The deliberate throw rolls the transaction back: if the log write ran
    // outside the transaction, its row would survive and this test would fail.
    const rollback = new Error("rollback");
    let rolledBack = false;

    await withTransaction(async (tx) => {
      await appendWithCreationLog(order, "Question", "Ghost")(tx, 5);
      throw rollback;
    }).catch((error: unknown) => {
      rolledBack = error === rollback;
    });

    expect(rolledBack).toBe(true);
    assert(
      !(await withTestSession(() => getAllActivityLog()))
        .map((e) => e.message)
        .includes("Question 'Ghost' created"),
    );
  });
});
