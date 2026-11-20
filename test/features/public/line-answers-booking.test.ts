import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { getAttendeeLineAnswers } from "#db/questions/attendee-answers/reads.ts";
import { expectFlash, expectIncludesAll } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { submitMultiTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createListingPair } from "#test-utils/db-helpers/listing-pair.ts";
import { seedListingLevelQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import { testPageHtml } from "#test-utils/mocks.ts";

/** Two free discos that a parent can book together, and a question that asks
 * for a pupil name once for each disco. */
const seedDiscos = async () => {
  const [discoA, discoB] = await createListingPair({
    maxQuantity: 5,
    unitPrice: 0,
  });
  const { question } = await seedListingLevelQuestion([discoA.id, discoB.id]);
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

/** Submit the booking form for both discos with the given counts and fields. */
const submitOrder = (
  seed: Awaited<ReturnType<typeof seedDiscos>>,
  counts: [number, number],
  answers: Record<string, string>,
): Promise<Response> =>
  submitMultiTicketForm(seed.slugs, {
    email: "pta@example.com",
    name: "PTA Parent",
    [`quantity${seed.discoA.id}`]: String(counts[0]),
    [`quantity${seed.discoB.id}`]: String(counts[1]),
    ...answers,
  });

describeWithEnv(
  "public booking > questions that ask once for each listing",
  { db: true },
  () => {
    test("the booking page shows one field for each listing", async () => {
      const { discoA, discoB, fieldA, fieldB, slugs } = await seedDiscos();
      const html = await testPageHtml(`/ticket/${slugs}`);
      expectIncludesAll(html, [
        `name="${fieldA}"`,
        `name="${fieldB}"`,
        `data-listing-ids="${discoA.id}"`,
        `data-listing-ids="${discoB.id}"`,
        "Pupil name",
      ]);
    });

    test("a free order stores a name for each listing", async () => {
      const seed = await seedDiscos();
      const { discoA, discoB, fieldA, fieldB, question } = seed;
      const response = await submitOrder(seed, [2, 2], {
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
      const seed = await seedDiscos();
      const response = await submitOrder(seed, [1, 1], {
        [seed.fieldA]: "Ava",
      });
      expectFlash(
        response,
        `Please answer: Pupil name (${seed.discoB.name})`,
        false,
      );
      expect(await getAttendeesRaw(seed.discoA.id)).toEqual([]);
    });

    test("a listing the order does not book needs no name, and a stale name for it is not stored", async () => {
      const seed = await seedDiscos();
      const { discoA, fieldA, fieldB, question } = seed;
      const response = await submitOrder(seed, [1, 0], {
        [fieldA]: "Ava",
        [fieldB]: "Ben",
      });
      expect(response.status).toBe(302);
      expect(await lineAnswersOf(discoA.id)).toEqual([
        { listingId: discoA.id, questionId: question.id, text: "Ava" },
      ]);
    });
  },
);
