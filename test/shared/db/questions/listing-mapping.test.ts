import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getListingQuestionIds,
  getQuestionsForListing,
  listingQuestions,
  questionListings,
} from "#shared/db/questions/queries.ts";
import { questionsOrder } from "#shared/db/questions/tables.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createOrderedQuestionPair,
  createQuestion,
  createQuestionWithAnswers,
  expectQuestionTexts,
  seedQuestionWithAndWithoutAnswers,
} from "./helpers.ts";

/** Two answered questions ("Q1", "Q2") and a fresh listing — the shared
 *  arrange behind the assign/replace mapping tests. */
const twoQuestionsAndListing = async () => {
  const q1 = await createQuestionWithAnswers("Q1", ["A1"]);
  const q2 = await createQuestionWithAnswers("Q2", ["A2"]);
  const listing = await createTestListing();
  return { listing, q1, q2 };
};

describeWithEnv("custom questions", { db: true }, () => {
  describe("listing-question mapping", () => {
    test("assigns questions to an listing", async () => {
      const { listing, q1, q2 } = await twoQuestionsAndListing();
      // Assign in reverse; the listing ignores assignment order and uses the
      // global question order (here creation/id order, since both are at the
      // default sort_order 0).
      await listingQuestions.setIds(listing.id, [q2.id, q1.id]);

      const questions = await getQuestionsForListing(listing.id);
      expectQuestionTexts(questions, ["Q1", "Q2"]);
    });

    test("orders listing questions by the global sort_order, not assignment order", async () => {
      const { q1, q2 } = await createOrderedQuestionPair("A1", "A2");

      // Put q2 ahead of q1 globally.
      await questionsOrder.swap({ first: q1.id, second: q2.id });

      const listing = await createTestListing();
      await listingQuestions.setIds(listing.id, [q1.id, q2.id]);

      const questions = await getQuestionsForListing(listing.id);
      expectQuestionTexts(questions, ["Q2", "Q1"]);
    });

    test("replaces listing questions on re-assignment", async () => {
      const { listing, q1, q2 } = await twoQuestionsAndListing();
      await listingQuestions.setIds(listing.id, [q1.id, q2.id]);
      await listingQuestions.setIds(listing.id, [q2.id]);

      const questions = await getQuestionsForListing(listing.id);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.text).toBe("Q2");
    });

    test("dedupes repeated question ids", async () => {
      const q = await createQuestionWithAnswers("Q", ["A"]);
      const listing = await createTestListing();

      await listingQuestions.setIds(listing.id, [q.id, q.id]);

      expect(await getListingQuestionIds(listing.id)).toEqual([q.id]);
    });

    test("includes assign-all questions for every listing", async () => {
      const q = await createQuestionWithAnswers("Universal Q", ["Yes"], {
        assignAll: true,
      });

      const listing = await createTestListing();

      const questions = await getQuestionsForListing(listing.id);
      expect(questions.map((question) => question.text)).toEqual([
        "Universal Q",
      ]);
      expect(await getListingQuestionIds(listing.id)).toEqual([q.id]);
    });

    test("returns empty array for listing with no questions", async () => {
      const listing = await createTestListing();
      const questions = await getQuestionsForListing(listing.id);
      expect(questions).toEqual([]);
    });

    test("skips questions with no answers", async () => {
      const { listing } = await seedQuestionWithAndWithoutAnswers();

      const questions = await getQuestionsForListing(listing.id);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.text).toBe("Has answers");
    });
  });
  describe("getListingQuestionIds", () => {
    test("returns assigned question IDs", async () => {
      const q1 = await createQuestion("Q1");
      const q2 = await createQuestion("Q2");

      const listing = await createTestListing();
      await listingQuestions.setIds(listing.id, [q2.id, q1.id]);

      // Returned in the global question order, not the assignment order.
      const ids = await getListingQuestionIds(listing.id);
      expect(ids).toEqual([q1.id, q2.id]);
    });

    test("returns empty array for listing with no questions", async () => {
      const listing = await createTestListing();
      expect(await getListingQuestionIds(listing.id)).toEqual([]);
    });
  });
  describe("questionListings.getIds", () => {
    test("returns the listings a question is assigned to", async () => {
      const q = await createQuestion("Q");
      const listing1 = await createTestListing();
      const listing2 = await createTestListing({ name: "Listing 2" });
      await listingQuestions.setIds(listing1.id, [q.id]);
      await listingQuestions.setIds(listing2.id, [q.id]);

      const ids = await questionListings.getIds(q.id);
      expect(ids.sort()).toEqual([listing1.id, listing2.id].sort());
    });

    test("returns empty array when assigned to no listings", async () => {
      const q = await createQuestion("Lonely Q");
      expect(await questionListings.getIds(q.id)).toEqual([]);
    });
  });
  describe("questionListings.setIds", () => {
    /** A question already assigned to both listings — the shared starting
     *  point for the assign/unassign tests below. */
    const seedQuestionAssignedToTwoListings = async () => {
      const q = await createQuestion("Q");
      const listing1 = await createTestListing();
      const listing2 = await createTestListing({ name: "Listing 2" });
      await questionListings.setIds(q.id, [listing1.id, listing2.id]);
      return { listing1, listing2, q };
    };

    const seedQuestionAssignedToListing = async () => {
      const q = await createQuestion("Q");
      const listing = await createTestListing();
      await questionListings.setIds(q.id, [listing.id]);
      return { listing, q };
    };

    test("assigns a question to the selected listings", async () => {
      const { listing1, listing2, q } =
        await seedQuestionAssignedToTwoListings();

      expect((await questionListings.getIds(q.id)).sort()).toEqual(
        [listing1.id, listing2.id].sort(),
      );
    });

    test("removes the question from unchecked listings", async () => {
      const { listing1, q } = await seedQuestionAssignedToTwoListings();

      await questionListings.setIds(q.id, [listing1.id]);

      expect(await questionListings.getIds(q.id)).toEqual([listing1.id]);
    });

    test("lists a listing's assigned questions in the global question order", async () => {
      const existing = await createQuestionWithAnswers("Existing", ["A"]);
      const added = await createQuestionWithAnswers("Added", ["B"]);

      const listing = await createTestListing();
      await listingQuestions.setIds(listing.id, [existing.id]);

      await questionListings.setIds(added.id, [listing.id]);

      const ids = await getListingQuestionIds(listing.id);
      expect(ids).toEqual([existing.id, added.id]);
    });

    test("does nothing when the assignment is unchanged", async () => {
      const { listing, q } = await seedQuestionAssignedToListing();

      await questionListings.setIds(q.id, [listing.id]);

      expect(await questionListings.getIds(q.id)).toEqual([listing.id]);
    });

    test("clears all listings when given an empty list", async () => {
      const { q } = await seedQuestionAssignedToListing();

      await questionListings.setIds(q.id, []);

      expect(await questionListings.getIds(q.id)).toEqual([]);
    });
  });
  describe("questionListings.getIdsByKeys", () => {
    test("maps each question to its assigned listing ids", async () => {
      const q = await createQuestion("Q");
      const l1 = await createTestListing({ name: "Alpha" });
      const l2 = await createTestListing({ name: "Beta" });
      await questionListings.setIds(q.id, [l1.id, l2.id]);

      const map = await questionListings.getIdsByKeys([q.id]);
      expect(map.get(q.id)!.sort()).toEqual([l1.id, l2.id].sort());
    });

    test("seeds an empty list for questions with no listings", async () => {
      const q = await createQuestion("Lonely");
      const map = await questionListings.getIdsByKeys([q.id]);
      expect(map.get(q.id)).toEqual([]);
    });
  });
});
