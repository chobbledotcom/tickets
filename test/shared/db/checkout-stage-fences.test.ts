import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  markCheckoutStage,
  stageCheckout,
} from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import {
  isSessionProcessed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const stageFor = async (
  sessionId: string,
): Promise<{ attendeeId: number; listingId: number }> => {
  const listing = await createTestListing({ unitPrice: 1000 });
  const stage = await stageCheckout(
    sessionId,
    "stripe",
    checkoutIntent({
      items: [
        checkoutItem({
          listingId: listing.id,
          name: listing.name,
          slug: listing.slug,
        }),
      ],
    }),
  );
  return { attendeeId: stage.attendeeId, listingId: listing.id };
};

const stageRevision = async (): Promise<number> => {
  const result = await getDb().execute(
    "SELECT revision FROM checkout_stage_revisions WHERE id = 1",
  );
  return Number(result.rows[0]?.revision ?? 0);
};

describeWithEnv("db > checkout stage fences", { db: true }, () => {
  test("changes the checkout stage revision on insert, update, and delete", async () => {
    const before = await stageRevision();
    await stageFor("cs_revision_mutations");
    expect(await stageRevision()).toBe(before + 1);

    await markCheckoutStage("cs_revision_mutations", "failed");
    expect(await stageRevision()).toBe(before + 2);

    await getDb().execute(
      "DELETE FROM checkout_stages WHERE payment_session_id = ?",
      ["cs_revision_mutations"],
    );
    expect(await stageRevision()).toBe(before + 3);
  });

  test("rejects a legacy payment reservation that omits a staged attendee claim", async () => {
    await stageFor("cs_legacy_reservation");

    await expect(
      getDb().execute({
        args: ["cs_legacy_reservation", new Date().toISOString()],
        sql: `INSERT INTO processed_payments
                (payment_session_id, attendee_id, processed_at)
              VALUES (?, NULL, ?)`,
      }),
    ).rejects.toThrow("checkout stage claim does not match");
    expect(await isSessionProcessed("cs_legacy_reservation")).toBeNull();
  });

  test("reserveSession records the staged attendee claim", async () => {
    const stage = await stageFor("cs_current_reservation");

    expect(await reserveSession("cs_current_reservation")).toEqual({
      reserved: true,
    });
    expect(
      (await isSessionProcessed("cs_current_reservation"))
        ?.checkout_stage_attendee_id,
    ).toBe(stage.attendeeId);
  });

  test("rejects finalizing an open stage to another attendee", async () => {
    const stage = await stageFor("cs_mismatched_finalize");
    const other = await createTestAttendeeDirect(
      stage.listingId,
      "Other buyer",
      "other-buyer@example.com",
    );
    await reserveSession("cs_mismatched_finalize");

    await expect(
      getDb().execute(
        `UPDATE processed_payments SET attendee_id = ?
          WHERE payment_session_id = ?`,
        [other.attendee.id, "cs_mismatched_finalize"],
      ),
    ).rejects.toThrow("open checkout stage belongs to another attendee");
    expect(
      (await isSessionProcessed("cs_mismatched_finalize"))?.attendee_id,
    ).toBeNull();
  });
});
