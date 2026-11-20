import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { accountBalance, transfersByAccount } from "#accounting/queries.ts";
import { records } from "#db/record-table.ts";
import { account } from "#shared/ledger/account.ts";
import {
  assertJson,
  expectApiError,
  expectListingActivityLogContains,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createBooking } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { apiRequest } from "#test-utils/session.ts";

/** One PUT update request for an attendee. */
const updateBooking = (
  attendeeId: number,
  body: Record<string, unknown>,
): Promise<Response> =>
  apiRequest(`/api/admin/attendees/${attendeeId}`, { body, method: "PUT" });

/** A booked attendee: a 500 listing, one ticket, and the given create body. */
const bookOne = async (body: Record<string, unknown> = {}) => {
  const listing = await createTestListing({
    maxAttendees: 10,
    maxQuantity: 3,
    name: "Update Fair",
    unitPrice: 500,
  });
  const created = await assertJson(createBooking(listing.id, body), 201);
  return { attendeeId: created.attendee.id as number, listing };
};

/** The amounts of the payment legs an attendee's account holds. */
const paymentAmounts = async (attendeeId: number): Promise<number[]> => {
  const legs = await transfersByAccount(account("attendee", attendeeId));
  const payments = legs.filter((leg) => leg.kind === "payment");
  return payments.map((leg) => leg.amount);
};

/** What the attendee owes, read from the ledger as a negative balance. */
const balanceOf = (attendeeId: number): Promise<number> =>
  accountBalance(account("attendee", attendeeId));

describeWithEnv("Admin API - PUT /api/admin/attendees", { db: true }, () => {
  test("changes the status by name and leaves the other fields alone", async () => {
    const { attendeeId, listing } = await bookOne();
    const vip = await records.attendee_statuses.insert({ name: "VIP" });

    const first = await assertJson(
      updateBooking(attendeeId, { status: "VIP" }),
      200,
    );
    expect(first.attendee).toMatchObject({
      email: "ada@example.com",
      id: attendeeId,
      name: "Ada Lovelace",
      quantity: 1,
      status_id: vip.id,
    });
    await expectListingActivityLogContains(listing.id, "updated via API");

    // The same update again changes nothing and still answers.
    const again = await assertJson(
      updateBooking(attendeeId, { status: "VIP" }),
      200,
    );
    expect(again.attendee.status_id).toBe(vip.id);
  });

  test("refuses an unknown status", async () => {
    const { attendeeId } = await bookOne();
    await expectApiError(
      updateBooking(attendeeId, { status: "No such status" }),
      400,
      "Unknown status 'No such status'",
    );
  });

  test("changes the contact fields it names and keeps the rest", async () => {
    const { attendeeId } = await bookOne();
    const updated = await assertJson(
      updateBooking(attendeeId, { name: "Ada King", phone: "01234 567890" }),
      200,
    );
    expect(updated.attendee).toMatchObject({
      email: "ada@example.com",
      name: "Ada King",
      phone: "01234 567890",
    });
  });

  test("a payment added to the list posts once and moves the balance", async () => {
    const { attendeeId } = await bookOne({ payments: [{ amount: 200 }] });
    expect(await balanceOf(attendeeId)).toBe(-300);
    const payments = [{ amount: 200 }, { amount: 100 }];

    const added = await assertJson(
      updateBooking(attendeeId, { payments }),
      200,
    );
    expect(added.attendee.remaining_balance).toBe(200);
    expect(await balanceOf(attendeeId)).toBe(-200);
    expect((await paymentAmounts(attendeeId)).toSorted()).toEqual([100, 200]);

    // An exact replay posts nothing.
    const replay = await assertJson(
      updateBooking(attendeeId, { payments }),
      200,
    );
    expect(replay.attendee.remaining_balance).toBe(200);
    expect(await balanceOf(attendeeId)).toBe(-200);
    expect(await paymentAmounts(attendeeId)).toHaveLength(2);
  });

  test("a payment already stored with a different amount is refused", async () => {
    const { attendeeId } = await bookOne({ payments: [{ amount: 200 }] });
    await expectApiError(
      updateBooking(attendeeId, { payments: [{ amount: 250 }] }),
      400,
      "payments[0] is already recorded with a different amount",
    );
    // Nothing moved.
    expect(await balanceOf(attendeeId)).toBe(-300);
    expect(await paymentAmounts(attendeeId)).toEqual([200]);
  });

  test("a payment sent to a payment-free booking posts one leg", async () => {
    const { attendeeId } = await bookOne();
    const updated = await assertJson(
      updateBooking(attendeeId, { payments: [{ amount: 500 }] }),
      200,
    );
    expect(updated.attendee.remaining_balance).toBe(0);
    expect(await paymentAmounts(attendeeId)).toEqual([500]);
  });

  test("named adjustments replay as the create's do and a new one adds", async () => {
    const { attendeeId } = await bookOne({
      adjustments: [{ amount: 250, description: "Delivery" }],
    });
    expect(await balanceOf(attendeeId)).toBe(-750);

    const adjustments = [
      { amount: 250, description: "Delivery" },
      { amount: -100, description: "Loyalty" },
    ];
    const updated = await assertJson(
      updateBooking(attendeeId, { adjustments }),
      200,
    );
    expect(updated.attendee.remaining_balance).toBe(650);
    expect(await balanceOf(attendeeId)).toBe(-650);
  });

  test("a line change moves the row and leaves the ledger alone", async () => {
    const { attendeeId, listing } = await bookOne();
    const updated = await assertJson(
      updateBooking(attendeeId, {
        lines: [{ listingId: listing.id, quantity: 2 }],
      }),
      200,
    );
    expect(updated.attendee.quantity).toBe(2);
    expect(await balanceOf(attendeeId)).toBe(-500);
  });

  test("a body with no lines keeps the stored lines", async () => {
    const { attendeeId } = await bookOne();
    const updated = await assertJson(
      updateBooking(attendeeId, { name: "Ada" }),
      200,
    );
    expect(updated.attendee).toMatchObject({ name: "Ada", quantity: 1 });
  });

  test("refuses lines that are not a non-empty array", async () => {
    const { attendeeId } = await bookOne();
    await expectApiError(
      updateBooking(attendeeId, { lines: [] }),
      400,
      "Add at least one booking line",
    );
  });

  test("never changes the ticket token or the created time", async () => {
    const { attendeeId } = await bookOne();
    await expectApiError(
      updateBooking(attendeeId, { ticketToken: "other" }),
      400,
      "ticketToken cannot be changed",
    );
    await expectApiError(
      updateBooking(attendeeId, { created: "2026-01-01T00:00:00Z" }),
      400,
      "created cannot be changed",
    );
  });

  test("answers 404 for an attendee that does not exist", async () => {
    await expectApiError(
      updateBooking(987654, { name: "Nobody" }),
      404,
      "Attendee not found",
    );
  });
});
