import { setupFeaturePageTest } from "#test/ui/templates/admin/feature-page-test.ts";
import {
  smallLargeAnswers,
  testListingWithCount,
  testQuestion,
} from "#test-utils/factories.ts";

export const TEST_LISTINGS = [
  testListingWithCount({ id: 1, name: "Spring Gig" }),
  testListingWithCount({ id: 2, name: "Summer Gig" }),
];

/** The "T-shirt size?" question with Small/Large answers — the canonical radio
 *  question reused by the question, answer-edit, and answer-delete page tests. */
export const tShirtQuestion = testQuestion({
  answers: smallLargeAnswers,
  id: 1,
  text: "T-shirt size?",
});

export const setupQuestionPageTest: () => Promise<void> =
  setupFeaturePageTest("questions");
