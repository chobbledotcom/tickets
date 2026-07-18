// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
// jscpd:ignore-end
import { queryAll } from "#shared/db/client.ts";
import {
  createDualPackageAttendee,
  dualPackageRows,
} from "#test/lib/server-attendees/helpers.ts";
import {
  assignMergeAnswers,
  mergeNonConflictingAnswer,
  mergePair,
  mergePairWithQuestion,
  mergeWithAnswerConflict,
  submitMerge,
} from "#test/lib/server-attendees/merge.ts";
import {
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "server (admin attendees) > merge conflicts",
  { db: true },
  () => {
    describe("merge with answer conflicts", () => {
      test("GET merge page renders answer decision table when conflicts exist", async () => {
        const { a1, a2, target, sourceToken } = await mergePairWithQuestion(
          "Favourite colour?",
          ["Red", "Blue"],
        );

        await assignMergeAnswers(target.id, sourceToken, {
          source: [a2!.id],
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
        const response = await mergeWithAnswerConflict(
          "Size?",
          ["Small", "Large"],
          "source",
        );
        expectFlash(response, expect.stringContaining("Merged"), true);
      });

      test("POST merge reports skipped bookings in flash", async () => {
        const { listing1, target, sourceToken } = await mergePair({
          sameListing: true,
        });

        const { response } = await submitMerge(target.id, sourceToken, {
          [`booking_${listing1.id}:null:0:0`]: "skip_source",
        });
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
        await mergeWithAnswerConflict("Diet?", ["Vegan", "Keto"], "clear");
      });

      test("POST merge with target answer choice keeps target answer", async () => {
        await mergeWithAnswerConflict("Shirt?", ["M", "L"], "target");
      });

      test("POST merge auto-adopts source-only non-conflicting answer", async () => {
        await mergeNonConflictingAnswer("Colour?", "Green", "source");
      });

      test("POST merge keeps target-only non-conflicting answer", async () => {
        await mergeNonConflictingAnswer("Food?", "Pizza", "target");
      });

      test("take_source on one path leaves the target's other package path alone", async () => {
        // The target booked the same listing twice — through package 7 and on
        // its own row. Taking the source for the STANDALONE conflict must
        // replace only that slot; the package row survives untouched.
        const listing = await createTestListing({ maxAttendees: 10 });
        const group = await createTestGroup({
          isPackage: true,
          name: "KeepKit",
        });
        const target = await createDualPackageAttendee(
          listing.id,
          group.id,
          "Dual Target",
          "dual-target@example.com",
        );
        const { token: sourceToken } = await createTestAttendeeDirect(
          listing.id,
          "John Smith",
          "john@example.com",
          3,
        );

        const { response } = await submitMerge(target.id, sourceToken, {
          [`booking_${listing.id}:null:0:0`]: "take_source",
        });
        expect(response.status).toBe(302);

        expect(await dualPackageRows(target.id)).toEqual([
          [0, 3],
          [group.id, 2],
        ]);
      });

      test("POST merge with take_source replaces target booking", async () => {
        const { listing1, target, sourceToken } = await mergePair({
          sameListing: true,
          source: { quantity: 3 },
        });

        const { response } = await submitMerge(target.id, sourceToken, {
          [`booking_${listing1.id}:null:0:0`]: "take_source",
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("Merged"), true);

        const rows = await queryAll<{ quantity: number }>(
          "SELECT quantity FROM listing_attendees WHERE attendee_id = ?",
          [target.id],
        );
        expect(rows.map((row) => row.quantity)).toEqual([3]);
      });
    });
  },
);
