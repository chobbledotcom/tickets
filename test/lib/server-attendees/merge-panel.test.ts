// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { extractInputValue } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  bookTestAttendee,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminGet } from "#test-utils/session.ts";
import { setupListingAndDirectAttendee } from "./helpers.ts";
// jscpd:ignore-end
import {
  assignMergeAnswers,
  mergePair,
  mergePairWithQuestion,
} from "./merge.ts";

/** Fetch the merge Actions page for `target` with `sourceToken` set. */
const mergeActionsPage = (
  targetId: number,
  sourceToken: string,
): Promise<Response> =>
  adminGet(
    `/admin/attendees/${targetId}/actions?token=${encodeURIComponent(
      sourceToken,
    )}`,
  );

describeWithEnv("server (admin attendees) > merge panel", { db: true }, () => {
  describe("merge panel on the Actions tab", () => {
    testRequiresAuth("/admin/attendees/1/actions", {
      setup: async () => {
        await setupListingAndDirectAttendee({ listing: { maxAttendees: 10 } });
      },
    });

    test("returns 404 for non-existent attendee", async () => {
      const response = await adminGet("/admin/attendees/999/actions");
      expect(response.status).toBe(404);
    });

    test("shows the merge search form without a token param", async () => {
      const { attendee } = await setupListingAndDirectAttendee({
        listing: { maxAttendees: 10 },
      });
      const response = await adminGet(
        `/admin/attendees/${attendee.id}/actions`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Merge Attendee",
        "Search by Ticket Token",
      );
    });

    test("shows error when token not found", async () => {
      const { attendee } = await setupListingAndDirectAttendee({
        listing: { maxAttendees: 10 },
      });
      const response = await adminGet(
        `/admin/attendees/${attendee.id}/actions?token=invalid-token`,
      );
      await expectHtmlResponse(response, 200, "not found");
    });

    test("shows error when token matches same attendee", async () => {
      const { attendee, token } = await setupListingAndDirectAttendee({
        listing: { maxAttendees: 10 },
      });
      const response = await adminGet(
        `/admin/attendees/${attendee.id}/actions?token=${encodeURIComponent(
          token,
        )}`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Cannot merge an attendee with themselves",
      );
    });

    test("shows merge preview when valid source token provided", async () => {
      const { target, sourceToken } = await mergePair();
      const response = await mergeActionsPage(target.id, sourceToken);
      await expectHtmlResponse(
        response,
        200,
        "Merge Preview",
        "Jane Doe",
        "John Smith",
        "Merge and Delete Source Attendee",
        "Keep current: Jane Doe",
        "Use source: John Smith",
      );
    });

    test("the token search box focuses when idle and echoes the searched token", async () => {
      const { target, sourceToken } = await mergePair();
      // Idle panel: the search box is the tab's one job, so it takes focus
      // and starts empty.
      const idle = await expectHtmlResponse(
        await adminGet(`/admin/attendees/${target.id}/actions`),
        200,
      );
      expect(idle).toContain(" autofocus");
      expect(extractInputValue(idle, "token")).toBe("");
      // After a successful search the box echoes the token back (so the admin
      // can see what matched) and cedes focus to the decision form.
      const searched = await expectHtmlResponse(
        await mergeActionsPage(target.id, sourceToken),
        200,
      );
      expect(searched).not.toContain("autofocus");
      expect(extractInputValue(searched, "token")).toBe(sourceToken);
    });
  });

  describe("merge panel previews (coverage branches)", () => {
    test("shows merge preview with multiline field differences (address differs)", async () => {
      const { target, sourceToken } = await mergePair({
        source: {
          address: "456 Oak Ave",
          phone: "",
          special_instructions: "Gluten free",
        },
        target: {
          address: "123 Main St",
          phone: "",
          special_instructions: "No nuts",
        },
      });
      const response = await mergeActionsPage(target.id, sourceToken);
      // Multiline fields (address, special_instructions) differ — exercises renderFieldValue(val, true) with same=false
      await expectHtmlResponse(response, 200, "456 Oak Ave", "Gluten free");
    });

    test("shows merge preview when source has empty phone but target does not", async () => {
      // Source has no phone — exercises sourceValue || "—" branch
      const { target, sourceToken } = await mergePair({
        target: { phone: "555-1234" },
      });
      const response = await mergeActionsPage(target.id, sourceToken);
      await expectHtmlResponse(response, 200, "Merge Preview");
    });

    test("shows merge preview when source and target have empty email", async () => {
      // Empty email covers the `email || ""` branches on both target and source
      const { target, sourceToken } = await mergePair({
        source: { email: "" },
        target: { email: "" },
      });
      const response = await mergeActionsPage(target.id, sourceToken);
      await expectHtmlResponse(response, 200, "Merge Preview");
    });

    test("shows daily listing start_at date in source bookings list", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const dailyListing = await createTestListing({
        listingType: "daily",
        maxAttendees: 50,
        name: "Daily E",
      });
      const result = await bookAttendee(dailyListing, {
        date: "2026-05-01",
        email: "john@example.com",
        name: "John Smith",
      });
      if (!result.success) throw new Error("createAttendeeAtomic failed");
      const sourceToken = result.attendees[0]!.ticket_token;

      const response = await mergeActionsPage(target.id, sourceToken);
      // start_at is set for daily listings — exercises the b.start_at ? `— date` : "" branch
      await expectHtmlResponse(response, 200, "2026-05-01");
    });

    test("shows moveable booking row without decision column when no conflicts", async () => {
      const { target, sourceToken } = await mergePair();
      const response = await mergeActionsPage(target.id, sourceToken);
      // All bookings are moveable (different listings) — no Decision column rendered
      await expectHtmlResponse(response, 200, "Will be moved");
    });

    test("shows duplicate booking status when same listing with identical metadata", async () => {
      const { target, sourceToken } = await mergePair({ sameListing: true });
      const response = await mergeActionsPage(target.id, sourceToken);
      // Same listing, same qty/price/checked_in/refunded — classified as "duplicate"
      await expectHtmlResponse(
        response,
        200,
        "Duplicate",
        "Current quantity: 1. Source quantity: 1.",
        "Keep current booking",
        "Use source booking",
        "Skip source booking",
      );
    });

    test("leaves the decision cell empty for a moveable booking beside a conflict", async () => {
      const listing1 = await createTestListing({ maxAttendees: 10 });
      const listing2 = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing1.id,
        "Jane Doe",
        "jane@example.com",
      );
      const source = await bookTestAttendee(
        [listing1.id, listing2.id],
        "John Smith",
        "john@example.com",
      );

      await expectHtmlResponse(
        await mergeActionsPage(target.id, source.ticket_token),
        200,
        "Duplicate",
        "Will be moved",
        "Decision",
      );
    });

    test("shows named choices for conflicting custom answers", async () => {
      const { a1, a2, q, target, sourceToken } = await mergePairWithQuestion(
        "Meal",
        ["Pasta", "Curry"],
      );
      await assignMergeAnswers(target.id, sourceToken, {
        source: [a2!.id],
        target: [a1.id],
      });

      await expectHtmlResponse(
        await mergeActionsPage(target.id, sourceToken),
        200,
        "Keep (Jane Doe)",
        "Use (John Smith)",
        "None",
        "Pasta",
        "Curry",
        `name="answer_${q.id}"`,
      );
    });
  });
});
