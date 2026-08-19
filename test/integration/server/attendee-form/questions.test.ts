import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { getAttendeeAnswersBatch } from "#db/questions/attendee-answers/reads.ts";
import { saveAttendeeAnswers } from "#db/questions/attendee-answers/save.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildAttendeeEditForm } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminFormPost, testCookie } from "#test-utils/session.ts";

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
        await listingQuestions.setIds(eventA.id, [qA.id]);

        const qB = await questionsTable.insert({
          displayType: "radio",
          text: "Meal choice?",
        });
        const aB = await answersTable.insert({
          questionId: qB.id,
          sortOrder: 0,
          text: "Vegan",
        });
        await listingQuestions.setIds(eventB.id, [qB.id]);

        const created = await attendeesApi.createAttendeeAtomic({
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

      /** The set of answer ids stored for `attendeeId`. */
      const savedAnswerIds = async (attendeeId: number): Promise<Set<number>> =>
        new Set(
          (await getAttendeeAnswersBatch([attendeeId], { texts: false })).get(
            attendeeId,
          ) ?? [],
        );

      /** Answer qA with its real option and qB with `qbAnswer`, submit the edit
       *  under `name`, confirm it saved (302), and return the stored answer ids
       *  so each test can assert which answers survived. */
      const saveAnswerEdit = async (
        ids: Awaited<ReturnType<typeof setupMultiEventQuestions>>,
        qbAnswer: string,
        name: string,
      ): Promise<Set<number>> => {
        const form = await buildAttendeeEditForm(ids.attendeeId, {
          extra: {
            [`question_${ids.qA.id}`]: String(ids.aA.id),
            [`question_${ids.qB.id}`]: qbAnswer,
          },
          name,
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${ids.attendeeId}`,
          form,
        );
        expect(response.status).toBe(302);
        return savedAnswerIds(ids.attendeeId);
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
        const ids = await setupMultiEventQuestions();

        // Submit both answers, as the rendered (pre-checked) form would.
        const saved = await saveAnswerEdit(
          ids,
          String(ids.aB.id),
          "Multi Edited",
        );
        // Both answers survive — not just the first event's.
        expect(saved.has(ids.aA.id)).toBe(true);
        expect(saved.has(ids.aB.id)).toBe(true);
      });

      test("never persists an answer id the admin didn't have as an option", async () => {
        const ids = await setupMultiEventQuestions();

        // Valid answer for qA; a bogus id for qB that isn't one of its options.
        const saved = await saveAnswerEdit(ids, "99999", "Multi");
        // The bogus id is silently dropped (admin answers are optional), never
        // written — so the form can't inject an arbitrary answer row.
        expect(saved.has(ids.aA.id)).toBe(true);
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
        await listingQuestions.setIds(event.id, [q.id]);

        const makeAttendee = async (name: string, email: string) => {
          const result = await attendeesApi.createAttendeeAtomic({
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

    test("rejects an over-length optional free-text answer", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Free text listing",
      });
      const question = await questionsTable.insert({
        displayType: "free_text",
        text: "Access needs?",
      });
      await listingQuestions.setIds(listing.id, [question.id]);
      const created = await attendeesApi.createAttendeeAtomic({
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "free-text@example.com",
        name: "Free Text",
      });
      if (!created.success) throw new Error("setup");
      const attendeeId = created.attendees[0]!.id;
      const form = await buildAttendeeEditForm(attendeeId, {
        email: "free-text@example.com",
        extra: {
          [`question_${question.id}`]: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
        },
        name: "Free Text",
      });

      const { response } = await adminFormPost(
        `/admin/attendees/${attendeeId}`,
        form,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        "Answer is too long: Access needs?",
      );
    });
  },
);
