import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { accountBalance, transfersByAccount } from "#accounting/queries.ts";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { PENDING_NOTIFICATION } from "#db/attendees/notification-flags.ts";
import { getAttendeeRaw } from "#db/attendees/queries.ts";
import { account } from "#shared/ledger/account.ts";
import {
  assertJson,
  expectListingActivityLogContains,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  attendeeExists,
  createBooking,
  readPendingNotificationFlags,
  rosterAttendeeIds,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withExpectedError, withMocks } from "#test-utils/mocks.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - POST /api/admin/attendees", { db: true }, () => {
  test("creates a booking whose PII is encrypted at rest and reads back", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Falcon Fair",
      unitPrice: 500,
    });

    const created = await assertJson(
      createBooking(listing.id, {
        address: "1 Fair Lane",
        phone: "01234 567890",
        special_instructions: "Late arrival",
      }),
      201,
      (body) => {
        expect(body.attendee).toMatchObject({
          address: "1 Fair Lane",
          email: "ada@example.com",
          listing_id: listing.id,
          name: "Ada Lovelace",
          phone: "01234 567890",
          quantity: 1,
          special_instructions: "Late arrival",
        });
        expect(body.attendee.id).toBeGreaterThan(0);
        // The answer never leaks the sealed blob or its blind index.
        expect(body.attendee.pii_blob).toBeUndefined();
        expect(body.attendee.ticket_token_index).toBeUndefined();
      },
    );
    const attendeeId = created.attendee.id as number;
    expect(await attendeeExists(attendeeId)).toBe(true);

    // At rest the PII is ciphertext, never the plaintext name.
    const stored = await getAttendeeRaw(attendeeId);
    expect(stored).not.toBeNull();
    expect(stored!.pii_blob).not.toContain("Ada Lovelace");

    // The admin roster endpoint decrypts the booking back.
    expect(await rosterAttendeeIds(listing.id)).toContain(attendeeId);
    await expectListingActivityLogContains(listing.id, "added via API");
  });

  test("the booking's gross lands in the ledger and on the row", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 2,
      name: "Ledger Fair",
      unitPrice: 500,
    });
    const created = await assertJson(
      createBooking(listing.id, {
        lines: [{ listingId: listing.id, quantity: 2 }],
        name: "Ledger Person",
      }),
      201,
      (body) => expect(body.attendee.remaining_balance).toBe(1000),
    );
    // The gross `sale` leg makes the attendee owe exactly the lines' cost,
    // the same money shape a manual add leaves.
    expect(
      await accountBalance(account("attendee", created.attendee.id as number)),
    ).toBe(-1000);
  });

  test("books lines at an agreed per-line price, posting the sale at that amount", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 2,
      name: "Deal Fair",
      unitPrice: 500,
    });
    const created = await assertJson(
      createBooking(listing.id, {
        lines: [{ listingId: listing.id, price: 400, quantity: 2 }],
        name: "Deal Buyer",
      }),
      201,
      (body) => expect(body.attendee.remaining_balance).toBe(800),
    );
    // The sale leg is at the agreed 400/unit (800 total), never the 500 list
    // price, and the per-row price_paid projects it back.
    expect(
      await accountBalance(account("attendee", created.attendee.id as number)),
    ).toBe(-800);
    const roster = await assertJson(
      apiRequest(`/api/admin/listings/${listing.id}/attendees`),
      200,
    );
    const row = roster.attendees.find(
      (candidate: { id: number }) => candidate.id === created.attendee.id,
    ) as { price_paid: string };
    expect(Number(row.price_paid)).toBe(800);
  });

  test("records payments received at create time against the balance", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 2,
      name: "Paid Fair",
      unitPrice: 500,
    });
    const created = await assertJson(
      createBooking(listing.id, {
        lines: [{ listingId: listing.id, quantity: 2 }],
        name: "Paid Buyer",
        payments: [{ amount: 800 }],
      }),
      201,
      (body) => expect(body.attendee.remaining_balance).toBe(200),
    );
    // The 800 payment leg lands in the same event: the attendee owes only
    // what the 1000 sale left after the cash came in.
    expect(
      await accountBalance(account("attendee", created.attendee.id as number)),
    ).toBe(-200);
    const legs = await transfersByAccount(
      account("attendee", created.attendee.id as number),
    );
    expect(
      legs
        .filter((leg) => leg.kind === "payment")
        .reduce((total, leg) => total + leg.amount, 0),
    ).toBe(800);
  });

  test("records named adjustments: a charge adds to the balance, a writeoff reduces it", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Adjust Fair",
      unitPrice: 500,
    });
    const created = await assertJson(
      createBooking(listing.id, {
        adjustments: [
          { amount: 250, description: "Delivery" },
          { amount: -100, description: "Loyalty" },
        ],
        name: "Adjust Buyer",
      }),
      201,
      (body) => expect(body.attendee.remaining_balance).toBe(650),
    );
    // The 500 sale plus the 250 charge minus the 100 writeoff is what is owed.
    expect(
      await accountBalance(account("attendee", created.attendee.id as number)),
    ).toBe(-650);
    // The charge posts the manual attendee charge contra shape (attendee to
    // writeoff); the writeoff the reverse.
    const legs = await transfersByAccount(
      account("attendee", created.attendee.id as number),
    );
    const charge = legs.find((leg) => leg.kind === "manual_attendee_charge");
    const writeoff = legs.find(
      (leg) => leg.kind === "manual_attendee_writeoff",
    );
    expect(charge).toBeDefined();
    expect(charge!.amount).toBe(250);
    expect(charge!.destination.type).toBe("writeoff");
    expect(writeoff).toBeDefined();
    expect(writeoff!.amount).toBe(100);
    expect(writeoff!.source.type).toBe("writeoff");
  });

  test("combined custom price, payment and adjustment leave the exact balance", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 2,
      name: "All Fair",
      unitPrice: 500,
    });
    const created = await assertJson(
      createBooking(listing.id, {
        adjustments: [{ amount: 100, description: "Delivery" }],
        lines: [{ listingId: listing.id, price: 400, quantity: 2 }],
        name: "All Buyer",
        payments: [{ amount: 600 }],
      }),
      201,
      // 800 gross - 600 paid + 100 delivery = 300 owed.
      (body) => expect(body.attendee.remaining_balance).toBe(300),
    );
    expect(
      await accountBalance(account("attendee", created.attendee.id as number)),
    ).toBe(-300);
  });

  test("never sends the buyer email; the owed-email flag matches a manual add", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Email Fair",
      unitPrice: 400,
    });
    const created = await assertJson(
      createBooking(listing.id, { email: "buyer@example.com" }),
      201,
    );
    const flags = await readPendingNotificationFlags(created.attendee.id);
    // The flag stays UP as "added by an admin": the email is owed, not sent.
    expect(flags.email).toBe(PENDING_NOTIFICATION.admin);
    expect(flags.webhooks).toBe(PENDING_NOTIFICATION.none);
  });

  test("a booking on a listing that collects no email owes no email", async () => {
    const listing = await createTestListing({
      fields: "",
      maxAttendees: 10,
      name: "No Email Fair",
    });
    const created = await assertJson(createBooking(listing.id), 201);
    const flags = await readPendingNotificationFlags(created.attendee.id);
    expect(flags.email).toBe(PENDING_NOTIFICATION.none);
  });

  test("a retry with the same ticketToken returns the same booking without duplicating", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Idempotent Fair",
    });
    const body = {
      email: "again@example.com",
      lines: [{ listingId: listing.id, quantity: 1 }],
      name: "Retry Person",
      ticketToken: "stable-token-1",
    };
    const first = await assertJson(
      apiRequest("/api/admin/attendees", { body, method: "POST" }),
      201,
    );
    const retried = await assertJson(
      apiRequest("/api/admin/attendees", { body, method: "POST" }),
      200,
    );
    expect(retried.attendee.id).toBe(first.attendee.id);

    const fresh = await assertJson(
      apiRequest("/api/admin/attendees", {
        body: { ...body, ticketToken: "stable-token-2" },
        method: "POST",
      }),
      201,
    );
    expect(fresh.attendee.id).not.toBe(first.attendee.id);
    expect(await rosterAttendeeIds(listing.id)).toHaveLength(2);
  });

  test("a create that loses a token race answers with the winner's booking", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Race Fair",
      unitPrice: 500,
    });
    const body = {
      email: "loser@example.com",
      lines: [{ listingId: listing.id, quantity: 1 }],
      name: "Loser",
      ticketToken: "race-token-1",
    };
    const realCreate = attendeesApi.createAttendeeAtomic;
    await withMocks(
      () =>
        stub(attendeesApi, "createAttendeeAtomic", async (input, work) => {
          // The concurrent winner commits under the same token before the
          // loser's insert runs, so the loser's create hits the unique token
          // index exactly as a real race does.
          await realCreate({ ...input, name: "Winner" }, work);
          return realCreate(input, work);
        }),
      async () => {
        await assertJson(
          apiRequest("/api/admin/attendees", { body, method: "POST" }),
          200,
          (parsed) => expect(parsed.attendee.name).toBe("Winner"),
        );
        // The loser stored nothing: the booking exists once.
        expect(await rosterAttendeeIds(listing.id)).toHaveLength(1);
      },
    );
  });

  test("a create that fails without a stored token keeps failing loudly", async () => {
    const listing = await createTestListing({ name: "Loud Fail Fair" });
    await withExpectedError(async () => {
      await withMocks(
        () =>
          stub(attendeesApi, "createAttendeeAtomic", () =>
            Promise.reject(new Error("create exploded")),
          ),
        async () => {
          // A retry token whose booking was never stored is no answer: the
          // failure stays a failure.
          const withToken = await apiRequest("/api/admin/attendees", {
            body: {
              email: "boom@example.com",
              lines: [{ listingId: listing.id, quantity: 1 }],
              name: "Boom",
              ticketToken: "boom-token-1",
            },
            method: "POST",
          });
          expect(withToken.status).toBe(503);
          // The same failure without a retry token fails the same way.
          const withoutToken = await apiRequest("/api/admin/attendees", {
            body: {
              email: "boom@example.com",
              lines: [{ listingId: listing.id, quantity: 1 }],
              name: "Boom",
            },
            method: "POST",
          });
          expect(withoutToken.status).toBe(503);
        },
      );
    });
  });

  test("a body with no lines fails with a 400", async () => {
    const listing = await createTestListing({ name: "Empty Fair" });
    await assertJson(createBooking(listing.id, { lines: [] }), 400, (body) =>
      expect(body.error).toBe("Add at least one booking line"),
    );
  });

  test("resolves status by name and refuses an unknown status", async () => {
    const listing = await createTestListing({ name: "Status Fair" });
    const vip = await attendeeStatuses.table.insert({ name: "VIP" });
    const created = await assertJson(
      createBooking(listing.id, { name: "VIP Buyer", status: "VIP" }),
      201,
    );
    expect(created.attendee.status_id).toBe(vip.id);
    await assertJson(
      createBooking(listing.id, { name: "Lost", status: "No such status" }),
      400,
      (body) => expect(body.error).toBe("Unknown status 'No such status'"),
    );
  });

  test("refuses an unknown listing, an undated daily booking, and a missing name", async () => {
    await assertJson(createBooking(99999, { name: "Lost" }), 400, (body) =>
      expect(body.error).toBe("lines[0] references an unknown listing"),
    );

    const daily = await createTestListing({
      listingType: "daily",
      maxAttendees: 10,
      name: "Daily Fair",
    });
    await assertJson(
      createBooking(daily.id, { name: "Undated" }),
      400,
      (body) =>
        expect(body.error).toBe(
          "lines[0].date must be a booking day as YYYY-MM-DD",
        ),
    );

    await assertJson(
      apiRequest("/api/admin/attendees", {
        body: {
          lines: [{ date: "2026-08-14", listingId: daily.id, quantity: 1 }],
        },
        method: "POST",
      }),
      400,
      (body) => expect(body.error).toBe("name is required"),
    );
  });

  test("an API-created booking may overbook, like a manual admin add", async () => {
    const listing = await createTestListing({
      maxAttendees: 1,
      maxQuantity: 2,
      name: "Overbook Fair",
    });
    await assertJson(
      createBooking(listing.id, {
        lines: [{ listingId: listing.id, quantity: 2 }],
        name: "Overbooker",
      }),
      201,
    );
  });

  test("books a daily listing on its date, with and without a day count", async () => {
    const listing = await createTestListing({
      listingType: "daily",
      maxAttendees: 10,
      name: "Dated Fair",
    });
    await assertJson(
      createBooking(listing.id, {
        lines: [
          {
            date: "2026-08-14",
            durationDays: 2,
            listingId: listing.id,
            quantity: 1,
          },
        ],
      }),
      201,
      (body) => {
        expect(body.attendee).toMatchObject({
          date: "2026-08-14",
          // Two days booked: the stay ends two days after it starts.
          end_date: "2026-08-16",
          listing_id: listing.id,
          quantity: 1,
        });
      },
    );
    // A daily booking without a day count defaults to one day.
    await assertJson(
      createBooking(listing.id, {
        lines: [{ date: "2026-08-15", listingId: listing.id, quantity: 1 }],
        name: "Single Day",
      }),
      201,
      (body) => expect(body.attendee.date).toBe("2026-08-15"),
    );
  });

  test("refuses two lines that book the same slot", async () => {
    const listing = await createTestListing({ name: "Dup Fair" });
    await assertJson(
      createBooking(listing.id, {
        lines: [
          { listingId: listing.id, quantity: 1 },
          { listingId: listing.id, quantity: 1 },
        ],
      }),
      400,
      (body) => expect(body.error).toBe("Two lines book the same slot"),
    );
  });
});
