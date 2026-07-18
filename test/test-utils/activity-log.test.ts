import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { rawActivityMessage } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("activity log test helpers", { db: true }, () => {
  test("fails loudly when a raw activity row does not exist", async () => {
    await expect(rawActivityMessage(999_999)).rejects.toThrow(
      "Activity log entry not found: 999999",
    );
  });
});
