import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { hmacHash } from "#crypto/hashing.ts";
import { logActivities } from "#db/activity-log.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { execute, getDb } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import type { ValidatedSession } from "#routes/api/webhook-types.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  withRejectedAnswerWrite,
  withRejectedRegistrationLog,
} from "#test-utils/atomic-booking.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { urlFromFetchInput, useFetchStub } from "#test-utils/mocks.ts";
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

    /** The first delivery of the issue: a booked attendee whose tail's
     * answer save died, so the redelivery owes the whole tail. */
    const bookedWithFailingTail = async (id: string) => {
      const { answer, data, listing, listingName } = await answeredCheckout(id);
      await deliverWithFailingTail(id, data);
      const attendeeId = (await getAttendeesRaw(listing.id))[0]!.id;
      return { answer, attendeeId, data, id, listing, listingName };
    };

    /** The resumed tail's state: the choice and text answers saved, and the
     * one registration line in the activity log. */
    const expectResumedAnswers = async (
      attendeeId: number,
      listingName: string,
      answerId: number,
    ): Promise<void> => {
      expect(await savedAnswerIds(attendeeId)).toEqual([answerId, null]);
      expect(await registrationLines(attendeeId, listingName)).toBe(1);
    };

    /** A redelivery after the notification committed: it queues no email,
     * and the one registration line stays alone. */
    const expectNoFurtherDelivery = async (
      id: string,
      data: ValidatedSession,
      attendeeId: number,
      listingName: string,
    ): Promise<void> => {
      const callsBefore = fetch.callCount();
      await redeliver(id, data);
      expect(fetch.callCount()).toBe(callsBefore);
      expect(await registrationLines(attendeeId, listingName)).toBe(1);
    };

    /** The session's first delivery: it finishes its whole tail, and the
     * helper returns the attendee it booked. */
    const deliverOnce = async (
      id: string,
      data: ValidatedSession,
      listingId: number,
    ): Promise<number> => {
      await withRequestContext(async () => {
        expect((await processPaymentSession(id, data)).success).toBe(true);
      });
      return (await getAttendeesRaw(listingId))[0]!.id;
    };

    test("resumes the answers and notification a failed tail left behind", async () => {
      const { answer, attendeeId, data, id, listingName } =
        await bookedWithFailingTail("cs_replay_tail_conflict");

      // Booked and finalized, but the tail never ran.
      expect((await getProcessedPayment(id))?.attendee_id).toBe(attendeeId);
      expect(await savedAnswerIds(attendeeId)).toEqual([]);
      expect(await registrationLines(attendeeId, listingName)).toBe(0);

      // The redelivery claims the notification and finishes the tail.
      await redeliver(id, data);
      // Choice row first; the free text binds its string, so its answer_id
      // is null.
      await expectResumedAnswers(attendeeId, listingName, answer.id);
      // The resumed notification queues the buyer's confirmation.
      expect(fetch.getFetchJsonBody()).toMatchObject({
        to: ["buyer@example.com"],
      });

      // A further redelivery finds the notification delivered and runs
      // nothing again.
      await expectNoFurtherDelivery(id, data, attendeeId, listingName);
    });

    test("sends the buyer's confirmation through the durable ledger", async () => {
      const { answer, attendeeId, data, id, listingName } =
        await bookedWithFailingTail("cs_replay_tail_ledger");
      // The reservation row is gone the way a pruned one would be. The work
      // row outlives it, and its sealed payload carries the ticket token the
      // pruned row held.
      await execute(
        "DELETE FROM processed_payments WHERE payment_session_id = ?",
        [id],
      );

      await redeliver(id, data);
      // The ledger replay finishes the whole tail: the answers, the
      // registration line, and the buyer's confirmation with a working
      // check-in link from the sealed payload.
      await expectResumedAnswers(attendeeId, listingName, answer.id);
      expect(fetch.getFetchJsonBody()).toMatchObject({
        to: ["buyer@example.com"],
      });
      expect(fetch.getFetchJsonBody().text).toContain("Arriving late");
    });

    test("releases the lease when the resumed answer save fails", async () => {
      const { answer, attendeeId, data, id, listingName } =
        await bookedWithFailingTail("cs_replay_tail_release");

      // The first replay claims the lease, then its answer save dies. The
      // claim must come back, so the next delivery can claim fresh instead
      // of finding a held lease and answering retryably forever.
      await withRejectedAnswerWrite(() =>
        expect(processPaymentSession(id, data)).rejects.toThrow(
          "unexpected answer write",
        ),
      );
      await redeliver(id, data);
      await expectResumedAnswers(attendeeId, listingName, answer.id);
    });

    test("resumes a missing-row booking whose notification never ran", async () => {
      const { answer, attendeeId, data, id, listingName } =
        await bookedWithFailingTail("cs_replay_tail_row_lost");

      // The work row is gone before the notification ever ran: no
      // registration line exists, so the booking owes the whole tail. The
      // stored token rebuilds the payload the row would have carried.
      await execute(
        "DELETE FROM registration_notification_work WHERE session_index = ?",
        [await hmacHash(id)],
      );
      await redeliver(id, data);
      await expectResumedAnswers(attendeeId, listingName, answer.id);
      expect(fetch.getFetchJsonBody()).toMatchObject({
        to: ["buyer@example.com"],
      });
    });

    test("resumes despite other activity rows for the attendee", async () => {
      const { answer, attendeeId, data, id, listing, listingName } =
        await bookedWithFailingTail("cs_replay_tail_move_line");

      // A door move logged its own activity row before the redelivery. The
      // move proves nothing about the notification, so the resume still
      // runs.
      await logActivities([
        { attendeeId, listing: listing.id, message: "Ticket moved" },
      ]);

      await redeliver(id, data);
      await expectResumedAnswers(attendeeId, listingName, answer.id);
    });

    test("re-runs a notification that died beside a committed answer save", async () => {
      const id = "cs_replay_tail_notify_lost";
      const { answer, data, listing, listingName } = await answeredCheckout(id);

      // The answer save commits, then the notification's log write dies.
      // The delivery releases its lease and answers nothing usable.
      await withRejectedRegistrationLog(() =>
        expect(processPaymentSession(id, data)).rejects.toThrow(
          "unexpected registration log write",
        ),
      );
      const attendeeId = (await getAttendeesRaw(listing.id))[0]!.id;
      // An unrelated activity row lands before the redelivery.
      await logActivities([
        { attendeeId, listing: listing.id, message: "Ticket moved" },
      ]);

      await redeliver(id, data);
      await expectResumedAnswers(attendeeId, listingName, answer.id);
      expect(fetch.callCount()).toBe(1);
    });

    test("defers the notification of a booking whose listing is gone", async () => {
      const { data, id, listing } = await bookedWithFailingTail(
        "cs_replay_tail_dead_listing",
      );
      using errors = spy(console, "error");

      await execute("DELETE FROM listings WHERE id = ?", [listing.id]);

      await redeliver(id, data);
      expect(fetch.callCount()).toBe(0);
      expect(
        errors.calls.some((call) =>
          String(call.args[0]).includes("listing is gone"),
        ),
      ).toBe(true);
    });

    test("notifies a question-free booking once across repeated replays", async () => {
      const id = "cs_replay_tail_no_questions";
      // No questions on the listing and no typed answers: the answer save
      // writes no snapshot rows at all, so the completion marker cannot
      // rest on them.
      const { data, listing, listingName } = await answeredCheckout(id);
      await execute("DELETE FROM listing_questions WHERE listing_id = ?", [
        listing.id,
      ]);
      data.intent.listingAnswerIds = {};
      data.intent.listingTextAnswerIds = undefined;
      await configureTestEmail();

      const attendeeId = await deliverOnce(id, data, listing.id);
      expect(await registrationLines(attendeeId, listingName)).toBe(1);

      await expectNoFurtherDelivery(id, data, attendeeId, listingName);
      await expectNoFurtherDelivery(id, data, attendeeId, listingName);
    });

    test("answers a held lease retryably and delivers one notification", async () => {
      const id = "cs_replay_tail_race";
      const { data, listing, listingName } = await answeredCheckout(id);
      await configureTestEmail();

      // The first delivery claims the work and blocks inside its email
      // send. A second delivery then reaches the same unfinished tail: the
      // row is claimed and undelivered, so the lease is held, and the second
      // delivery answers retryably instead of pretending the tail is done.
      // Exactly one confirmation and one registration line exist across
      // both, and the provider keeps retrying until the tail finishes.
      let releaseEmail!: () => void;
      const emailHeld = new Promise<void>((resolve) => {
        releaseEmail = resolve;
      });
      let emailReached!: () => void;
      const emailReachedP = new Promise<void>((resolve) => {
        emailReached = resolve;
      });
      fetch.restubFetch((input: string | URL | Request) => {
        if (String(urlFromFetchInput(input)).includes("resend")) {
          emailReached();
          return (async () => {
            await emailHeld;
            return new Response();
          })();
        }
        return new Response();
      });

      // The two outcomes settle as data, so neither delivery's rejection can
      // escape this test as an unhandled rejection.
      const first = (async () => {
        try {
          return { ok: true as const, result: await firstDelivery() };
        } catch (error) {
          return { error, ok: false as const };
        }
      })();
      async function firstDelivery() {
        return withRequestContext(() => processPaymentSession(id, data));
      }
      await emailReachedP;

      // The lease is held and nothing is delivered yet: the tail is
      // demonstrably incomplete while the competitor decides its answer.
      const attendeeId = (await getAttendeesRaw(listing.id))[0]!.id;
      const workState = await execute(
        "SELECT claimed_at, delivered_at FROM registration_notification_work WHERE session_index = ?",
        [await hmacHash(id)],
      );
      expect(String(workState.rows[0]?.claimed_at)).toBeTruthy();
      expect(workState.rows[0]?.delivered_at).toBe(null);

      const second = await withRequestContext(() =>
        processPaymentSession(id, data),
      );
      // The held lease answers retryably: the provider is told to come back
      // while the first delivery finishes the tail.
      if (second.success) throw new Error("the held lease answered success");
      expect(second.status).toBe(409);
      // The second delivery notified nothing: the one recorded call is the
      // first delivery's held send.
      expect(fetch.callCount()).toBe(1);

      releaseEmail();
      const firstOutcome = await first;
      expect(firstOutcome.ok).toBe(true);
      expect(await registrationLines(attendeeId, listingName)).toBe(1);
      expect(fetch.callCount()).toBe(1);
    });

    test("never re-notifies a session whose tail already ran", async () => {
      const id = "cs_replay_tail_done";
      const { data, listing, listingName } = await answeredCheckout(id);
      const attendeeId = await deliverOnce(id, data, listing.id);
      expect(await registrationLines(attendeeId, listingName)).toBe(1);

      await expectNoFurtherDelivery(id, data, attendeeId, listingName);
    });
  },
);
