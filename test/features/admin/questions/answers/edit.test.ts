import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { addAnswer, createQuestion } from "#test-utils/questions/helpers.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("server (admin questions)", { db: true }, () => {
  describe("answer edit page", () => {
    /** Look up one answer on a question by its id. */
    const findAnswer = async (qId: number, aId: number) => {
      const { getQuestionWithAnswers } = await import(
        "#db/questions/queries.ts"
      );
      const question = await getQuestionWithAnswers(qId);
      return question!.answers.find((a) => a.id === aId)!;
    };

    /** Insert an "answer"-trigger modifier directly and return its id. */
    const createAnswerModifier = async (name: string): Promise<number> => {
      const { modifiersTable } = await import("#db/modifiers.ts");
      const m = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name,
        trigger: "answer",
      });
      return m.id;
    };

    /**
     * POST an answer edit with the given modifier_id and assert the save was
     * rejected as an invalid modifier and left the answer unlinked.
     */
    const expectModifierRejected = async (
      qId: number,
      aId: number,
      modifierId: string,
    ) => {
      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: modifierId, text: "Pick" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Invalid modifier"), false);
      const { getAnswerModifierId } = await import(
        "#db/questions/aggregates.ts"
      );
      expect(await getAnswerModifierId(aId)).toBeNull();
    };

    testRequiresAuth("/admin/questions/1/answers/1/edit", {
      setup: async () => {
        const qId = await createQuestion("Answer edit auth");
        await addAnswer(qId, "Editable answer");
      },
    });

    test("returns 404 for a non-existent answer", async () => {
      const qId = await createQuestion("Edit missing answer");
      const response = await adminGet(
        `/admin/questions/${qId}/answers/999/edit`,
      );
      expectStatus(404)(response);
    });

    test("shows the edit page with the answer text and modifier option", async () => {
      const qId = await createQuestion("Edit answer page");
      const aId = await addAnswer(qId, "Editable");
      await createAnswerModifier("Surcharge tier");

      const response = await adminGet(
        `/admin/questions/${qId}/answers/${aId}/edit`,
      );
      const html = await expectHtmlResponse(
        response,
        200,
        "Editable",
        "Surcharge tier",
        'name="modifier_id"',
      );
      // The shared child-edit frame: a back link to the question and a small
      // context line naming it.
      expect(html).toContain(`href="/admin/questions/${qId}"`);
      expect(html).toContain("Answer for: Edit answer page");
    });

    test("updates the answer text and redirects to the question", async () => {
      const qId = await createQuestion("Edit text question");
      const aId = await addAnswer(qId, "Before");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: "", text: "After" },
      );
      await expectFlashRedirect(
        `/admin/questions/${qId}`,
        "Answer updated",
      )(response);

      expect((await findAnswer(qId, aId)).text).toBe("After");
    });

    test("deactivates an answer when the active box is unchecked", async () => {
      const qId = await createQuestion("Deactivate question");
      const aId = await addAnswer(qId, "Retired option");
      // New answers start active.
      expect((await findAnswer(qId, aId)).active).toBe(true);

      // An unchecked checkbox is simply absent from the POST body.
      await adminFormPost(`/admin/questions/${qId}/answers/${aId}/edit`, {
        modifier_id: "",
        text: "Retired option",
      });
      expect((await findAnswer(qId, aId)).active).toBe(false);

      // Re-checking it reactivates the answer.
      await adminFormPost(`/admin/questions/${qId}/answers/${aId}/edit`, {
        active: "on",
        modifier_id: "",
        text: "Retired option",
      });
      expect((await findAnswer(qId, aId)).active).toBe(true);
    });

    test("links the chosen modifier to the answer", async () => {
      const qId = await createQuestion("Link modifier question");
      const aId = await addAnswer(qId, "Large");
      const modifierId = await createAnswerModifier("Large surcharge");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: String(modifierId), text: "Large" },
      );
      expect(response.status).toBe(302);

      const { getAnswerModifierId } = await import(
        "#db/questions/aggregates.ts"
      );
      expect(await getAnswerModifierId(aId)).toBe(modifierId);
    });

    test("clears the modifier link when none is selected", async () => {
      const qId = await createQuestion("Clear modifier question");
      const aId = await addAnswer(qId, "Plain");
      const modifierId = await createAnswerModifier("Removable");

      const { setAnswerModifier, getAnswerModifierId } = await import(
        "#db/questions/aggregates.ts"
      );
      await setAnswerModifier(aId, modifierId);
      expect(await getAnswerModifierId(aId)).toBe(modifierId);

      await adminFormPost(`/admin/questions/${qId}/answers/${aId}/edit`, {
        modifier_id: "",
        text: "Plain",
      });
      expect(await getAnswerModifierId(aId)).toBeNull();
    });

    test("rejects a modifier id that is not an answer-trigger modifier", async () => {
      const qId = await createQuestion("Invalid modifier question");
      const aId = await addAnswer(qId, "Pick");

      await expectModifierRejected(qId, aId, "9999");
    });

    test("parses the modifier id as decimal, rejecting a hex-encoded id", async () => {
      const qId = await createQuestion("Hex modifier question");
      const aId = await addAnswer(qId, "Pick");
      const modifierId = await createAnswerModifier("Hex surcharge");

      // A forged POST sends the real modifier id hex-encoded. Decimal parsing
      // (radix 10) reads "0x…" as 0 → no such modifier → rejected. A base-0
      // parse would read the hex digits and wrongly accept it, silently linking
      // the modifier, so the id must be parsed as decimal.
      await expectModifierRejected(qId, aId, `0x${modifierId.toString(16)}`);
    });

    test("rejects linking a modifier that isn't answer-triggered", async () => {
      const qId = await createQuestion("Wrong trigger question");
      const aId = await addAnswer(qId, "Pick");
      const { modifiersTable } = await import("#db/modifiers.ts");
      const automatic = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Automatic fee",
        trigger: "automatic",
      });

      await expectModifierRejected(qId, aId, String(automatic.id));
    });

    test("rejects empty answer text", async () => {
      const qId = await createQuestion("Empty edit question");
      const aId = await addAnswer(qId, "Keep me");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: "", text: "" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Answer text is required"),
        false,
      );
    });

    test("logs the answer update", async () => {
      const qId = await createQuestion("Edit log question");
      const aId = await addAnswer(qId, "Logged before");
      await adminFormPost(`/admin/questions/${qId}/answers/${aId}/edit`, {
        modifier_id: "",
        text: "Logged after",
      });

      const response = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Logged after");
      expect(body).toContain("updated");
    });

    test("saves the edited selection total", async () => {
      const qId = await createQuestion("Edit total question");
      const aId = await addAnswer(qId, "Tally");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: "", text: "Tally", times_selected: "15" },
      );
      expect(response.status).toBe(302);

      const { getAnswerSelectionTotals } = await import(
        "#db/questions/aggregates.ts"
      );
      expect((await getAnswerSelectionTotals(qId)).get(aId)).toBe(15);
    });

    test("rejects a negative selection total without saving the edit", async () => {
      const qId = await createQuestion("Bad total question");
      const aId = await addAnswer(qId, "Before");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: "", text: "After", times_selected: "-3" },
      );
      expect(response.status).toBe(302);

      // The invalid aggregate aborts the whole edit, so the text is unchanged.
      expect((await findAnswer(qId, aId)).text).toBe("Before");
    });
  });

  describe("answer recalculate page", () => {
    /** Book an attendee on a listing and point them at the answer, so the
     * answer has one real selection to recalculate against. */
    const bookAnswer = async (
      listingId: number,
      answerId: number,
    ): Promise<void> => {
      const { attendeesApi } = await import("#db/attendees/api.ts");
      const { saveAttendeeAnswers } = await import(
        "#db/questions/attendee-answers/save.ts"
      );
      const result = await attendeesApi.createAttendeeAtomic({
        bookings: [{ listingId }],
        email: "booker@test.com",
        name: "Booker",
      });
      if (!result.success) throw new Error("Failed to create attendee");
      await saveAttendeeAnswers(
        new Map([[result.attendees[0]!.id, [answerId]]]),
      );
    };

    testRequiresAuth("/admin/questions/1/answers/1/recalculate", {
      setup: async () => {
        const qId = await createQuestion("Recalc auth");
        await addAnswer(qId, "Answer");
      },
    });

    test("returns 404 for a non-existent answer", async () => {
      const qId = await createQuestion("Recalc missing");
      const response = await adminGet(
        `/admin/questions/${qId}/answers/999/recalculate`,
      );
      expectStatus(404)(response);
    });

    test("shows the stored and recalculated totals", async () => {
      const qId = await createQuestion("Recalc page");
      const aId = await addAnswer(qId, "Pick");
      const listing = await createTestListing();
      await bookAnswer(listing.id, aId);

      const { answerAggregates } = await import("#db/questions/aggregates.ts");
      await answerAggregates.update(aId, { times_selected: 8 });

      const response = await adminGet(
        `/admin/questions/${qId}/answers/${aId}/recalculate`,
      );
      const body = await response.text();
      expect(response.status).toBe(200);
      // Stored (8) and the value rebuilt from the single booking (1).
      expect(body).toContain("<td>8</td>");
      expect(body).toContain("<td>1</td>");
      expect(body).toContain(
        `action="/admin/questions/${qId}/answers/${aId}/recalculate"`,
      );
    });

    test("re-renders with a prompt when no field is selected", async () => {
      const qId = await createQuestion("Recalc none");
      const aId = await addAnswer(qId, "Pick");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/recalculate`,
        {},
      );
      const body = await response.text();
      expect(response.status).toBe(400);
      expect(body).toContain("Choose at least one total to recalculate");
    });

    test("resets the stored total from attendee answers and redirects", async () => {
      const qId = await createQuestion("Recalc reset");
      const aId = await addAnswer(qId, "Pick");
      const listing = await createTestListing();
      await bookAnswer(listing.id, aId);

      const { answerAggregates, getAnswerSelectionTotals } = await import(
        "#db/questions/aggregates.ts"
      );
      await answerAggregates.update(aId, { times_selected: 99 });

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/recalculate`,
        { recalculate_fields: "times_selected" },
      );
      await expectFlashRedirect(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        "Selection total recalculated",
      )(response);
      expect((await getAnswerSelectionTotals(qId)).get(aId)).toBe(1);

      const log = await getAllActivityLog(10);
      const entry = log.find((e) =>
        e.message.includes("selection total recalculated"),
      );
      expect(entry?.message).toBe(
        `Answer 'Pick' selection total recalculated in question ${qId}`,
      );
    });
  });
});
