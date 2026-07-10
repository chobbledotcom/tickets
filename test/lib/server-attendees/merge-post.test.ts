// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAttendeeRaw } from "#shared/db/attendees.ts";
import { queryAll } from "#shared/db/client.ts";
import {
  adminFormPost,
  adminGet,
  createPaidTestAttendee,
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  getListingActivityLog,
  testRequiresAuth,
} from "#test-utils";
import { setupListingAndDirectAttendee } from "./helpers.ts";
// jscpd:ignore-end
import { getMergeVersion, mergePair, submitMerge } from "./merge.ts";

/** Merge a paid source into a target on the same listing with its booking
 *  skipped, choosing `money` ("credit"/"writeoff") for the discarded charge,
 *  then assert the flash and activity-log messages. The two money-decision
 *  tests differ only in that decision and the resulting wording. */
const runMoneyDecisionMerge = async (
  money: string,
  paymentId: string,
  expectedFlash: string,
  expectedLog: string,
): Promise<void> => {
  const listing = await createTestListing({ maxAttendees: 10, unitPrice: 500 });
  const { attendee: target } = await createTestAttendeeDirect(
    listing.id,
    "Jane Doe",
    "jane@example.com",
    1,
  );
  const source = await createPaidTestAttendee(
    listing.id,
    "John Smith",
    "john@example.com",
    paymentId,
    500,
    3,
  );
  const bookingKey = `${listing.id}:null:0:0`;
  const mergeVersion = await getMergeVersion(target.id, source.ticket_token);
  const { response } = await adminFormPost(
    `/admin/attendees/${target.id}/merge`,
    {
      merge_version: mergeVersion,
      source_token: source.ticket_token,
      [`booking_${bookingKey}`]: "skip_source",
      [`money_${bookingKey}`]: money,
    },
  );
  expectFlash(response, expectedFlash, true);
  const log = (await getListingActivityLog(listing.id)).find((l) =>
    l.message.includes("merged into"),
  );
  expect(log?.message).toBe(expectedLog);
};

describeWithEnv("server (admin attendees) > merge post", { db: true }, () => {
  describe("POST /admin/attendees/:attendeeId/merge", () => {
    testRequiresAuth("/admin/attendees/1/merge", {
      body: {
        source_token: "some-token",
      },
      method: "POST",
      setup: async () => {
        const listing = await createTestListing({ maxAttendees: 10 });
        await createTestAttendeeDirect(
          listing.id,
          "John Doe",
          "john@example.com",
        );
      },
    });

    test("returns 404 for non-existent target attendee", async () => {
      const { response } = await adminFormPost("/admin/attendees/999/merge", {
        source_token: "some-token",
      });
      expect(response.status).toBe(404);
    });

    test("rejects missing source_token", async () => {
      const { attendee } = await setupListingAndDirectAttendee({
        listing: { maxAttendees: 10 },
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/merge`,
        {},
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Source token"), false);
    });

    test("rejects invalid source token", async () => {
      const { attendee } = await setupListingAndDirectAttendee({
        listing: { maxAttendees: 10 },
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/merge`,
        { source_token: "nonexistent-token" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("not found"), false);
    });

    test("rejects self-merge", async () => {
      const { attendee, token } = await setupListingAndDirectAttendee({
        listing: { maxAttendees: 10 },
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/merge`,
        { source_token: token },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Cannot merge an attendee with themselves"),
        false,
      );
    });

    test("a merge that adopts the source's email re-homes Previous bookings", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "MergeTok",
      });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Target",
        "target@example.com",
      );
      const { attendee: source, token: sourceToken } =
        await createTestAttendeeDirect(
          listing.id,
          "Source",
          "shared@example.com",
        );
      // A third attendee shares the SOURCE's email, so it can observe the token
      // move once the target adopts that email.
      const { attendee: sibling } = await createTestAttendeeDirect(
        listing.id,
        "Sibling",
        "shared@example.com",
      );
      const siblingPage = async (): Promise<string> =>
        (await adminGet(`/admin/attendees/${sibling.id}`)).text();

      // Before the merge the sibling lists the source, not the target.
      const before = await siblingPage();
      expect(before).toContain(`/admin/attendees/${source.id}`);
      expect(before).not.toContain(`/admin/attendees/${target.id}`);

      // Merge the source into the target, keeping the source's email.
      const mergeVersion = await getMergeVersion(target.id, sourceToken);
      await adminFormPost(`/admin/attendees/${target.id}/merge`, {
        merge_version: mergeVersion,
        pii_email: "source",
        source_token: sourceToken,
      });

      // The target now carries the shared email, so the sibling lists it; the
      // deleted source is gone from the table.
      const after = await siblingPage();
      expect(after).toContain(`/admin/attendees/${target.id}`);
      expect(after).not.toContain(`/admin/attendees/${source.id}`);
    });

    test("merges source listings into target and deletes source", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "Listing One",
      });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "Listing Two",
      });

      const { attendee: target } = await createTestAttendeeDirect(
        listing1.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken, attendee: source } =
        await createTestAttendeeDirect(
          listing2.id,
          "John Smith",
          "john@example.com",
        );

      const { response } = await submitMerge(target.id, sourceToken);

      // The flash names both attendees, and with no PII chosen the kept name is
      // the target's — so it reads "into Jane Doe", never "into John Smith".
      await expectFlashRedirect(
        `/admin/attendees/${target.id}`,
        expect.stringContaining("Merged John Smith into Jane Doe"),
      )(response);

      // The merge is recorded on the target's listing activity log, naming the
      // source and the kept (target) attendee.
      const mergeLog = (await getListingActivityLog(listing1.id)).find((l) =>
        l.message.includes("merged into"),
      );
      expect(mergeLog?.message).toBe(
        "Attendee 'John Smith' merged into 'Jane Doe'. 1 booking(s) moved",
      );

      // Source attendee should be deleted
      const deleted = await getAttendeeRaw(source.id);
      expect(deleted).toBeNull();

      // Target should still exist
      const surviving = await getAttendeeRaw(target.id);
      expect(surviving).not.toBeNull();

      // Target should now have both listing links
      const targetListingLinks = await queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_attendees WHERE attendee_id = ?",
        [target.id],
      );
      const listingIds = targetListingLinks.map((r) => r.listing_id).sort();
      expect(listingIds).toEqual([listing1.id, listing2.id].sort());
    });

    test("keeps target PII when no source fields selected", async () => {
      const { target, sourceToken } = await mergePair({
        source: { phone: "555-9999" },
        target: { phone: "555-1111" },
      });

      // Submit without choosing source for any field (all default to target)
      const { response } = await submitMerge(target.id, sourceToken);
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Merged"), true);

      // Verify target PII is preserved
      const getPage = await adminGet(`/admin/attendees/${target.id}`);
      await expectHtmlResponse(getPage, 200, "Jane Doe", "jane@example.com");
    });

    test("takes source PII fields when selected", async () => {
      const { target, sourceToken } = await mergePair({
        source: {
          address: "123 Source St",
          phone: "555-1234",
          special_instructions: "Source instructions",
        },
      });

      const mergeVersion = await getMergeVersion(target.id, sourceToken);
      // Choose source for all PII fields
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          pii_address: "source",
          pii_email: "source",
          pii_name: "source",
          pii_phone: "source",
          pii_special_instructions: "source",
          source_token: sourceToken,
        },
      );
      expect(response.status).toBe(302);

      // Verify target now has source's PII
      const getPage = await adminGet(`/admin/attendees/${target.id}`);
      await expectHtmlResponse(
        getPage,
        200,
        "John Smith",
        "john@example.com",
        "555-1234",
        "123 Source St",
        "Source instructions",
      );
    });

    test("skips conflicting listing booking during merge", async () => {
      const { listing1, target, source, sourceToken } = await mergePair({
        sameListing: true,
      });

      // Booking conflict: same listing, same start_at (null) — choose keep_target
      const { response } = await submitMerge(target.id, sourceToken, {
        [`booking_${listing1.id}:null:0:0`]: "keep_target",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Merged"), true);

      // Source deleted
      expect(await getAttendeeRaw(source.id)).toBeNull();

      // Target still has exactly one link to the listing (conflict was skipped)
      const links = await queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_attendees WHERE attendee_id = ?",
        [target.id],
      );
      expect(links.length).toBe(1);
      expect(links[0]!.listing_id).toBe(listing1.id);
    });

    test("POST merge credits a discarded paid conflict's money", async () => {
      await runMoneyDecisionMerge(
        "credit",
        "pi_merge_credit",
        "Merged John Smith into Jane Doe. 1 booking(s) skipped. 1 payment(s) credited",
        "Attendee 'John Smith' merged into 'Jane Doe'. 1 booking(s) skipped. 1 payment(s) kept as credit",
      );
    });

    test("POST merge writes off a discarded paid conflict's money", async () => {
      await runMoneyDecisionMerge(
        "writeoff",
        "pi_merge_writeoff",
        "Merged John Smith into Jane Doe. 1 booking(s) skipped. 1 payment(s) written off",
        "Attendee 'John Smith' merged into 'Jane Doe'. 1 booking(s) skipped. 1 payment(s) written off",
      );
    });

    test('POST merge joins multiple validation errors with "; "', async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "L1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "L2",
        unitPrice: 500,
      });
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      const targetResult = await createAttendeeAtomic({
        bookings: [
          { listingId: listing1.id, quantity: 1 },
          { listingId: listing2.id, quantity: 1 },
        ],
        email: "jane@example.com",
        name: "Jane Doe",
      });
      const target = (
        targetResult as Extract<typeof targetResult, { success: true }>
      ).attendees[0]!;
      const sourceResult = await createAttendeeAtomic({
        bookings: [
          { listingId: listing1.id, quantity: 3 },
          { listingId: listing2.id, quantity: 3 },
        ],
        email: "john@example.com",
        name: "John Smith",
      });
      const source = (
        sourceResult as Extract<typeof sourceResult, { success: true }>
      ).attendees[0]!;
      const { postListingSale } = await import("#test-utils/ledger.ts");
      await postListingSale({
        attendeeId: source.id,
        gross: 500,
        listingId: listing1.id,
      });
      await postListingSale({
        attendeeId: source.id,
        gross: 500,
        listingId: listing2.id,
      });

      const mergeVersion = await getMergeVersion(
        target.id,
        source.ticket_token,
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        { merge_version: mergeVersion, source_token: source.ticket_token },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Missing money decision"),
        false,
      );
      expectFlash(response, expect.stringContaining("; "), false);
    });
  });
});
