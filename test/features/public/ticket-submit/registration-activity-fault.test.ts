/** A registration activity write that rejects inside a booking's create batch
 *  must roll the whole booking back on the production routes: no booking, no
 *  answers, no contact source, no ledger, no stock, and no sends. The web
 *  submit route exercises the ledger strategy (its owed order posts legs); the
 *  folded API booking exercises the plain strategy (a free order with a
 *  provider configured posts no legs). */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { allTransfers } from "#accounting/queries.ts";
import { queryOne } from "#db/client.ts";
import { getVisits, hashEmail } from "#db/contact-preferences.ts";
import { modifierUsedQuantities } from "#db/modifier-usage.ts";
import { modifiersTable } from "#db/modifiers.ts";
import { processParentApiBooking } from "#routes/api/folded-booking.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  dropRejectingActivityTrigger,
  installRejectingActivityTrigger,
} from "#test-utils/db-helpers/activity-trigger.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";
import { useFetchStub } from "#test-utils/mocks.ts";
import { makeParent } from "#test-utils/parents.ts";
import { setPublicReservation } from "#test-utils/reservation/helpers.ts";
import { setupStripe } from "#test-utils/settings.ts";

const email = "fault-buyer@example.com";

const expectNothingCommitted = async (
  fetch: ReturnType<typeof useFetchStub>,
  modifierId?: number,
): Promise<void> => {
  expect(
    (await queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM attendees",
    ))!.count,
  ).toBe(0);
  expect(
    (await queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM attendee_answers",
    ))!.count,
  ).toBe(0);
  expect(await getVisits(await hashEmail(email))).toBe(0);
  expect(await allTransfers()).toEqual([]);
  if (modifierId !== undefined) {
    expect(await modifierUsedQuantities([modifierId])).toEqual(new Map());
  }
  expect(fetch.callCount()).toBe(0);
};

describeWithEnv(
  "registration activity write faults on production routes",
  { db: true, triggers: true },
  () => {
    const fetch = useFetchStub();

    test("the web submit route's owed booking rolls back and queues no sends", async () => {
      const listing = await createTestListing({
        fields: "email",
        maxAttendees: 50,
        unitPrice: 1000,
      });
      // A stock-bearing surcharge makes the batch consume stock, so the
      // rollback must give the unit back too.
      const kit = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 100,
        direction: "charge",
        name: "Fault kit",
        stock: 2,
      });
      // A real answered question rides the batch, so the zero answer-row
      // assertion proves the answers rolled back with the booking.
      const choice = await createQuestionWithAnswer([listing.id]);
      await setPublicReservation("50%");
      await installRejectingActivityTrigger();
      try {
        // The create failure propagates out of the route; the runtime
        // answers it with a 503. Nothing may have committed either way.
        await expect(
          submitTicketForm(listing.slug, {
            email,
            name: "Fault Buyer",
            [`question_${choice.questionId}`]: String(choice.answerId),
          }),
        ).rejects.toThrow("registration activity rejected");
      } finally {
        await dropRejectingActivityTrigger();
      }
      await expectNothingCommitted(fetch, kit.id);
    });

    test("the folded API booking's free order rolls back and queues no sends", async () => {
      // Payments enabled and the whole folded order free: the plain strategy
      // (no legs, no stock) rides the batch with the activities.
      await setupStripe();
      const { parent, child } = await makeParent({
        children: [{ maxAttendees: 10, unitPrice: 0 }],
        parent: { maxAttendees: 10, unitPrice: 0 },
      });
      await installRejectingActivityTrigger();
      try {
        await expect(
          processParentApiBooking(
            new Request("http://localhost/api/listings/x/book", {
              headers: { host: "localhost" },
              method: "POST",
            }),
            parent,
            {
              children: [{ quantity: 1, slug: child.slug }],
              email,
              name: "Fault Buyer",
              quantity: 1,
            },
            1,
            null,
          ),
        ).rejects.toThrow("registration activity rejected");
      } finally {
        await dropRejectingActivityTrigger();
      }
      await expectNothingCommitted(fetch);
    });
  },
);
