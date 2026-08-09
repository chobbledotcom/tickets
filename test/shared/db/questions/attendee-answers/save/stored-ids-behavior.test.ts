import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryAll } from "#shared/db/client.ts";
import { saveAttendeeAnswers } from "#shared/db/questions/attendee-answers/save.ts";
import { getOrCreateStringIds } from "#shared/db/questions/strings.ts";
import {
  addAnswer,
  createAttendee,
  createQuestion,
} from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectRejects } from "#test-utils/servicing.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const storedRowsFor = (attendeeId: number) =>
  queryAll<{ answer_id: number | null; string_id: number | null }>(
    "SELECT answer_id, string_id FROM attendee_answers WHERE attendee_id = ? ORDER BY id",
    [attendeeId],
  );

const seedStoredIdAnswers = async () => {
  const choiceQuestion = await createQuestion("Choice");
  const answer = await addAnswer(choiceQuestion.id, 0, "Stored choice");
  const textQuestion = await createQuestion("Text", {
    displayType: "free_text",
  });
  const stringId = (await getOrCreateStringIds(["Stored"])).get("Stored")!;
  const attendee = await createAttendee((await createTestListing()).id);
  return { answer, attendee, stringId, textQuestion };
};

const saveSeed = async (
  before?: (
    seed: Awaited<ReturnType<typeof seedStoredIdAnswers>>,
  ) => Promise<void>,
) => {
  const seed = await seedStoredIdAnswers();
  if (before) await before(seed);
  const calls = await countDatabaseCalls(1, () =>
    saveAttendeeAnswers(
      new Map([
        [
          seed.attendee.id,
          {
            answerIds: [seed.answer.id],
            textAnswerIds: [
              { questionId: seed.textQuestion.id, stringId: seed.stringId },
            ],
          },
        ],
      ]),
    ),
  );
  return { calls, ...seed };
};

describeWithEnv(
  "db > attendee answers > stored id behavior",
  { db: true },
  () => {
    test("omits deleted choices and text questions", async () => {
      const { attendee, calls } = await saveSeed(async (seed) => {
        await execute("DELETE FROM answers WHERE id = ?", [seed.answer.id]);
        await execute("DELETE FROM questions WHERE id = ?", [
          seed.textQuestion.id,
        ]);
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
      const choiceQuestion = await createQuestion("Choice");
      const choice = await addAnswer(choiceQuestion.id, 0, "Chosen");
      const storedQuestion = await createQuestion("Stored", {
        displayType: "free_text",
      });
      const plainQuestion = await createQuestion("Plain", {
        displayType: "free_text",
      });
      const storedStringId = (
        await getOrCreateStringIds(["Stored answer"])
      ).get("Stored answer")!;
      const attendee = await createAttendee((await createTestListing()).id);
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
      const choiceQuestion = await createQuestion("Removed choice");
      const choice = await addAnswer(choiceQuestion.id, 0, "Removed");
      const plainQuestion = await createQuestion("Plain", {
        displayType: "free_text",
      });
      const attendee = await createAttendee((await createTestListing()).id);
      await execute("DELETE FROM answers WHERE id = ?", [choice.id]);

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
      const question = await createQuestion("Choice");
      const oldAnswer = await addAnswer(question.id, 0, "Old");
      const newAnswer = await addAnswer(question.id, 1, "New");
      const textQuestion = await createQuestion("Text", {
        displayType: "free_text",
      });
      const attendee = await createAttendee((await createTestListing()).id);
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
      expect(
        await queryAll(
          "SELECT id, times_selected FROM answers WHERE id IN (?, ?) ORDER BY id",
          [oldAnswer.id, newAnswer.id],
        ),
      ).toEqual([
        { id: oldAnswer.id, times_selected: 1 },
        { id: newAnswer.id, times_selected: 0 },
      ]);
    });

    test("clears stored answers in one database call", async () => {
      const question = await createQuestion("Choice");
      const answer = await addAnswer(question.id, 0, "Old");
      const attendee = await createAttendee((await createTestListing()).id);
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
