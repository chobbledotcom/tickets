import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createPausedAttendeePayment,
  expectAttendeePaymentFence,
} from "#test-utils/payment-aggregate.ts";
import { createMergePair, runMerge } from "./helpers.ts";

describeWithEnv("attendee merge payment fence", { db: true }, () => {
  test("moves source payments and rejects a stale claim", async () => {
    const { source, target } = await createMergePair();
    const payment = await createPausedAttendeePayment(
      "merge-attendee-payment",
      source.id,
    );

    await runMerge({ source, target });

    await expectAttendeePaymentFence(payment, source.id, target.id);
  });
});
