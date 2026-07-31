/** Payment repointing for the split attendee merge service test suite. */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { decryptWithOwnerKey } from "#shared/crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { execute, queryAll } from "#shared/db/client.ts";
import { createPaymentSession } from "#shared/db/payments/sessions.ts";
import { paymentSessionInput } from "#test/shared/db/payments/fixtures.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
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
    expect(await transfersByAccount(attendeeAccount(source.id))).toEqual([]);
    const targetTransfers = (
      await transfersByAccount(attendeeAccount(target.id))
    )
      .map(({ amount, destination, eventGroup, kind, reference, source }) => ({
        amount,
        destination,
        eventGroup,
        kind,
        reference,
        source,
      }))
      .sort((a, b) => a.reference.localeCompare(b.reference));
    expect(targetTransfers).toEqual([
      {
        amount: 5000,
        destination: attendeeAccount(target.id),
        eventGroup: "evt",
        kind: "payment",
        reference: "pay-evt",
        source: WORLD,
      },
      {
        amount: 5000,
        destination: revenueAccount(sourceListing.id),
        eventGroup: "evt",
        kind: "sale",
        reference: "sale-evt",
        source: attendeeAccount(target.id),
      },
    ]);
  });

  test("repoints the source's provider payment references onto the target", async () => {
    const { source, target } = await createMergePair();
    await createPaymentSession(paymentSessionInput("source-paid-session"));
    await execute("UPDATE payment_sessions SET attendee_id = ? WHERE id = ?", [
      source.id,
      "source-paid-session",
    ]);

    const { result } = await runMerge({ source, target });

    expect(result.success).toBe(true);
    const rows = await queryAll<{
      attendee_id: number;
      id: string;
    }>("SELECT attendee_id, id FROM payment_sessions WHERE id = ?", [
      "source-paid-session",
    ]);
    expect(rows).toEqual([
      { attendee_id: target.id, id: "source-paid-session" },
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
    const sessions = await queryAll<{ attendee_id: number; id: string }>(
      `SELECT id, attendee_id FROM payment_sessions
        WHERE id = ?`,
      [`legacy:attendee:${source.id}`],
    );
    expect(sessions).toEqual([
      {
        attendee_id: target.id,
        id: `legacy:attendee:${source.id}`,
      },
    ]);
    const charges = await queryAll<{
      legacy_source: string;
      provider_reference: OwnerKeyEncrypted;
    }>(
      `SELECT provider_reference, legacy_source FROM payment_charges
        WHERE payment_id = ?`,
      [`legacy:attendee:${source.id}`],
    );
    expect(charges.map((charge) => charge.legacy_source)).toEqual([
      "attendee_merge",
    ]);
    expect(
      await decryptWithOwnerKey(
        charges[0]!.provider_reference,
        await getTestPrivateKey(),
      ),
    ).toBe("pi_source_legacy");
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
    const sourceResult = await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: member.id, packageGroupId: group.id }],
      email: "bob@test.com",
      name: "Bob",
    });
    if (!sourceResult.success) throw new Error("source booking failed");
    const source = sourceResult.attendees[0]!;

    const { result } = await runMerge({ source, target });

    expect(result.success).toBe(true);
    const moved = (await getBookings(target.id))
      .filter(({ listing_id }) => listing_id === member.id)
      .map(({ listing_id, package_group_id }) => ({
        listingId: listing_id,
        packageGroupId: package_group_id,
      }));
    expect(moved).toEqual([{ listingId: member.id, packageGroupId: group.id }]);
  });
});
