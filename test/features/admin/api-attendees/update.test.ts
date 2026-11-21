import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { accountBalance, transfersByAccount } from "#accounting/queries.ts";
import { getAttendeeAnswersBatch } from "#db/questions/attendee-answers/reads.ts";
import { records } from "#db/record-table.ts";
import { settings } from "#db/settings.ts";
import { account } from "#shared/ledger/account.ts";
import { assignQuestion } from "#test/shared/db/questions/helpers.ts";
import {
  assertJson,
  expectApiError,
  expectListingActivityLogContains,
} from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
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

/** One update body, and what holds after it. */
type Step<Expected> = [body: Record<string, unknown>, expected: Expected];

/** Sends each step's body in turn, and hands the answered attendee and the
 *  step's expectation to `check`. */
const runSteps = async <Expected>(
  attendeeId: number,
  steps: Step<Expected>[],
  check: (
    attendee: Record<string, unknown>,
    expected: Expected,
  ) => void | Promise<void>,
): Promise<void> => {
  for (const [body, expected] of steps) {
    const updated = await assertJson(updateBooking(attendeeId, body), 200);
    await check(updated.attendee, expected);
  }
};

/** Expects the answered attendee to carry the given fields. */
const hasFields = (
  attendee: Record<string, unknown>,
  expected: Record<string, unknown>,
): void => {
  expect(attendee).toMatchObject(expected);
};

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

describeWithEnv(
  "Admin API - PUT /api/admin/attendees",
  { db: true, triggers: true },
  () => {
    test("updates the fields a body names and keeps the rest", async () => {
      const { attendeeId, listing } = await bookOne();
      const vip = await records.attendee_statuses.insert({ name: "VIP" });
      const steps: Step<Record<string, unknown>>[] = [
        [{ status: "VIP" }, { name: "Ada Lovelace", status_id: vip.id }],
        [
          { name: "Ada King", phone: "01234 567890" },
          { email: "ada@example.com", name: "Ada King", phone: "01234 567890" },
        ],
        // The same status again changes nothing and still answers.
        [{ status: "VIP" }, { name: "Ada King", status_id: vip.id }],
      ];
      await runSteps(attendeeId, steps, hasFields);
      await expectListingActivityLogContains(listing.id, "updated via API");
    });

    test("receipts post once, replay as no-ops, and never change", async () => {
      const delivery = { amount: 250, description: "Delivery" };
      const { attendeeId } = await bookOne({
        adjustments: [delivery],
        payments: [{ amount: 200 }],
      });
      // 500 sale, plus 250 delivery, less 200 paid.
      expect(await balanceOf(attendeeId)).toBe(-550);
      const steps: Step<number>[] = [
        [{ payments: [{ amount: 200 }, { amount: 100 }] }, 450],
        // An exact replay posts nothing.
        [{ payments: [{ amount: 200 }, { amount: 100 }] }, 450],
        [
          { adjustments: [delivery, { amount: -100, description: "Fee" }] },
          350,
        ],
      ];
      await runSteps(attendeeId, steps, async (attendee, owed) => {
        expect(attendee.remaining_balance).toBe(owed);
        expect(await balanceOf(attendeeId)).toBe(-owed);
      });
      expect((await paymentAmounts(attendeeId)).toSorted()).toEqual([100, 200]);

      await expectApiError(
        updateBooking(attendeeId, { payments: [{ amount: 250 }] }),
        400,
        "payments[0] is already recorded with a different amount",
      );
      expect(await balanceOf(attendeeId)).toBe(-350);
    });

    test("refuses a taxable adjustment and posts nothing", async () => {
      const { attendeeId } = await bookOne();
      await expectApiError(
        updateBooking(attendeeId, {
          adjustments: [
            { amount: 250, description: "Delivery", taxable: true },
          ],
        }),
        400,
        "adjustments[0].taxable only applies when a booking is created",
      );
      expect(await balanceOf(attendeeId)).toBe(-500);
    });

    test("lines change rows, add a listing, and drop an unnamed one", async () => {
      const { attendeeId, listing } = await bookOne();
      const other = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 3,
        name: "Other Fair",
        unitPrice: 300,
      });
      const first = { listingId: listing.id, quantity: 2 };
      const second = { listingId: other.id, quantity: 2 };
      // Each step names the lines, then which listings hold the attendee.
      const steps: Step<boolean[]>[] = [
        [{ lines: [first] }, [true, false]],
        [{ lines: [first, second] }, [true, true]],
        [{ lines: [second] }, [false, true]],
      ];
      await runSteps(attendeeId, steps, async (_attendee, expected) => {
        const held = await Promise.all(
          [listing.id, other.id].map(rosterAttendeeIds),
        );
        expect(held.map((ids) => ids.includes(attendeeId))).toEqual(expected);
      });
      // A line change moves no money.
      expect(await balanceOf(attendeeId)).toBe(-500);
    });

    test("a daily booking keeps its dates, then moves its row in place", async () => {
      const daily = await createTestListing({
        listingType: "daily",
        maxAttendees: 10,
        name: "Dated Update Fair",
      });
      const line = {
        date: "2026-08-14",
        durationDays: 2,
        listingId: daily.id,
        quantity: 1,
      };
      const created = await assertJson(
        createBooking(daily.id, { lines: [line] }),
        201,
      );
      const attendeeId = created.attendee.id as number;
      const moved = { ...line, date: "2026-08-20", durationDays: 3 };
      const steps: Step<Record<string, unknown>>[] = [
        [{ name: "Ada Dated" }, { date: "2026-08-14", end_date: "2026-08-16" }],
        [{ lines: [moved] }, { date: "2026-08-20", end_date: "2026-08-23" }],
      ];
      await runSteps(attendeeId, steps, hasFields);
      const rows = await rosterAttendeeIds(daily.id);
      expect(rows.filter((id) => id === attendeeId)).toHaveLength(1);
    });

    test("refuses a body field it cannot accept", async () => {
      const { attendeeId } = await bookOne();
      const refusals: Step<string>[] = [
        [{ status: "No such status" }, "Unknown status 'No such status'"],
        [{ status: 5 }, "status must be text"],
        [{ name: "" }, "name is required"],
        [
          { payments: [{ amount: -5 }] },
          "payments[0].amount must be a positive whole number of pence or cents",
        ],
        [
          { lines: [{ listingId: 987654, quantity: 1 }] },
          "lines[0] references an unknown listing",
        ],
        [{ lines: [] }, "Add at least one booking line"],
        [{ ticketToken: "other" }, "ticketToken cannot be changed"],
        [{ created: "2026-01-01T00:00:00Z" }, "created cannot be changed"],
      ];
      for (const [body, message] of refusals) {
        await expectApiError(updateBooking(attendeeId, body), 400, message);
      }
    });

    test("refuses an update the save cannot make", async () => {
      const booking = await subscribe("Ada", MONTHLY);
      const elsewhere = await createTestListing({
        maxAttendees: 10,
        name: "Elsewhere Fair",
      });
      await expectApiError(
        updateBooking(booking.attendeeId, {
          lines: [{ listingId: elsewhere.id, quantity: 1 }],
        }),
        400,
        "A line with a running subscription cannot be removed. Cancel the subscription first.",
      );
      expect(await rosterAttendeeIds(booking.listingId)).toContain(
        booking.attendeeId,
      );

      // A tax policy that changed since the booking needs the operator's say.
      const { attendeeId } = await bookOne();
      await settings.update.tax({
        mode: "add_to_total",
        rateBasisPoints: 2000,
      });
      await expectApiError(
        updateBooking(attendeeId, { name: "Ada Taxed" }),
        400,
        "The tax on this booking has changed. Confirm the new tax on the attendee page, then send the update again.",
      );
    });

    test("answers 404 for an attendee that does not exist", async () => {
      await expectApiError(
        updateBooking(987654, { name: "Nobody" }),
        404,
        "Attendee not found",
      );
    });

    test("stores the answers a body names and refuses a question it does not ask", async () => {
      const { attendeeId, listing } = await bookOne();
      const asked = await assignQuestion(listing.id, "Meal?", "Veggie");
      const answers = [
        { answerId: asked.answer.id, questionId: asked.question.id },
      ];
      await assertJson(updateBooking(attendeeId, { answers }), 200);
      const stored = await getAttendeeAnswersBatch([attendeeId], {
        privateKey: await getTestPrivateKey(),
        texts: true,
      });
      expect(stored.answerIds.get(attendeeId)).toEqual([asked.answer.id]);
      await expectApiError(
        updateBooking(attendeeId, {
          answers: [{ answerId: asked.answer.id, questionId: 987654 }],
        }),
        400,
        "answers[0] names a question this booking does not ask",
      );
    });
  },
);
