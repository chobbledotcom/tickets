import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryAll } from "#db/client.ts";
import type { Answer, Question } from "#db/question-types.ts";
import { saveAttendeeAnswers } from "#db/questions/attendee-answers/save.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { sql } from "#db/sql.ts";
import {
  addAnswer,
  createAttendee,
  createQuestion,
} from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectQueryRows } from "#test-utils/query-rows.ts";
import { expectRejects } from "#test-utils/servicing.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";
import type { Attendee } from "#types";

const storedRowsFor = (attendeeId: number) =>
  queryAll<{ answer_id: number | null; string_id: number | null }>(
    sql`SELECT answer_id, string_id FROM attendee_answers WHERE attendee_id = ${attendeeId} ORDER BY id`,
  );

/** A choice question with one answer, a free-text question, and an attendee
 * ready to store answers for both. */
const seedAnswerTargets = async (
  choiceText: string,
  textText: string,
): Promise<{
  answer: Answer;
  attendee: Attendee;
  choiceQuestion: Question;
  textQuestion: Question;
}> => {
  const choiceQuestion = await createQuestion(choiceText);
  const answer = await addAnswer(choiceQuestion.id, 0, choiceText);
  const textQuestion = await createQuestion(textText, {
    displayType: "free_text",
  });
  const attendee = await createAttendee((await createTestListing()).id);
  return { answer, attendee, choiceQuestion, textQuestion };
};

/** The stored-id answer and text id for one attendee, saved after `before`
 * has changed the stored rows. */
const saveSeed = async (
  before?: (seed: {
    answer: Answer;
    attendee: Attendee;
    stringId: number;
    textQuestion: Question;
  }) => Promise<void>,
) => {
  const { answer, attendee, textQuestion } = await seedAnswerTargets(
    "Choice",
    "Text",
  );
  const stringId = (await getOrCreateStringIds(["Stored"])).get("Stored")!;
  if (before) await before({ answer, attendee, stringId, textQuestion });
  const calls = await countDatabaseCalls(1, () =>
    saveAttendeeAnswers(
      new Map([
        [
          attendee.id,
          {
            answerIds: [answer.id],
            textAnswerIds: [{ questionId: textQuestion.id, stringId }],
          },
        ],
      ]),
    ),
  );
  return { answer, attendee, calls, stringId };
};

describeWithEnv(
  "db > attendee answers > stored id behavior",
  { db: true },
  () => {
    test("omits deleted choices and text questions", async () => {
      const { attendee, calls } = await saveSeed(async (seed) => {
        await execute(sql`DELETE FROM answers WHERE id = ${seed.answer.id}`);
        await execute(
          sql`DELETE FROM questions WHERE id = ${seed.textQuestion.id}`,
        );
      });
      expect(calls).toBe(1);
      expect(await storedRowsFor(attendee.id)).toEqual([]);
    });

    test("saves one choice with one stored text id", async () => {
      const { answer, attendee, calls, stringId } = await saveSeed();
      expect(calls).toBe(1);
      expect(await storedRowsFor(attendee.id)).toEqual([
        { answer_id: answer.id, string_id: null },
        { answer_id: null, string_id: stringId },
      ]);
    });

    test("saves stored and plain text answers together", async () => {
      const {
        answer: choice,
        attendee,
        textQuestion: storedQuestion,
      } = await seedAnswerTargets("Choice", "Stored");
      const plainQuestion = await createQuestion("Plain", {
        displayType: "free_text",
      });
      const storedStringId = (
        await getOrCreateStringIds(["Stored answer"])
      ).get("Stored answer")!;
      await saveAttendeeAnswers(
        new Map([
          [
            attendee.id,
            {
              answerIds: [choice.id],
              textAnswerIds: [
                { questionId: storedQuestion.id, stringId: storedStringId },
              ],
              textAnswers: [
                { questionId: plainQuestion.id, text: "Plain answer" },
              ],
            },
          ],
        ]),
      );
      expect(await storedRowsFor(attendee.id)).toEqual([
        { answer_id: choice.id, string_id: null },
        { answer_id: null, string_id: storedStringId },
        { answer_id: null, string_id: expect.any(Number) },
      ]);
    });

    test("omits a deleted choice while saving plain text", async () => {
      const {
        answer: choice,
        attendee,
        textQuestion: plainQuestion,
      } = await seedAnswerTargets("Removed choice", "Plain");
      await execute(sql`DELETE FROM answers WHERE id = ${choice.id}`);

      await saveAttendeeAnswers(
        new Map([
          [
            attendee.id,
            {
              answerIds: [choice.id],
              textAnswers: [
                { questionId: plainQuestion.id, text: "Plain answer" },
              ],
            },
          ],
        ]),
      );

      expect(await storedRowsFor(attendee.id)).toEqual([
        { answer_id: null, string_id: expect.any(Number) },
      ]);
    });

    test("rolls back the stored id batch when an insert fails", async () => {
      const {
        answer: oldAnswer,
        attendee,
        choiceQuestion,
        textQuestion,
      } = await seedAnswerTargets("Choice", "Text");
      const newAnswer = await addAnswer(choiceQuestion.id, 1, "New");
      await saveAttendeeAnswers(
        new Map([[attendee.id, { answerIds: [oldAnswer.id] }]]),
      );
      await expectRejects(
        saveAttendeeAnswers(
          new Map([
            [
              attendee.id,
              {
                answerIds: [newAnswer.id],
                textAnswerIds: [
                  { questionId: textQuestion.id, stringId: null as never },
                ],
              },
            ],
          ]),
        ),
        /invalid attendee answer/,
      );
      expect(await storedRowsFor(attendee.id)).toEqual([
        { answer_id: oldAnswer.id, string_id: null },
      ]);
      await expectQueryRows(
        sql`SELECT id, times_selected FROM answers WHERE id IN (${oldAnswer.id}, ${newAnswer.id}) ORDER BY id`,
        [
          { id: oldAnswer.id, times_selected: 1 },
          { id: newAnswer.id, times_selected: 0 },
        ],
      );
    });

    test("clears stored answers in one database call", async () => {
      const { answer, attendee } = await seedAnswerTargets("Choice", "Text");
      await saveAttendeeAnswers(
        new Map([[attendee.id, { answerIds: [answer.id] }]]),
      );
      const calls = await countDatabaseCalls(1, () =>
        saveAttendeeAnswers(
          new Map([
            [
              attendee.id,
              { answerIds: [], textAnswerIds: [], textAnswers: [] },
            ],
          ]),
        ),
      );
      expect(calls).toBe(1);
      expect(await storedRowsFor(attendee.id)).toEqual([]);
    });

    test("does not call the database for no attendees", async () => {
      expect(
        await countDatabaseCalls(0, () => saveAttendeeAnswers(new Map())),
      ).toBe(0);
    });

    test("saves the array form in one batch call", async () => {
      const attendee = await createAttendee((await createTestListing()).id);
      expect(
        await countDatabaseCalls(1, () =>
          saveAttendeeAnswers(new Map([[attendee.id, []]])),
        ),
      ).toBe(1);
    });
  },
);
