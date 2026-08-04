import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  emptySelectedQuestionAnswers,
  loadAttendeeActivity,
  loadAttendeeActivityPreview,
  loadQuestionsForExisting,
} from "#routes/admin/attendee-page-data.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import { loadExistingLines } from "#shared/db/attendees/atomic-update.ts";
import { saveAttendeeAnswers } from "#shared/db/questions/attendee-answers/save.ts";
import { assignQuestion } from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withTestSession } from "#test-utils/session.ts";

describeWithEnv("attendee page activity and questions", { db: true }, () => {
  test("the overview returns three recent activities while the full tab returns all", async () => {
    const listing = await createTestListing({ name: "Activity listing" });
    const attendee = await bookTestAttendee([listing.id], "Activity attendee");
    for (const message of ["First", "Second", "Third", "Fourth"]) {
      await logActivity(message, listing, attendee.id);
    }

    const preview = await withTestSession(() =>
      loadAttendeeActivityPreview(attendee.id),
    );
    const full = await withTestSession(() => loadAttendeeActivity(attendee.id));

    expect(preview.map((entry) => entry.message)).toEqual([
      "Fourth",
      "Third",
      "Second",
    ]);
    expect(full.map((entry) => entry.message)).toEqual([
      "Fourth",
      "Third",
      "Second",
      "First",
    ]);
  });

  test("loads the questions and selected choices for existing booking lines", async () => {
    const listing = await createTestListing({ name: "Question listing" });
    const attendee = await bookTestAttendee([listing.id], "Question attendee");
    const { answer, question } = await assignQuestion(
      listing.id,
      "Which size?",
      "Small",
    );
    await saveAttendeeAnswers(new Map([[attendee.id, [answer.id]]]));

    const selected = await withTestSession(async () =>
      loadQuestionsForExisting(
        attendee.id,
        await loadExistingLines(attendee.id),
      ),
    );

    expect(selected.questions.map((item) => item.text)).toEqual([
      question.text,
    ]);
    expect(selected.selectedAnswerIds).toEqual([answer.id]);
    expect(selected.selectedTextAnswers).toEqual(new Map());
  });

  test("returns independent empty question selections when no question applies", async () => {
    const first = emptySelectedQuestionAnswers();
    const second = emptySelectedQuestionAnswers();

    first.selectedAnswerIds.push(1);
    first.selectedTextAnswers.set(2, "changed");

    expect(second).toEqual({
      questions: [],
      selectedAnswerIds: [],
      selectedTextAnswers: new Map(),
    });
  });
});
