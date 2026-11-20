import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { getAttendeeLineAnswers } from "#db/questions/attendee-answers/reads.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { submitMultiTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createListingPair } from "#test-utils/db-helpers/listing-pair.ts";
import { seedQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import { testPageHtml } from "#test-utils/mocks.ts";

/** Two free discos that a parent can book together, and a question that asks
 * for a pupil name once for each disco. */
const seedDiscos = async () => {
  const [discoA, discoB] = await createListingPair({
    maxQuantity: 5,
    unitPrice: 0,
  });
  const { question } = await seedQuestion({
    answerLevel: "listing",
    displayType: "free_text",
    listingIds: [discoA.id, discoB.id],
    text: "Pupil name",
  });
  const slugs = `${discoA.slug}+${discoB.slug}`;
  const fieldA = `question${question.id}_listing${discoA.id}`;
  const fieldB = `question${question.id}_listing${discoB.id}`;
  return { discoA, discoB, fieldA, fieldB, question, slugs };
};

const lineAnswersOf = async (listingId: number) => {
  const [attendee] = await getAttendeesRaw(listingId);
  return attendee === undefined
    ? []
    : getAttendeeLineAnswers(attendee.id, getTestPrivateKey);
};

describeWithEnv(
  "public booking > questions that ask once for each listing",
  {
    db: true,
  },
  () => {
    test("the booking page shows one field for each listing", async () => {
      const { discoA, discoB, fieldA, fieldB, slugs } = await seedDiscos();
      const html = await testPageHtml(`/ticket/${slugs}`);
      for (const field of [fieldA, fieldB]) {
        expect(html).toContain(`name="${field}"`);
      }
      expect(html).toContain(`data-listing-ids="${discoA.id}"`);
      expect(html).toContain(`data-listing-ids="${discoB.id}"`);
      expect(html).toContain("Pupil name");
    });

    test("a free order stores a name for each listing", async () => {
      const { discoA, discoB, fieldA, fieldB, question, slugs } =
        await seedDiscos();
      const response = await submitMultiTicketForm(slugs, {
        email: "pta@example.com",
        name: "PTA Parent",
        [`quantity${discoA.id}`]: "2",
        [`quantity${discoB.id}`]: "2",
        [fieldA]: "Ava",
        [fieldB]: "Ben",
      });
      expect(response.status).toBe(302);
      expect(await lineAnswersOf(discoA.id)).toEqual([
        { listingId: discoA.id, questionId: question.id, text: "Ava" },
        { listingId: discoB.id, questionId: question.id, text: "Ben" },
      ]);
    });

    test("a missing name for a booked listing stops the order and names the listing", async () => {
      const { discoA, discoB, fieldA, slugs } = await seedDiscos();
      const response = await submitMultiTicketForm(slugs, {
        email: "pta@example.com",
        name: "PTA Parent",
        [`quantity${discoA.id}`]: "1",
        [`quantity${discoB.id}`]: "1",
        [fieldA]: "Ava",
      });
      expectFlash(
        response,
        `Please answer: Pupil name (${discoB.name})`,
        false,
      );
      expect(await getAttendeesRaw(discoA.id)).toEqual([]);
    });

    test("a listing the order does not book needs no name", async () => {
      const { discoA, discoB, fieldA, question, slugs } = await seedDiscos();
      const response = await submitMultiTicketForm(slugs, {
        email: "pta@example.com",
        name: "PTA Parent",
        [`quantity${discoA.id}`]: "1",
        [`quantity${discoB.id}`]: "0",
        [fieldA]: "Ava",
      });
      expect(response.status).toBe(302);
      expect(await lineAnswersOf(discoA.id)).toEqual([
        { listingId: discoA.id, questionId: question.id, text: "Ava" },
      ]);
    });

    test("a stale name for an unbooked listing is not stored", async () => {
      const { discoA, discoB, fieldA, fieldB, question, slugs } =
        await seedDiscos();
      await submitMultiTicketForm(slugs, {
        email: "pta@example.com",
        name: "PTA Parent",
        [`quantity${discoA.id}`]: "1",
        [`quantity${discoB.id}`]: "0",
        [fieldA]: "Ava",
        [fieldB]: "Ben",
      });
      expect(await lineAnswersOf(discoA.id)).toEqual([
        { listingId: discoA.id, questionId: question.id, text: "Ava" },
      ]);
    });
  },
);
