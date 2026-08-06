import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#shared/db/client.ts";
import { saveAttendeeAnswers } from "#shared/db/questions/attendee-answers/save.ts";
import { getOrCreateStringIds } from "#shared/db/questions/strings.ts";
import {
  addAnswer,
  createAttendee,
  createQuestion,
} from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

describeWithEnv("db > attendee answers > stored ids", { db: true }, () => {
  test("replaces choice and stored text ids for several attendees in one database call", async () => {
    const choiceQuestion = await createQuestion("Meal?");
    const firstChoice = await addAnswer(choiceQuestion.id, 0, "Soup");
    const lastChoice = await addAnswer(choiceQuestion.id, 1, "Salad");
    const textQuestion = await createQuestion("Notes?", {
      displayType: "free_text",
    });
    const stringIds = await getOrCreateStringIds(["Old", "First", "Last"]);
    const oldStringId = stringIds.get("Old")!;
    const firstStringId = stringIds.get("First")!;
    const lastStringId = stringIds.get("Last")!;
    const listing = await createTestListing();
    const firstAttendee = await createAttendee(listing.id, "Alice");
    const secondAttendee = await createAttendee(listing.id, "Bob");
    const oldAnswers = {
      answerIds: [firstChoice.id],
      textAnswerIds: [{ questionId: textQuestion.id, stringId: oldStringId }],
    };
    await saveAttendeeAnswers(
      new Map([
        [firstAttendee.id, oldAnswers],
        [secondAttendee.id, oldAnswers],
      ]),
    );

    const calls = await countDatabaseCalls(1, () =>
      saveAttendeeAnswers(
        new Map([
          [
            firstAttendee.id,
            {
              answerIds: [firstChoice.id, lastChoice.id],
              textAnswerIds: [
                { questionId: textQuestion.id, stringId: firstStringId },
                { questionId: textQuestion.id, stringId: lastStringId },
              ],
            },
          ],
          [
            secondAttendee.id,
            {
              answerIds: [lastChoice.id, firstChoice.id],
              textAnswerIds: [
                { questionId: textQuestion.id, stringId: lastStringId },
                { questionId: textQuestion.id, stringId: firstStringId },
              ],
            },
          ],
        ]),
      ),
    );
    expect(calls).toBe(1);
    expect(
      await queryAll(
        `SELECT attendee_id, question_id, answer_id, string_id
         FROM attendee_answers ORDER BY attendee_id, question_id`,
      ),
    ).toEqual([
      {
        answer_id: lastChoice.id,
        attendee_id: firstAttendee.id,
        question_id: choiceQuestion.id,
        string_id: null,
      },
      {
        answer_id: null,
        attendee_id: firstAttendee.id,
        question_id: textQuestion.id,
        string_id: lastStringId,
      },
      {
        answer_id: firstChoice.id,
        attendee_id: secondAttendee.id,
        question_id: choiceQuestion.id,
        string_id: null,
      },
      {
        answer_id: null,
        attendee_id: secondAttendee.id,
        question_id: textQuestion.id,
        string_id: firstStringId,
      },
    ]);
    expect(
      await queryAll(
        "SELECT id, times_selected FROM answers WHERE id IN (?, ?) ORDER BY id",
        [firstChoice.id, lastChoice.id],
      ),
    ).toEqual([
      { id: firstChoice.id, times_selected: 1 },
      { id: lastChoice.id, times_selected: 1 },
    ]);
    expect(
      await queryAll(
        "SELECT id, used_count FROM strings WHERE id IN (?, ?, ?) ORDER BY id",
        [oldStringId, firstStringId, lastStringId],
      ),
    ).toEqual([
      { id: oldStringId, used_count: 0 },
      { id: firstStringId, used_count: 1 },
      { id: lastStringId, used_count: 1 },
    ]);
  });
});
