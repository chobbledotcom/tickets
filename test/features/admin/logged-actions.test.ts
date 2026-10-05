import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllActivityLog } from "#db/activity-log.ts";
import { withTransaction } from "#db/client.ts";
import type { OrderedCollection } from "#db/ordered-collection.ts";
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
    expect(
      (await withTestSession(() => getAllActivityLog())).map((e) => e.message),
    ).toContain("Attribute 'Colour' deleted");
  });

  test("the create hook appends to the collection and logs with the transaction", async () => {
    const appended: number[] = [];
    const order = {
      append: async ({ key }: { key: number }) => {
        appended.push(key);
      },
    } as unknown as OrderedCollection<"id", undefined>;

    await withTransaction(async (tx) => {
      await appendWithCreationLog(order, "Question", "Postcode")(tx, 3);
    });

    expect(appended).toEqual([3]);
    expect(
      (await withTestSession(() => getAllActivityLog())).map((e) => e.message),
    ).toContain("Question 'Postcode' created");
  });
});
