import { expect } from "@std/expect";
import { getNotesFor } from "#db/notes/queries.ts";
import { questionNotes } from "#db/notes/target.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";

/** Assert that a question carries exactly one owner note with the text. */
export const expectSingleQuestionNote = async (
  questionId: number,
  note: string,
): Promise<void> => {
  const notes = await getNotesFor(
    questionNotes(questionId),
    await getTestPrivateKey(),
  );
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    entity_id: questionId,
    entity_type: "question",
    note,
    type: "owner",
  });
};
