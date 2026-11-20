import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { saveAttendeeAnswers } from "#db/questions/attendee-answers/save.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createListingPair } from "#test-utils/db-helpers/listing-pair.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { seedQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "admin attendee page > answers for each listing",
  { db: true },
  () => {
    test("shows each answer with its question and its listing", async () => {
      const [discoA, discoB] = await createListingPair(
        { name: "Disco A" },
        { name: "Disco B" },
      );
      const { question } = await seedQuestion({
        answerLevel: "listing",
        displayType: "free_text",
        listingIds: [discoA.id, discoB.id],
        text: "Pupil name",
      });
      const attendee = await bookTestAttendee([discoA.id, discoB.id], "Parent");
      await saveAttendeeAnswers(
        new Map([
          [
            attendee.id,
            {
              answerIds: [],
              lineTextAnswers: [
                { listingId: discoA.id, questionId: question.id, text: "Ava" },
                { listingId: discoB.id, questionId: question.id, text: "Ben" },
              ],
            },
          ],
        ]),
      );

      const html = await (
        await adminGet(`/admin/attendees/${attendee.id}`)
      ).text();

      expectIncludesAll(html, [
        "Answers for each listing",
        `Pupil name (${discoA.name})`,
        "Ava",
        `Pupil name (${discoB.name})`,
        "Ben",
      ]);
    });

    test("drops the section for an attendee with no listing answers", async () => {
      const discoA = await createTestListing({ name: "Disco A" });
      const attendee = await bookTestAttendee([discoA.id], "Parent");

      const html = await (
        await adminGet(`/admin/attendees/${attendee.id}`)
      ).text();

      expect(html).not.toContain("Answers for each listing");
    });

    test("the edit form offers no field for a question that asks once for each listing", async () => {
      const listing = await createTestListing({ name: "Disco A" });
      const { question: pupil } = await seedQuestion({
        answerLevel: "listing",
        displayType: "free_text",
        listingIds: [listing.id],
        text: "Pupil name",
      });
      const { question: note } = await seedQuestion({
        displayType: "free_text",
        listingIds: [listing.id],
        text: "Note",
      });
      const attendee = await bookTestAttendee([listing.id], "Parent");

      const html = await (
        await adminGet(`/admin/attendees/${attendee.id}/edit`)
      ).text();

      expectIncludesAll(html, [`name="question${note.id}"`]);
      expect(html).not.toContain(`name="question${pupil.id}"`);
    });
  },
);
