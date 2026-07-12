import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { createAttendeeAtomic } from "#shared/db/attendees/api.ts";
import { queryAll } from "#shared/db/client.ts";
import { getRefundPaymentReferences } from "#shared/db/payment-references.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { finalizeTestPaymentSession as finalizeSession } from "#test-utils/db-helpers/processed-payments.ts";
import {
  createAttendee,
  getBookings,
  postPaidSale,
  runMerge,
} from "./helpers.ts";

const createMergePair = async () => {
  const targetListing = await createTestListing({ maxAttendees: 10 });
  const sourceListing = await createTestListing({ maxAttendees: 10 });
  return {
    source: await createAttendee(sourceListing.id, "Bob", "bob@test.com"),
    sourceListing,
    target: await createAttendee(targetListing.id, "Alice", "alice@test.com"),
  };
};

describeWithEnv("attendee merge service", { db: true }, () => {
  test("repoints the source's ledger rows onto the target", async () => {
    const { source, sourceListing, target } = await createMergePair();

    // A paid booking on the source attendee, recorded in the ledger.
    await postPaidSale({
      attendeeId: source.id,
      eventGroup: "evt",
      listingId: sourceListing.id,
    });

    const { result } = await runMerge({ source, target });

    expect(result.success).toBe(true);
    // The source's legs now belong to the target; nothing strands on the
    // deleted source attendee.
    expect((await transfersByAccount(attendeeAccount(source.id))).length).toBe(
      0,
    );
    expect((await transfersByAccount(attendeeAccount(target.id))).length).toBe(
      2,
    );
  });

  test("repoints the source's provider payment references onto the target", async () => {
    const { source, target } = await createMergePair();
    await reserveSession("source-paid-session");
    await finalizeSession(
      "source-paid-session",
      source.id,
      [],
      "pi_source_paid",
    );

    const { result } = await runMerge({ source, target });

    expect(result.success).toBe(true);
    const rows = await queryAll<{
      attendee_id: number;
      payment_session_id: string;
    }>(
      `SELECT attendee_id, payment_session_id
         FROM processed_payments
        WHERE payment_session_id = ?`,
      ["source-paid-session"],
    );
    expect(rows).toEqual([
      { attendee_id: target.id, payment_session_id: "source-paid-session" },
    ]);
  });

  test("preserves the source's legacy payment ID on the target", async () => {
    const { source, target } = await createMergePair();
    const sourceWithLegacyPayment = {
      ...source,
      payment_id: "pi_source_legacy",
    };

    const { result } = await runMerge({
      source: sourceWithLegacyPayment,
      target,
    });

    expect(result.success).toBe(true);
    const references = await getRefundPaymentReferences(
      [{ id: target.id, payment_id: "" }],
      await getTestPrivateKey(),
    );
    expect(references.get(target.id)).toEqual([
      {
        providerRefunded: false,
        reference: "pi_source_legacy",
        sessionIds: [],
      },
    ]);
  });

  test("preserves package_group_id when moving a source package booking", async () => {
    const group = await createTestGroup({ isPackage: true, name: "MergePkg" });
    const targetListing = await createTestListing({ maxAttendees: 10 });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
    });
    const target = await createAttendee(
      targetListing.id,
      "Alice",
      "alice@test.com",
    );
    const sourceResult = await createAttendeeAtomic({
      bookings: [{ listingId: member.id, packageGroupId: group.id }],
      email: "bob@test.com",
      name: "Bob",
    });
    if (!sourceResult.success) throw new Error("source booking failed");
    const source = sourceResult.attendees[0]!;

    const { result } = await runMerge({ source, target });

    expect(result.success).toBe(true);
    // The moved package booking keeps its group, so the merged attendee's
    // ticket still renders/hides as the package rather than a bare listing.
    const moved = (await getBookings(target.id)).find(
      (b) => b.listing_id === member.id,
    );
    expect(moved?.package_group_id).toBe(group.id);
  });
});
