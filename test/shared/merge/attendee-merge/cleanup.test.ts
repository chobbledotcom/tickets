import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#shared/db/client.ts";
import { insertCheckoutStage } from "#test-utils/checkout-stages.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createMergePair, runMerge } from "./helpers.ts";

describeWithEnv("attendee merge cleanup", { db: true }, () => {
  test("removes checkout stages for both merged attendees", async () => {
    const { source, target } = await createMergePair();
    await insertCheckoutStage(target.id, "merge-target-stage");
    await insertCheckoutStage(source.id, "merge-source-stage");

    const { result } = await runMerge({ source, target });

    expect(result.success).toBe(true);
    expect(
      await queryAll<{ attendee_id: number }>(
        "SELECT attendee_id FROM checkout_stages WHERE attendee_id IN (?, ?)",
        [target.id, source.id],
      ),
    ).toEqual([]);
  });
});
