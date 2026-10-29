import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeBalanceState } from "#db/attendees/balance.ts";
import { processBooking } from "#shared/booking.ts";
import { readTaxAssessments } from "#shared/tax/store.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withSetting } from "#test-utils/settings.ts";

const contact = {
  address: "",
  email: "buyer@example.com",
  name: "Buyer",
  phone: "",
  special_instructions: "",
};

/** The booking stored the policy as booked, at the first revision. */
const expectStoredAssessment = async (
  attendeeId: number,
  policy: { mode: string; rateBasisPoints: number },
  total: number,
) => {
  const [assessment] = await readTaxAssessments([attendeeId]);
  expect(assessment?.state.assessment.policy).toEqual(policy);
  expect(assessment?.state.assessment.total).toBe(total);
  expect(assessment?.state.revision).toBe(0);
};

describeWithEnv("public API creation VAT", { db: true, triggers: true }, () => {
  for (const [mode, balance] of [
    ["add_to_total", 2400],
    ["calculate_from_total", 2000],
  ] as const) {
    test(`records current ${mode} VAT on a provider-less booking`, async () => {
      const policy = { mode, rateBasisPoints: 2000 };
      await withSetting({ tax: JSON.stringify(policy) }, async () => {
        const listing = await createTestListing({
          maxAttendees: 10,
          unitPrice: 1000,
        });
        const result = await processBooking(
          listing,
          contact,
          2,
          null,
          "http://localhost",
        );
        expect(result.type).toBe("success");
        if (result.type !== "success")
          throw new Error("Booking did not complete");
        expect(
          (await getAttendeeBalanceState(result.attendee.id))?.remainingBalance,
        ).toBe(balance);
        await expectStoredAssessment(result.attendee.id, policy, balance);
      });
    });
  }
  test("persists the current assessment for a genuinely free booking", async () => {
    const policy = { mode: "add_to_total", rateBasisPoints: 2000 };
    await withSetting({ tax: JSON.stringify(policy) }, async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 0,
      });
      const result = await processBooking(
        listing,
        contact,
        1,
        null,
        "http://localhost",
      );
      if (result.type !== "success")
        throw new Error("Booking did not complete");
      await expectStoredAssessment(result.attendee.id, policy, 0);
    });
  });
});
