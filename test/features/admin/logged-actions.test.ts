import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllActivityLog } from "#db/activity-log.ts";
import { confirmDeleteWithLog } from "#routes/admin/logged-actions.ts";
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
});
