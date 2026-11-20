import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { accountBalance, transfersByAccount } from "#accounting/queries.ts";
import { records } from "#db/record-table.ts";
import { settings } from "#db/settings.ts";
import { account } from "#shared/ledger/account.ts";
import {
  assertJson,
  expectApiError,
  expectListingActivityLogContains,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createBooking,
  rosterAttendeeIds,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { MONTHLY, subscribe } from "#test-utils/db-helpers/subscriptions.ts";
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

  test("refuses a status that is not text", async () => {
    const { attendeeId } = await bookOne();
    await expectApiError(
      updateBooking(attendeeId, { status: 5 }),
      400,
      "status must be text",
    );
  });

  test("refuses a contact field the create would refuse", async () => {
    const { attendeeId } = await bookOne();
    await expectApiError(
      updateBooking(attendeeId, { name: "" }),
      400,
      "name is required",
    );
  });

  test("refuses a payment that is not a positive amount", async () => {
    const { attendeeId } = await bookOne();
    await expectApiError(
      updateBooking(attendeeId, { payments: [{ amount: -5 }] }),
      400,
      "payments[0].amount must be a positive whole number of pence or cents",
    );
  });

  test("refuses a line for a listing that does not exist", async () => {
    const { attendeeId } = await bookOne();
    await expectApiError(
      updateBooking(attendeeId, {
        lines: [{ listingId: 987654, quantity: 1 }],
      }),
      400,
      "lines[0] references an unknown listing",
    );
  });

  test("adds a line for another listing and drops a line it leaves out", async () => {
    const { attendeeId, listing } = await bookOne();
    const other = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 3,
      name: "Other Fair",
      unitPrice: 300,
    });

    await assertJson(
      updateBooking(attendeeId, {
        lines: [
          { listingId: listing.id, quantity: 1 },
          { listingId: other.id, quantity: 2 },
        ],
      }),
      200,
    );
    expect(await rosterAttendeeIds(listing.id)).toContain(attendeeId);
    expect(await rosterAttendeeIds(other.id)).toContain(attendeeId);

    await assertJson(
      updateBooking(attendeeId, {
        lines: [{ listingId: other.id, quantity: 2 }],
      }),
      200,
    );
    expect(await rosterAttendeeIds(listing.id)).not.toContain(attendeeId);
    expect(await rosterAttendeeIds(other.id)).toContain(attendeeId);
  });

  test("a daily booking keeps its dates when the body names no lines", async () => {
    const daily = await createTestListing({
      listingType: "daily",
      maxAttendees: 10,
      name: "Dated Update Fair",
    });
    const created = await assertJson(
      createBooking(daily.id, {
        lines: [
          {
            date: "2026-08-14",
            durationDays: 2,
            listingId: daily.id,
            quantity: 1,
          },
        ],
      }),
      201,
    );
    const updated = await assertJson(
      updateBooking(created.attendee.id, { name: "Ada Dated" }),
      200,
    );
    expect(updated.attendee).toMatchObject({
      date: "2026-08-14",
      end_date: "2026-08-16",
      name: "Ada Dated",
    });
  });

  test("a daily line that moves day changes its row in place", async () => {
    const daily = await createTestListing({
      listingType: "daily",
      maxAttendees: 10,
      name: "Moving Fair",
    });
    const created = await assertJson(
      createBooking(daily.id, {
        lines: [{ date: "2026-08-14", listingId: daily.id, quantity: 1 }],
      }),
      201,
    );
    const attendeeId = created.attendee.id as number;

    const moved = await assertJson(
      updateBooking(attendeeId, {
        lines: [
          {
            date: "2026-08-20",
            durationDays: 3,
            listingId: daily.id,
            quantity: 1,
          },
        ],
      }),
      200,
    );
    expect(moved.attendee).toMatchObject({
      date: "2026-08-20",
      end_date: "2026-08-23",
    });
    const rows = (await rosterAttendeeIds(daily.id)).filter(
      (id) => id === attendeeId,
    );
    expect(rows).toHaveLength(1);
  });

  test("refuses to drop a line that holds a running subscription", async () => {
    const booking = await subscribe("Ada", MONTHLY);
    const other = await createTestListing({
      maxAttendees: 10,
      name: "Elsewhere Fair",
    });
    await expectApiError(
      updateBooking(booking.attendeeId, {
        lines: [{ listingId: other.id, quantity: 1 }],
      }),
      400,
      "A line with a running subscription cannot be removed. Cancel the subscription first.",
    );
    expect(await rosterAttendeeIds(booking.listingId)).toContain(
      booking.attendeeId,
    );
  });

  test("refuses an update that would change the booking's tax", async () => {
    const { attendeeId } = await bookOne();
    await settings.update.tax({ mode: "add_to_total", rateBasisPoints: 2000 });
    await expectApiError(
      updateBooking(attendeeId, { name: "Ada Taxed" }),
      400,
      "The tax on this booking has changed. Confirm the new tax on the attendee page, then send the update again.",
    );
  });
});
