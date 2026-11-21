import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import {
  expectCheckoutRedirect,
  expectFlash,
  expectIncludesAll,
} from "#test-utils/assertions.ts";
import { stubCheckout } from "#test-utils/checkout.ts";
import { submitMultiTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { readStoredLineAnswers } from "#test-utils/db-helpers/line-answers.ts";
import { createListingPair } from "#test-utils/db-helpers/listing-pair.ts";
import { seedListingLevelQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import { testPageHtml } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** Two free discos that a parent can book together, and a question that asks
 * for a pupil name once for each disco. */
const seedDiscos = async (unitPrice = 0) => {
  const [discoA, discoB] = await createListingPair({
    maxQuantity: 5,
    unitPrice,
  });
  const { question } = await seedListingLevelQuestion([discoA.id, discoB.id]);
  const slugs = `${discoA.slug}+${discoB.slug}`;
  const fieldA = `question${question.id}_listing${discoA.id}`;
  const fieldB = `question${question.id}_listing${discoB.id}`;
  return { discoA, discoB, fieldA, fieldB, question, slugs };
};

const lineAnswersOf = async (listingId: number) => {
  const [attendee] = await getAttendeesRaw(listingId);
  return attendee === undefined ? [] : readStoredLineAnswers(attendee.id);
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

    test("a paid order carries each listing's name in the checkout, apart from the booking-level answers", async () => {
      await setupStripe();
      const seed = await seedDiscos(500);
      const { checkout, getCaptured } = stubCheckout();
      try {
        const response = await submitOrder(seed, [2, 2], {
          [seed.fieldA]: "Ava",
          [seed.fieldB]: "Ben",
        });
        expectCheckoutRedirect(response);
      } finally {
        checkout.restore();
      }
      const intent = getCaptured();
      const { discoA, discoB, question } = seed;
      expect(intent).not.toHaveProperty("listingTextAnswerIds");
      const refs = intent?.lineTextAnswerIds ?? {};
      expect(Object.keys(refs).sort()).toEqual(
        [String(discoA.id), String(discoB.id)].sort(),
      );
      expect(refs[String(discoA.id)]?.map((ref) => ref.q)).toEqual([
        question.id,
      ]);
      expect(refs[String(discoA.id)]).not.toEqual(refs[String(discoB.id)]);
    });
  },
);
