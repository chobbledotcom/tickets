import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch, insert, queryAll } from "#db/client.ts";
import {
  createMergePair,
  runMerge,
} from "#test/shared/merge/attendee-merge/helpers.ts";
import { insertCheckoutStage } from "#test-utils/checkout-stages.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("attendee merge service", { db: true }, () => {
  test("removes checkout stages for both merged attendees", async () => {
    const { source, target } = await createMergePair();
    await insertCheckoutStage(target.id, "stage-merge-target");
    await insertCheckoutStage(source.id, "stage-merge-source");
    await executeBatch([
      insert("processed_payments", {
        attendee_id: target.id,
        payment_session_id: "payment-merge-target",
        processed_at: "2026-07-15T12:00:00.000Z",
      }),
      insert("processed_payments", {
        attendee_id: source.id,
        payment_session_id: "payment-merge-source",
        processed_at: "2026-07-15T12:00:00.000Z",
      }),
    ]);

    const { result } = await runMerge({ source, target });

    expect(result.success).toBe(true);
    expect(
      await queryAll(
        "SELECT attendee_id FROM checkout_stages ORDER BY attendee_id",
      ),
    ).toEqual([]);
    expect(
      await queryAll(
        "SELECT payment_session_id, attendee_id FROM processed_payments ORDER BY payment_session_id",
      ),
    ).toEqual([
      {
        attendee_id: target.id,
        payment_session_id: "payment-merge-source",
      },
      {
        attendee_id: target.id,
        payment_session_id: "payment-merge-target",
      },
    ]);
  });
});
