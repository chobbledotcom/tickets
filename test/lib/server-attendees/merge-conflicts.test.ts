// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  adminFormPost,
  adminGet,
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
} from "#test-utils";

// jscpd:ignore-end
import {
  assignMergeAnswers,
  mergePair,
  mergePairWithQuestion,
  submitMerge,
} from "./helpers.ts";

describeWithEnv(
  "server (admin attendees) > merge conflicts",
  { db: true },
  () => {
    describe("merge with answer conflicts", () => {
      test("GET merge page renders answer decision table when conflicts exist", async () => {
        const { a1, a2, target, sourceToken } =
          await mergePairWithQuestion("Favourite colour?", ["Red", "Blue"]);

        await assignMergeAnswers(target.id, sourceToken, {
          source: [a2.id],
          target: [a1.id],
        });

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
        const { q, a1, a2, target, sourceToken } =
          await mergePairWithQuestion("Size?", ["Small", "Large"]);

        await assignMergeAnswers(target.id, sourceToken, {
          source: [a2.id],
          target: [a1.id],
        });

        const { response } = await submitMerge(target.id, sourceToken, {
          [`answer_${q.id}`]: "source",
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("Merged"), true);

        const { getAttendeeAnswersByQuestion } = await import(
          "#shared/db/questions.ts"
        );
        const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
        expect(finalAnswers.get(q.id)?.answerId).toBe(a2.id);
      });

      test("POST merge reports skipped bookings in flash", async () => {
        const { listing1, target, sourceToken } = await mergePair({
          sameListing: true,
        });

        const { response } = await submitMerge(
          target.id,
          sourceToken,
          { [`booking_${listing1.id}:null:0:0`]: "skip_source" },
        );
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("1 booking(s) skipped"),
          true,
        );
      });

      test("stale preview version rejected", async () => {
        const { target, sourceToken } = await mergePair();

        // Submit with wrong version — bounced back to the Actions tab's merge
        // panel with the validation error flashed and the search re-armed.
        const { response } = await adminFormPost(
          `/admin/attendees/${target.id}/merge`,
          { merge_version: "stale-version", source_token: sourceToken },
        );
        expectRedirect(
          response,
          `/admin/attendees/${target.id}/actions`,
          `token=${encodeURIComponent(sourceToken)}`,
        );
        expectFlash(response, expect.stringContaining("out of date"), false);
      });

      test("POST merge with clear answer choice clears the answer", async () => {
        const { q, a1, a2, target, sourceToken } =
          await mergePairWithQuestion("Diet?", ["Vegan", "Keto"]);

        await assignMergeAnswers(target.id, sourceToken, {
          source: [a2.id],
          target: [a1.id],
        });

        const { response } = await submitMerge(target.id, sourceToken, {
          [`answer_${q.id}`]: "clear",
        });
        expect(response.status).toBe(302);

        const { getAttendeeAnswersByQuestion } = await import(
          "#shared/db/questions.ts"
        );
        const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
        expect(finalAnswers.has(q.id)).toBe(false);
      });

      test("POST merge with target answer choice keeps target answer", async () => {
        const { q, a1, a2, target, sourceToken } =
          await mergePairWithQuestion("Shirt?", ["M", "L"]);

        await assignMergeAnswers(target.id, sourceToken, {
          source: [a2.id],
          target: [a1.id],
        });

        const { response } = await submitMerge(target.id, sourceToken, {
          [`answer_${q.id}`]: "target",
        });
        expect(response.status).toBe(302);

        const { getAttendeeAnswersByQuestion } = await import(
          "#shared/db/questions.ts"
        );
        const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
        expect(finalAnswers.get(q.id)?.answerId).toBe(a1.id);
      });

      test("POST merge auto-adopts source-only non-conflicting answer", async () => {
        const { q, a1, target, sourceToken } =
          await mergePairWithQuestion("Colour?", ["Green"]);

        // Only source has an answer — no conflict
        await assignMergeAnswers(target.id, sourceToken, { source: [a1.id] });

        const { response } = await submitMerge(target.id, sourceToken);
        expect(response.status).toBe(302);

        const { getAttendeeAnswersByQuestion } = await import(
          "#shared/db/questions.ts"
        );
        const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
        expect(finalAnswers.get(q.id)?.answerId).toBe(a1.id);
      });

      test("POST merge keeps target-only non-conflicting answer", async () => {
        const { q, a1, target, sourceToken } =
          await mergePairWithQuestion("Food?", ["Pizza"]);

        // Only target has an answer — no conflict
        await assignMergeAnswers(target.id, sourceToken, { target: [a1.id] });

        const { response } = await submitMerge(target.id, sourceToken);
        expect(response.status).toBe(302);

        const { getAttendeeAnswersByQuestion } = await import(
          "#shared/db/questions.ts"
        );
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

        const { response } = await submitMerge(
          target.id,
          sourceToken,
          { [`booking_${listing.id}:null:0:0`]: "take_source" },
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
        const { listing1, target, sourceToken } = await mergePair({
          sameListing: true,
          source: { quantity: 3 },
        });

        const { response } = await submitMerge(
          target.id,
          sourceToken,
          { [`booking_${listing1.id}:null:0:0`]: "take_source" },
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
