import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getAttendeeAnswersBatch,
  getAttendeeAnswersByQuestion,
  getAttendeeTextAnswers,
  getListingChoiceAnswerMap,
  loadAttendeeQuestionData,
} from "#shared/db/questions/attendee-answers/reads.ts";
import { saveAttendeeAnswers } from "#shared/db/questions/attendee-answers/save.ts";
import { listingQuestions } from "#shared/db/questions/queries.ts";
import {
  addAnswer,
  createAttendee,
  createQuestion,
  saveTextAnswers,
} from "#test/shared/db/questions/helpers.ts";
import { insertCheckoutStage } from "#test-utils/checkout-stages.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > attendee answer reads", { db: true }, () => {
  test("loads choice and text answers together", async () => {
    const choice = await createQuestion("Size?");
    const small = await addAnswer(choice.id, 0, "Small");
    const text = await createQuestion("Notes?", { displayType: "free_text" });
    const listing = await createTestListing();
    const attendee = await createAttendee(listing.id);
    await saveAttendeeAnswers(
      new Map([
        [
          attendee.id,
          {
            answerIds: [small.id],
            textAnswers: [{ questionId: text.id, text: "Front row" }],
          },
        ],
      ]),
    );

    const result = await getAttendeeAnswersBatch([attendee.id], {
      privateKey: await getTestPrivateKey(),
      texts: true,
    });
    expect(result.answerIds).toEqual(new Map([[attendee.id, [small.id]]]));
    expect(result.textAnswers.get(attendee.id)).toEqual(
      new Map([[text.id, "Front row"]]),
    );
    expect(
      await getAttendeeTextAnswers(attendee.id, await getTestPrivateKey()),
    ).toEqual(new Map([[text.id, "Front row"]]));
  });

  test("returns empty maps for empty and unanswered reads", async () => {
    const key = await getTestPrivateKey();
    expect(await getAttendeeAnswersBatch([], { texts: false })).toEqual(
      new Map(),
    );
    expect(await getAttendeeTextAnswers(999_999, key)).toEqual(new Map());
  });

  test("excludes staged attendees from a listing choice summary", async () => {
    const question = await createQuestion("Meal?");
    const vegan = await addAnswer(question.id, 0, "Vegan");
    const listing = await createTestListing();
    const live = await createAttendee(listing.id, "Live");
    const staged = await createAttendee(listing.id, "Staged");
    await saveAttendeeAnswers(
      new Map([
        [live.id, [vegan.id]],
        [staged.id, [vegan.id]],
      ]),
    );
    await insertCheckoutStage(staged.id, "answers-staged");

    expect(await getListingChoiceAnswerMap(listing.id)).toEqual(
      new Map([[live.id, [vegan.id]]]),
    );
  });

  test("loads assigned question data with and without text", async () => {
    const listing = await createTestListing();
    const attendee = await createAttendee(listing.id);
    const question = await createQuestion("Access?", {
      displayType: "free_text",
    });
    await listingQuestions.setIds(listing.id, [question.id]);
    await saveTextAnswers(attendee.id, [
      { questionId: question.id, text: "Step-free" },
    ]);

    const choicesOnly = await loadAttendeeQuestionData(
      [listing.id],
      [attendee.id],
    );
    expect(choicesOnly).toMatchObject({
      attendeeAnswerMap: new Map(),
      questions: [{ id: question.id }],
    });
    expect(choicesOnly?.textAnswerMap).toBeUndefined();

    const withText = await loadAttendeeQuestionData(
      [listing.id],
      [attendee.id],
      await getTestPrivateKey(),
    );
    expect(withText?.textAnswerMap).toEqual(
      new Map([[attendee.id, new Map([[question.id, "Step-free"]])]]),
    );
  });

  test("returns no question data when an input or assigned questions are empty", async () => {
    const listing = await createTestListing();
    const attendee = await createAttendee(listing.id);
    const assigned = await createQuestion("Assigned?");
    await addAnswer(assigned.id, 0, "Yes");
    await listingQuestions.setIds(listing.id, [assigned.id]);
    expect(await loadAttendeeQuestionData([], [attendee.id])).toBeUndefined();
    expect(await loadAttendeeQuestionData([listing.id], [])).toBeUndefined();
    await listingQuestions.setIds(listing.id, []);
    expect(
      await loadAttendeeQuestionData([listing.id], [attendee.id]),
    ).toBeUndefined();
  });

  test("keys decrypted chosen answers by question", async () => {
    const question = await createQuestion("Colour?");
    const blue = await addAnswer(question.id, 0, "Blue");
    const listing = await createTestListing();
    const attendee = await createAttendee(listing.id);
    await saveAttendeeAnswers(new Map([[attendee.id, [blue.id]]]));

    expect(await getAttendeeAnswersByQuestion(attendee.id)).toEqual(
      new Map([[question.id, { answerId: blue.id, answerText: "Blue" }]]),
    );
  });
});
