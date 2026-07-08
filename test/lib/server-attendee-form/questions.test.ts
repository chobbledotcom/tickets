import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import {
  getAttendeeAnswersBatch,
  saveAttendeeAnswers,
} from "#shared/db/questions/attendee-answers.ts";
import { setListingQuestions } from "#shared/db/questions/queries.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import {
  adminFormPost,
  awaitTestRequest,
  buildAttendeeEditForm,
  createTestListing,
  describeWithEnv,
  testCookie,
} from "#test-utils";

describeWithEnv(
  "server (unified attendee form) — custom questions",
  { db: true },
  () => {
    describe("custom questions on a multi-event attendee", () => {
      /** Book an attendee on both events with a custom question on each, plus an
       * answer to each question. Returns the ids needed to drive an edit. */
      const setupMultiEventQuestions = async () => {
        const eventA = await createTestListing({
          maxAttendees: 10,
          name: "QA Event",
        });
        const eventB = await createTestListing({
          maxAttendees: 10,
          name: "QB Event",
        });

        const qA = await questionsTable.insert({
          displayType: "radio",
          text: "Shirt size?",
        });
        const aA = await answersTable.insert({
          questionId: qA.id,
          sortOrder: 0,
          text: "Medium",
        });
        await setListingQuestions(eventA.id, [qA.id]);

        const qB = await questionsTable.insert({
          displayType: "radio",
          text: "Meal choice?",
        });
        const aB = await answersTable.insert({
          questionId: qB.id,
          sortOrder: 0,
          text: "Vegan",
        });
        await setListingQuestions(eventB.id, [qB.id]);

        const created = await createAttendeeAtomic({
          bookings: [
            { listingId: eventA.id, quantity: 1 },
            { listingId: eventB.id, quantity: 1 },
          ],
          email: "multi@example.com",
          name: "Multi",
        });
        if (!created.success) throw new Error("setup");
        const attendeeId = created.attendees[0]!.id;
        await saveAttendeeAnswers(new Map([[attendeeId, [aA.id, aB.id]]]));
        return { aA, aB, attendeeId, qA, qB };
      };

      test("edit page renders questions from every booked event", async () => {
        const { attendeeId } = await setupMultiEventQuestions();
        const response = await awaitTestRequest(
          `/admin/attendees/${attendeeId}`,
          {
            cookie: await testCookie(),
          },
        );
        const html = await response.text();
        expect(html).toContain("Shirt size?");
        expect(html).toContain("Meal choice?");
      });

      test("saving an edit preserves answers for every booked event", async () => {
        const { aA, aB, attendeeId, qA, qB } = await setupMultiEventQuestions();

        // Submit both answers, as the rendered (pre-checked) form would.
        const form = await buildAttendeeEditForm(attendeeId, {
          extra: {
            [`question_${qA.id}`]: String(aA.id),
            [`question_${qB.id}`]: String(aB.id),
          },
          name: "Multi Edited",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendeeId}`,
          form,
        );
        expect(response.status).toBe(302);

        // Both answers survive — not just the first event's.
        const saved = new Set(
          (await getAttendeeAnswersBatch([attendeeId], { texts: false })).get(
            attendeeId,
          ) ?? [],
        );
        expect(saved.has(aA.id)).toBe(true);
        expect(saved.has(aB.id)).toBe(true);
      });

      test("never persists an answer id the admin didn't have as an option", async () => {
        const { aA, attendeeId, qA, qB } = await setupMultiEventQuestions();

        // Valid answer for qA; a bogus id for qB that isn't one of its options.
        const form = await buildAttendeeEditForm(attendeeId, {
          extra: {
            [`question_${qA.id}`]: String(aA.id),
            [`question_${qB.id}`]: "99999",
          },
          name: "Multi",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendeeId}`,
          form,
        );
        expect(response.status).toBe(302);

        const saved = new Set(
          (await getAttendeeAnswersBatch([attendeeId], { texts: false })).get(
            attendeeId,
          ) ?? [],
        );
        // The bogus id is silently dropped (admin answers are optional), never
        // written — so the form can't inject an arbitrary answer row.
        expect(saved.has(aA.id)).toBe(true);
        expect(saved.has(99999)).toBe(false);
      });

      test("editing one attendee's answers leaves another attendee's untouched", async () => {
        const event = await createTestListing({
          maxAttendees: 10,
          name: "Shared",
        });
        const q = await questionsTable.insert({
          displayType: "radio",
          text: "Size?",
        });
        const a1 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 0,
          text: "S",
        });
        const a2 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 1,
          text: "L",
        });
        await setListingQuestions(event.id, [q.id]);

        const makeAttendee = async (name: string, email: string) => {
          const result = await createAttendeeAtomic({
            bookings: [{ listingId: event.id, quantity: 1 }],
            email,
            name,
          });
          if (!result.success) throw new Error("setup");
          return result.attendees[0]!.id;
        };
        const alice = await makeAttendee("Alice", "alice@example.com");
        const bob = await makeAttendee("Bob", "bob@example.com");
        await saveAttendeeAnswers(new Map([[alice, [a1.id]]]));
        await saveAttendeeAnswers(new Map([[bob, [a2.id]]]));

        // Edit Alice's answer; her save must not touch Bob's row.
        const form = await buildAttendeeEditForm(alice, {
          extra: { [`question_${q.id}`]: String(a2.id) },
          name: "Alice",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${alice}`,
          form,
        );
        expect(response.status).toBe(302);

        const bobAnswers =
          (await getAttendeeAnswersBatch([bob], { texts: false })).get(bob) ??
          [];
        expect(bobAnswers).toEqual([a2.id]);
      });
    });
  },
);
