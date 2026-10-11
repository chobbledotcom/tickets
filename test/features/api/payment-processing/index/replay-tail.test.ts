import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { logActivities } from "#db/activity-log.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { execute, getDb } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import type { ValidatedSession } from "#routes/api/webhook-types.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { withRejectedAnswerWrite } from "#test-utils/atomic-booking.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { useFetchStub } from "#test-utils/mocks.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { checkoutWithTypedAnswer } from "./helpers.ts";

describeWithEnv(
  "a paid redelivery resuming its booking's missing tail",
  { db: true },
  () => {
    const fetch = useFetchStub();

    /** The issue's first delivery: the booking and its session finalize, then
     * the tail's answer save dies on a database error. The webhook answers
     * nothing usable and the provider redelivers. */
    const deliverWithFailingTail = async (
      id: string,
      data: ValidatedSession,
    ): Promise<void> => {
      await withRejectedAnswerWrite(() =>
        expect(processPaymentSession(id, data)).rejects.toThrow(
          "unexpected answer write",
        ),
      );
    };

    /** Redeliver the session, and expect the replay to answer success. */
    const redeliver = async (
      id: string,
      data: ValidatedSession,
    ): Promise<void> => {
      await withRequestContext(async () => {
        expect((await processPaymentSession(id, data)).success).toBe(true);
      });
    };

    /** A checkout with a choice answer and staged free text, set up for the
     * resume tests: the buyer's emails configured, the booked listing
     * named. */
    const answeredCheckout = async (id: string) => {
      const {
        answer: createdAnswer,
        data,
        listing,
      } = await checkoutWithTypedAnswer(id, { withChoiceAnswer: true });
      assert(createdAnswer !== null, "the fixture built no choice answer");
      await configureTestEmail();
      const listingName = (await getListingWithCount(listing.id))!.name;
      return { answer: createdAnswer, data, listing, listingName };
    };

    /** The saved answer rows of one attendee, choice rows first: the text
     * rows carry a null answer_id, and row order without ORDER BY is not
     * stable across scans. */
    const savedAnswerIds = async (attendeeId: number): Promise<unknown[]> =>
      (
        await getDb().execute({
          args: [attendeeId],
          sql: "SELECT answer_id FROM attendee_answers WHERE attendee_id = ? ORDER BY answer_id IS NULL, answer_id",
        })
      ).rows.map((row) => row.answer_id);

    /** The booking's registration lines in the activity log. The log is kept
     * encrypted, so this reads it back the way the owner's log page does. */
    const registrationLines = async (
      attendeeId: number,
      listingName: string,
    ): Promise<unknown> =>
      (await getAllActivityLog()).filter(
        (entry) =>
          entry.attendee_id === attendeeId &&
          entry.message === `Attendee registered for '${listingName}'`,
      ).length;

    test("resumes the answers and notification a failed tail left behind", async () => {
      const id = "cs_replay_tail_conflict";
      const { answer, data, listing, listingName } = await answeredCheckout(id);

      await deliverWithFailingTail(id, data);
      const attendeeId = (await getAttendeesRaw(listing.id))[0]!.id;
      // Booked and finalized, but the tail never ran.
      expect((await getProcessedPayment(id))?.attendee_id).toBe(attendeeId);
      expect(await savedAnswerIds(attendeeId)).toEqual([]);
      expect(await registrationLines(attendeeId, listingName)).toBe(0);

      // The redelivery resumes the tail instead of answering bare success.
      await redeliver(id, data);
      // Choice row first; the taken free text binds its string, so its
      // answer_id is null.
      expect(await savedAnswerIds(attendeeId)).toEqual([answer.id, null]);
      expect(await registrationLines(attendeeId, listingName)).toBe(1);
      // The resumed notification queues the buyer's confirmation.
      expect(fetch.getFetchJsonBody()).toMatchObject({
        to: ["buyer@example.com"],
      });

      // A further redelivery runs the notification once, never again.
      const callsAfterResume = fetch.callCount();
      await redeliver(id, data);
      expect(fetch.callCount()).toBe(callsAfterResume);
      expect(await registrationLines(attendeeId, listingName)).toBe(1);
    });

    test("resumes through the durable ledger when the reservation row is lost", async () => {
      const id = "cs_replay_tail_ledger";
      const { answer, data, listing, listingName } = await answeredCheckout(id);
      using errors = spy(console, "error");

      await deliverWithFailingTail(id, data);
      const attendeeId = (await getAttendeesRaw(listing.id))[0]!.id;
      // The reservation row is gone the way a pruned one would be, and it
      // took the session's stored ticket token with it.
      await execute(
        "DELETE FROM processed_payments WHERE payment_session_id = ?",
        [id],
      );

      await redeliver(id, data);
      // The answers are the durable half of the tail, so the resume lands
      // them: the choice row and the free-text row (its answer_id is null).
      // The notification defers to the admin re-send, because its
      // check-in links need the token the pruned row sealed, and it says so
      // loudly instead of sending an email no scan can open.
      expect(await savedAnswerIds(attendeeId)).toEqual([answer.id, null]);
      expect(await registrationLines(attendeeId, listingName)).toBe(0);
      expect(fetch.callCount()).toBe(0);
      expect(
        errors.calls.some((call) =>
          String(call.args[0]).includes("owes its registration notification"),
        ),
      ).toBe(true);
    });

    test("takes a redelivered checkout's staged answers into its email", async () => {
      const id = "cs_replay_tail_staged";
      const { answer, data, listing } = await answeredCheckout(id);

      // The tail dies before the take, so the staged row survives for the
      // resume, the way the issue's transient failure leaves it.
      await deliverWithFailingTail(id, data);

      await redeliver(id, data);
      // The choice answer and the taken free text land as two rows: the
      // text row binds its interned string, so its answer_id is null.
      const attendeeId = (await getAttendeesRaw(listing.id))[0]!.id;
      expect(await savedAnswerIds(attendeeId)).toEqual([answer.id, null]);
      const body = fetch.getFetchJsonBody();
      expect(body.text).toContain("Arriving late");
    });

    test("resumes despite other activity rows for the attendee", async () => {
      const id = "cs_replay_tail_move_line";
      const { answer, data, listing, listingName } = await answeredCheckout(id);

      // The tail's answer save died, and a door move logged its own
      // activity row before the redelivery. The move proves nothing about
      // the tail, so the resume still runs.
      await deliverWithFailingTail(id, data);
      const attendeeId = (await getAttendeesRaw(listing.id))[0]!.id;
      await logActivities([
        { attendeeId, listing: listing.id, message: "Ticket moved" },
      ]);

      await redeliver(id, data);
      expect(await savedAnswerIds(attendeeId)).toEqual([answer.id, null]);
      expect(await registrationLines(attendeeId, listingName)).toBe(1);
    });

    /** A booking whose tail already ran, with its attendee named. */
    const completedBooking = async (id: string) => {
      const { data, listing } = await checkoutWithTypedAnswer(id);
      const listingName = (await getListingWithCount(listing.id))!.name;
      await configureTestEmail();
      await withRequestContext(async () => {
        expect((await processPaymentSession(id, data)).success).toBe(true);
      });
      const attendeeId = (await getAttendeesRaw(listing.id))[0]!.id;
      return { attendeeId, data, listingName };
    };

    test("re-runs a notification that died beside a committed answer save", async () => {
      const id = "cs_replay_tail_notify_lost";
      const { attendeeId, data, listingName } = await completedBooking(id);
      // The durable state of a delivery that died between the answer save
      // and its log write: the answers sit committed, the activity log
      // holds nothing. The redelivery finishes the notification.
      await execute("DELETE FROM activity_log WHERE attendee_id = ?", [
        attendeeId,
      ]);
      expect(await registrationLines(attendeeId, listingName)).toBe(0);

      await redeliver(id, data);
      expect(await registrationLines(attendeeId, listingName)).toBe(1);
      expect(fetch.getFetchJsonBody()).toMatchObject({
        to: ["buyer@example.com"],
      });
    });

    test("defers the notification of a booking whose listing is gone", async () => {
      const id = "cs_replay_tail_dead_listing";
      const { data, listing } = await answeredCheckout(id);
      await configureTestEmail();
      using errors = spy(console, "error");

      await deliverWithFailingTail(id, data);
      await execute("DELETE FROM listings WHERE id = ?", [listing.id]);

      await redeliver(id, data);
      expect(fetch.callCount()).toBe(0);
      expect(
        errors.calls.some((call) =>
          String(call.args[0]).includes("listing is gone"),
        ),
      ).toBe(true);
    });

    test("never re-notifies a session whose tail already ran", async () => {
      const id = "cs_replay_tail_done";
      const { attendeeId, data, listingName } = await completedBooking(id);
      expect(await registrationLines(attendeeId, listingName)).toBe(1);

      const callsBefore = fetch.callCount();
      await redeliver(id, data);
      expect(fetch.callCount()).toBe(callsBefore);
      expect(await registrationLines(attendeeId, listingName)).toBe(1);
    });
  },
);
