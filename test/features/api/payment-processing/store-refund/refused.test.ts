/** The placeholder store's refusal guard: a refused atomic write must throw
 * its named error, never hang on the callback that never ran. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeesApi } from "#db/attendees/api.ts";
import { placeholderRefund } from "#payment/placeholder-refund.ts";
import {
  datelessGhostBookings,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import {
  bookingIntent,
  paymentSession,
} from "#test/features/api/payment-processing/index/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv(
  "a placeholder store the attendee write refuses",
  { db: true },
  () => {
    test("throws the refusal instead of waiting on the never-run callback", async () => {
      const intent = bookingIntent([{ e: 77, p: 500, q: 1 }]);
      const session = paymentSession("cs_store_refused", 500, intent);
      using refused = stub(attendeesApi, "createAttendeeAtomic", () =>
        Promise.resolve({
          listingIds: [],
          reason: "capacity_exceeded",
          success: false,
        } as const),
      );
      await expect(
        storeRefundedBooking(
          session,
          intent,
          datelessGhostBookings(intent.items),
          placeholderRefund("unexpected_error")("stubbed refusal"),
          1,
        ),
      ).rejects.toThrow(
        "Placeholder store was refused (capacity_exceeded) for session cs_store_refused",
      );
      expect(refused.calls).toHaveLength(1);
    });
  },
);
