/** The due-registration-email drain: one claim owns one provider call, an
 * erased attendee receives nothing, and a failed send stays due. */

import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#db/client.ts";
import {
  type PreparedRegistrationEmail,
  queueRegistrationEmails,
} from "#db/registration-email-work.ts";
import { deliverDueRegistrationEmails } from "#shared/email/registration-work.ts";
import type { EmailMessage } from "#shared/email.ts";
import { parseEmail } from "#shared/validation/email.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { useFetchStub } from "#test-utils/mocks.ts";

const message = (to: string): EmailMessage => ({
  html: "<p>Confirmed</p>",
  subject: "Your tickets",
  text: "Confirmed",
  to: parseEmail(to)!,
});

const prepared = (to: string): PreparedRegistrationEmail => ({
  message: message(to),
  recipient: "buyer",
});

/** Assert one claimable row: still due, still carrying its sealed message. */
const expectRowDue = async (attendeeId: number): Promise<void> => {
  const row = await queryOne<{ state: string; sealed: string }>(
    "SELECT state, sealed FROM registration_email_work WHERE attendee_id = ?",
    [attendeeId],
  );
  expect(row?.state).toBe("due");
  expect(row?.sealed).not.toBe("");
};

describeWithEnv("registration email delivery", { db: true }, () => {
  const fetch = useFetchStub();
  const errorLog = setupErrorSpy();
  // One live listing backs every attendee the drain tests book.
  let listingId: number;

  beforeEach(async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    listingId = listing.id;
  });

  test("delivers a due message through the provider", async () => {
    await configureTestEmail();
    const { attendee } = await createTestAttendeeDirect(
      listingId,
      "Drain Buyer",
      "drain-buyer@example.com",
    );
    await queueRegistrationEmails("cs_drain_deliver", attendee.id, [
      prepared("drain-buyer@example.com"),
    ]);

    const result = await deliverDueRegistrationEmails();

    expect(result).toEqual({ failed: false, more: false });
    expect(fetch.getFetchJsonBody().subject).toBe("Your tickets");
  });

  test("completes a claimed row for an erased attendee without sending", async () => {
    await configureTestEmail();
    const { attendee } = await createTestAttendeeDirect(
      listingId,
      "Erased Buyer",
      "erased-buyer@example.com",
    );
    await queueRegistrationEmails("cs_drain_erased", attendee.id, [
      prepared("erased-buyer@example.com"),
    ]);
    await execute("DELETE FROM attendees WHERE id = ?", [attendee.id]);

    const result = await deliverDueRegistrationEmails();

    expect(result).toEqual({ failed: false, more: false });
    // No provider call was made: the erased booking sends no mail.
    expect(fetch.callCount()).toBe(0);
  });

  test("keeps a failed message due and reports the failure", async () => {
    await configureTestEmail();
    const { attendee } = await createTestAttendeeDirect(
      listingId,
      "Failing Buyer",
      "failing-buyer@example.com",
    );
    await queueRegistrationEmails("cs_drain_fail", attendee.id, [
      prepared("failing-buyer@example.com"),
    ]);
    // The provider rejects the send.
    fetch.restubFetch(() => new Response("boom", { status: 500 }));

    const result = await deliverDueRegistrationEmails();

    expect(result.failed).toBe(true);
    await expectRowDue(attendee.id);
  });

  test("claims nothing when no row is due", async () => {
    await configureTestEmail();

    const result = await deliverDueRegistrationEmails();

    expect(result).toEqual({ failed: false, more: false });
    expect(fetch.callCount()).toBe(0);
  });

  test("keeps a message due when email is not configured", async () => {
    // No configureTestEmail call: no provider settings resolve.
    const { attendee } = await createTestAttendeeDirect(
      listingId,
      "Unconfigured Buyer",
      "unconfigured-buyer@example.com",
    );
    await queueRegistrationEmails("cs_drain_unconfigured", attendee.id, [
      prepared("unconfigured-buyer@example.com"),
    ]);

    const result = await deliverDueRegistrationEmails();

    expect(result).toEqual({ failed: true, more: false });
    // No provider call was attempted without a config.
    expect(fetch.callCount()).toBe(0);
    expect(errorLog.contains("email is not configured")).toBe(true);
    await expectRowDue(attendee.id);
  });

  test("reports more work after filling the batch", async () => {
    await configureTestEmail();
    const { id: batchListingId } = await createTestListing({
      maxAttendees: 10,
    });
    for (let i = 0; i < 7; i++) {
      const address = `batch-buyer-${i}@example.com`;
      const { attendee } = await createTestAttendeeDirect(
        batchListingId,
        `Batch Buyer ${i}`,
        address,
      );
      await queueRegistrationEmails(`cs_drain_batch_${i}`, attendee.id, [
        prepared(address),
      ]);
    }

    const result = await deliverDueRegistrationEmails();

    expect(result).toEqual({ failed: false, more: true });
    // Exactly the batch size was sent; the seventh row is still due.
    expect(fetch.callCount()).toBe(6);
    const left = await queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM registration_email_work WHERE state = 'due'",
    );
    expect(left?.count).toBe(1);
  });
});
