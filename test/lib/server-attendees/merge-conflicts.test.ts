// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  answersTable,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";
import {
  adminFormPost,
  adminGet,
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  extractInputValue,
} from "#test-utils";

// jscpd:ignore-end
import { getMergeVersion } from "./helpers.ts";

describeWithEnv(
  "server (admin attendees) > merge conflicts",
  { db: true },
  () => {
    describe("merge with answer conflicts", () => {
      test("GET merge page renders answer decision table when conflicts exist", async () => {
        const listing = await createTestListing({ maxAttendees: 10 });
        const q = await questionsTable.insert({
          displayType: "radio",
          text: "Favourite colour?",
        });
        const a1 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 0,
          text: "Red",
        });
        const a2 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 1,
          text: "Blue",
        });
        await setListingQuestions(listing.id, [q.id]);

        const { attendee: target } = await createTestAttendeeDirect(
          listing.id,
          "Jane Doe",
          "jane@example.com",
        );
        const listing2 = await createTestListing({
          maxAttendees: 10,
          name: "E2",
        });
        await setListingQuestions(listing2.id, [q.id]);
        const { token: sourceToken } = await createTestAttendeeDirect(
          listing2.id,
          "John Smith",
          "john@example.com",
        );

        // Assign different answers
        const { saveAttendeeAnswers: save } = await import(
          "#shared/db/questions.ts"
        );
        await save(new Map([[target.id, [a1.id]]]));
        // Need source attendee ID
        const { getAttendeesByTokens } = await import(
          "#shared/db/attendees.ts"
        );
        const [sourceData] = await getAttendeesByTokens([sourceToken]);
        await save(new Map([[sourceData!.id, [a2.id]]]));

        const response = await adminGet(
          `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
            sourceToken,
          )}`,
        );
        await expectHtmlResponse(
          response,
          200,
          "Custom Question Answers",
          "Favourite colour?",
        );
      });

      test("POST merge applies selected answer winners", async () => {
        const listing = await createTestListing({ maxAttendees: 10 });
        const q = await questionsTable.insert({
          displayType: "radio",
          text: "Size?",
        });
        const a1 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 0,
          text: "Small",
        });
        const a2 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 1,
          text: "Large",
        });
        await setListingQuestions(listing.id, [q.id]);

        const { attendee: target } = await createTestAttendeeDirect(
          listing.id,
          "Jane Doe",
          "jane@example.com",
        );
        const listing2 = await createTestListing({
          maxAttendees: 10,
          name: "E2",
        });
        await setListingQuestions(listing2.id, [q.id]);
        const { token: sourceToken } = await createTestAttendeeDirect(
          listing2.id,
          "John Smith",
          "john@example.com",
        );

        const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
          await import("#shared/db/questions.ts");
        const { getAttendeesByTokens } = await import(
          "#shared/db/attendees.ts"
        );
        const [sourceData] = await getAttendeesByTokens([sourceToken]);
        await save(new Map([[target.id, [a1.id]]])); // Small
        await save(new Map([[sourceData!.id, [a2.id]]])); // Large

        // Get merge version from preview page
        const previewPage = await adminGet(
          `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
            sourceToken,
          )}`,
        );
        const previewHtml = await previewPage.text();
        const mergeVersion = extractInputValue(previewHtml, "merge_version")!;

        // Submit choosing source answer
        const { response } = await adminFormPost(
          `/admin/attendees/${target.id}/merge`,
          {
            merge_version: mergeVersion,
            source_token: sourceToken,
            [`answer_${q.id}`]: "source",
          },
        );
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("Merged"), true);

        // Verify target now has source's answer (Large)
        const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
        expect(finalAnswers.get(q.id)?.answerId).toBe(a2.id);
      });

      test("POST merge reports skipped bookings in flash", async () => {
        const listing = await createTestListing({ maxAttendees: 10 });

        const { attendee: target } = await createTestAttendeeDirect(
          listing.id,
          "Jane Doe",
          "jane@example.com",
        );
        const { token: sourceToken } = await createTestAttendeeDirect(
          listing.id,
          "John Smith",
          "john@example.com",
        );

        // Get merge version
        const previewPage = await adminGet(
          `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
            sourceToken,
          )}`,
        );
        const html = await previewPage.text();
        const mergeVersion = extractInputValue(html, "merge_version")!;

        const bookingKey = `${listing.id}:null:0:0`;
        const { response } = await adminFormPost(
          `/admin/attendees/${target.id}/merge`,
          {
            merge_version: mergeVersion,
            source_token: sourceToken,
            [`booking_${bookingKey}`]: "skip_source",
          },
        );
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("1 booking(s) skipped"),
          true,
        );
      });

      test("stale preview version rejected", async () => {
        const listing = await createTestListing({ maxAttendees: 10 });
        const listing2 = await createTestListing({
          maxAttendees: 10,
          name: "E2",
        });

        const { attendee: target } = await createTestAttendeeDirect(
          listing.id,
          "Jane Doe",
          "jane@example.com",
        );
        const { token: sourceToken } = await createTestAttendeeDirect(
          listing2.id,
          "John Smith",
          "john@example.com",
        );

        // Submit with wrong version — bounced back to the Actions tab's merge
        // panel with the validation error flashed and the search re-armed.
        const { response } = await adminFormPost(
          `/admin/attendees/${target.id}/merge`,
          {
            merge_version: "stale-version",
            source_token: sourceToken,
          },
        );
        expectRedirect(
          response,
          `/admin/attendees/${target.id}/actions`,
          `token=${encodeURIComponent(sourceToken)}`,
        );
        expectFlash(response, expect.stringContaining("out of date"), false);
      });

      test("POST merge with clear answer choice clears the answer", async () => {
        const listing = await createTestListing({ maxAttendees: 10 });
        const q = await questionsTable.insert({
          displayType: "radio",
          text: "Diet?",
        });
        const a1 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 0,
          text: "Vegan",
        });
        const a2 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 1,
          text: "Keto",
        });
        await setListingQuestions(listing.id, [q.id]);

        const { attendee: target } = await createTestAttendeeDirect(
          listing.id,
          "Jane Doe",
          "jane@example.com",
        );
        const listing2 = await createTestListing({
          maxAttendees: 10,
          name: "E2",
        });
        await setListingQuestions(listing2.id, [q.id]);
        const { token: sourceToken } = await createTestAttendeeDirect(
          listing2.id,
          "John Smith",
          "john@example.com",
        );

        const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
          await import("#shared/db/questions.ts");
        const { getAttendeesByTokens } = await import(
          "#shared/db/attendees.ts"
        );
        const [sourceData] = await getAttendeesByTokens([sourceToken]);
        await save(new Map([[target.id, [a1.id]]]));
        await save(new Map([[sourceData!.id, [a2.id]]]));

        const mergeVersion = await getMergeVersion(target.id, sourceToken);

        const { response } = await adminFormPost(
          `/admin/attendees/${target.id}/merge`,
          {
            merge_version: mergeVersion,
            source_token: sourceToken,
            [`answer_${q.id}`]: "clear",
          },
        );
        expect(response.status).toBe(302);

        const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
        expect(finalAnswers.has(q.id)).toBe(false);
      });

      test("POST merge with target answer choice keeps target answer", async () => {
        const listing = await createTestListing({ maxAttendees: 10 });
        const q = await questionsTable.insert({
          displayType: "radio",
          text: "Shirt?",
        });
        const a1 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 0,
          text: "M",
        });
        const a2 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 1,
          text: "L",
        });
        await setListingQuestions(listing.id, [q.id]);

        const { attendee: target } = await createTestAttendeeDirect(
          listing.id,
          "Jane Doe",
          "jane@example.com",
        );
        const listing2 = await createTestListing({
          maxAttendees: 10,
          name: "E2",
        });
        await setListingQuestions(listing2.id, [q.id]);
        const { token: sourceToken } = await createTestAttendeeDirect(
          listing2.id,
          "John Smith",
          "john@example.com",
        );

        const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
          await import("#shared/db/questions.ts");
        const { getAttendeesByTokens } = await import(
          "#shared/db/attendees.ts"
        );
        const [sourceData] = await getAttendeesByTokens([sourceToken]);
        await save(new Map([[target.id, [a1.id]]]));
        await save(new Map([[sourceData!.id, [a2.id]]]));

        const mergeVersion = await getMergeVersion(target.id, sourceToken);

        const { response } = await adminFormPost(
          `/admin/attendees/${target.id}/merge`,
          {
            merge_version: mergeVersion,
            source_token: sourceToken,
            [`answer_${q.id}`]: "target",
          },
        );
        expect(response.status).toBe(302);

        const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
        expect(finalAnswers.get(q.id)?.answerId).toBe(a1.id);
      });

      test("POST merge auto-adopts source-only non-conflicting answer", async () => {
        const listing1 = await createTestListing({ maxAttendees: 10 });
        const listing2 = await createTestListing({
          maxAttendees: 10,
          name: "E2",
        });
        const q = await questionsTable.insert({
          displayType: "radio",
          text: "Colour?",
        });
        const a1 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 0,
          text: "Green",
        });
        await setListingQuestions(listing1.id, [q.id]);
        await setListingQuestions(listing2.id, [q.id]);

        const { attendee: target } = await createTestAttendeeDirect(
          listing1.id,
          "Jane Doe",
          "jane@example.com",
        );
        const { token: sourceToken } = await createTestAttendeeDirect(
          listing2.id,
          "John Smith",
          "john@example.com",
        );

        // Only source has an answer — no conflict
        const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
          await import("#shared/db/questions.ts");
        const { getAttendeesByTokens } = await import(
          "#shared/db/attendees.ts"
        );
        const [sourceData] = await getAttendeesByTokens([sourceToken]);
        await save(new Map([[sourceData!.id, [a1.id]]]));

        const mergeVersion = await getMergeVersion(target.id, sourceToken);

        const { response } = await adminFormPost(
          `/admin/attendees/${target.id}/merge`,
          {
            merge_version: mergeVersion,
            source_token: sourceToken,
          },
        );
        expect(response.status).toBe(302);

        const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
        expect(finalAnswers.get(q.id)?.answerId).toBe(a1.id);
      });

      test("POST merge keeps target-only non-conflicting answer", async () => {
        const listing1 = await createTestListing({ maxAttendees: 10 });
        const listing2 = await createTestListing({
          maxAttendees: 10,
          name: "E2",
        });
        const q = await questionsTable.insert({
          displayType: "radio",
          text: "Food?",
        });
        const a1 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 0,
          text: "Pizza",
        });
        await setListingQuestions(listing1.id, [q.id]);
        await setListingQuestions(listing2.id, [q.id]);

        const { attendee: target } = await createTestAttendeeDirect(
          listing1.id,
          "Jane Doe",
          "jane@example.com",
        );
        const { token: sourceToken } = await createTestAttendeeDirect(
          listing2.id,
          "John Smith",
          "john@example.com",
        );

        // Only target has an answer — no conflict
        const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
          await import("#shared/db/questions.ts");
        await save(new Map([[target.id, [a1.id]]]));

        const mergeVersion = await getMergeVersion(target.id, sourceToken);

        const { response } = await adminFormPost(
          `/admin/attendees/${target.id}/merge`,
          {
            merge_version: mergeVersion,
            source_token: sourceToken,
          },
        );
        expect(response.status).toBe(302);

        const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
        expect(finalAnswers.get(q.id)?.answerId).toBe(a1.id);
      });

      test("take_source on one path leaves the target's other package path alone", async () => {
        // The target booked the same listing twice — through package 7 and on
        // its own row. Taking the source for the STANDALONE conflict must
        // replace only that slot; the package row survives untouched.
        const listing = await createTestListing({ maxAttendees: 10 });
        const { createTestGroup } = await import("#test-utils");
        const group = await createTestGroup({
          isPackage: true,
          name: "KeepKit",
        });
        const { createAttendeeAtomic } = await import(
          "#shared/db/attendees.ts"
        );
        const made = await createAttendeeAtomic({
          bookings: [
            { listingId: listing.id, packageGroupId: group.id, quantity: 2 },
            { listingId: listing.id, quantity: 1 },
          ],
          email: "dual-target@example.com",
          name: "Dual Target",
        });
        expect(made.success).toBe(true);
        const target = (made as Extract<typeof made, { success: true }>)
          .attendees[0]!;
        const { token: sourceToken } = await createTestAttendeeDirect(
          listing.id,
          "John Smith",
          "john@example.com",
          3,
        );

        const mergeVersion = await getMergeVersion(target.id, sourceToken);
        const bookingKey = `${listing.id}:null:0:0`;
        const { response } = await adminFormPost(
          `/admin/attendees/${target.id}/merge`,
          {
            merge_version: mergeVersion,
            source_token: sourceToken,
            [`booking_${bookingKey}`]: "take_source",
          },
        );
        expect(response.status).toBe(302);

        const { queryAll } = await import("#shared/db/client.ts");
        const rows = await queryAll<{
          package_group_id: number;
          quantity: number;
        }>(
          `SELECT package_group_id, quantity FROM listing_attendees
          WHERE attendee_id = ? ORDER BY package_group_id ASC`,
          [target.id],
        );
        expect(
          rows.map((row) => [Number(row.package_group_id), row.quantity]),
        ).toEqual([
          [0, 3],
          [group.id, 2],
        ]);
      });

      test("POST merge with take_source replaces target booking", async () => {
        const listing = await createTestListing({ maxAttendees: 10 });

        const { attendee: target } = await createTestAttendeeDirect(
          listing.id,
          "Jane Doe",
          "jane@example.com",
        );
        // The source booked 3 — taking it must carry that quantity across.
        const { token: sourceToken } = await createTestAttendeeDirect(
          listing.id,
          "John Smith",
          "john@example.com",
          3,
        );

        const mergeVersion = await getMergeVersion(target.id, sourceToken);

        const bookingKey = `${listing.id}:null:0:0`;
        const { response } = await adminFormPost(
          `/admin/attendees/${target.id}/merge`,
          {
            merge_version: mergeVersion,
            source_token: sourceToken,
            [`booking_${bookingKey}`]: "take_source",
          },
        );
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("Merged"), true);

        const { queryAll } = await import("#shared/db/client.ts");
        const rows = await queryAll<{ quantity: number }>(
          "SELECT quantity FROM listing_attendees WHERE attendee_id = ?",
          [target.id],
        );
        expect(rows.map((row) => row.quantity)).toEqual([3]);
      });
    });
  },
);
