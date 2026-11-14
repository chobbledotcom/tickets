import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { saveAttendeeAnswers } from "#db/questions/attendee-answers/save.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { sql } from "#db/sql.ts";
import {
  createAttendee,
  seedChoiceAndTextQuestions,
} from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectQueryRows } from "#test-utils/query-rows.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

describeWithEnv("db > attendee answers > stored ids", { db: true }, () => {
  test("replaces choice and stored text ids for several attendees in one database call", async () => {
    const {
      large: lastChoice,
      listing,
      notes: textQuestion,
      size: choiceQuestion,
      small: firstChoice,
    } = await seedChoiceAndTextQuestions();
    const stringIds = await getOrCreateStringIds(["Old", "First", "Last"]);
    const oldStringId = stringIds.get("Old")!;
    const firstStringId = stringIds.get("First")!;
    const lastStringId = stringIds.get("Last")!;
    const firstAttendee = await createAttendee(listing.id, "Alice");
    const secondAttendee = await createAttendee(listing.id, "Bob");
    const oldAnswers = {
      answerIds: [firstChoice.id],
      textAnswerIds: [{ questionId: textQuestion.id, stringId: oldStringId }],
    };

    // Each attendee lists the same choice and text ids in its own order. The
    // last id in each list is the one the save keeps.
    const selections = [
      {
        answerIds: [firstChoice.id, lastChoice.id],
        attendee: firstAttendee,
        stored: { answerId: lastChoice.id, stringId: lastStringId },
        stringIds: [firstStringId, lastStringId],
      },
      {
        answerIds: [lastChoice.id, firstChoice.id],
        attendee: secondAttendee,
        stored: { answerId: firstChoice.id, stringId: firstStringId },
        stringIds: [lastStringId, firstStringId],
      },
    ];
    await saveAttendeeAnswers(
      new Map(selections.map(({ attendee }) => [attendee.id, oldAnswers])),
    );

    const calls = await countDatabaseCalls(1, () =>
      saveAttendeeAnswers(
        new Map(
          selections.map(({ answerIds, attendee, stringIds: ids }) => [
            attendee.id,
            {
              answerIds,
              textAnswerIds: ids.map((stringId) => ({
                questionId: textQuestion.id,
                stringId,
              })),
            },
          ]),
        ),
      ),
    );
    expect(calls).toBe(1);
    await expectQueryRows(
      sql`SELECT attendee_id, question_id, answer_id, string_id
         FROM attendee_answers ORDER BY attendee_id, question_id`,
      selections.flatMap(({ attendee, stored }) => [
        {
          answer_id: stored.answerId,
          attendee_id: attendee.id,
          question_id: choiceQuestion.id,
          string_id: null,
        },
        {
          answer_id: null,
          attendee_id: attendee.id,
          question_id: textQuestion.id,
          string_id: stored.stringId,
        },
      ]),
    );
    await expectQueryRows(
      sql`SELECT id, times_selected FROM answers WHERE id IN (${firstChoice.id}, ${lastChoice.id}) ORDER BY id`,
      [
        { id: firstChoice.id, times_selected: 1 },
        { id: lastChoice.id, times_selected: 1 },
      ],
    );
    await expectQueryRows(
      sql`SELECT id, used_count FROM strings WHERE id IN (${oldStringId}, ${firstStringId}, ${lastStringId}) ORDER BY id`,
      [
        { id: oldStringId, used_count: 0 },
        { id: firstStringId, used_count: 1 },
        { id: lastStringId, used_count: 1 },
      ],
    );
  });
});
