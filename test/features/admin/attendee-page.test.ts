/**
 * The tabbed attendee page as a whole: which tabs each role may open, and what
 * each one puts on the page. The definition is closed over by
 * `defineEntityPage`, so everything here goes through a real render.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeePage } from "#routes/admin/attendee-page.ts";
import type { AuthSession } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withTestSession } from "#test-utils/session.ts";

const sessionAt = (adminLevel: AuthSession["adminLevel"]): AuthSession => ({
  adminLevel,
  token: "t",
  userId: 1,
  wrappedDataKey: null,
});

const OWNER = sessionAt("owner");
const MANAGER = sessionAt("manager");

/** One booked attendee to render the page against. */
const bookAttendee = async (): Promise<number> => {
  const listing = await createTestListing({});
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Ada Lovelace",
    "ada@example.com",
  );
  return attendee.id;
};

const renderTab = async (
  id: number,
  slug: string,
  session: AuthSession = OWNER,
): Promise<Response> =>
  await withTestSession(() => attendeePage.renderPage(session, id, slug));

const tabHtml = async (
  id: number,
  slug: string,
  session: AuthSession = OWNER,
): Promise<string> => await (await renderTab(id, slug, session)).text();

describeWithEnv("the attendee page", { db: true }, () => {
  describe("its URLs", () => {
    test("mints the base page and each tab beneath it", () => {
      expect(attendeePage.path(7)).toBe("/admin/attendees/7");
      expect(attendeePage.path(7, "ledger")).toBe("/admin/attendees/7/ledger");
      expect(attendeePage.path(7, "actions")).toBe(
        "/admin/attendees/7/actions",
      );
    });
  });

  describe("an attendee that is not there", () => {
    test("is not found rather than an empty page", async () => {
      const response = await renderTab(999_999, "");
      expect(response.status).toBe(404);
    });
  });

  describe("the overview tab", () => {
    test("names the attendee in the page title", async () => {
      const html = await tabHtml(await bookAttendee(), "");
      expect(html).toContain("Ada Lovelace");
    });

    test("offers every tab the owner may open", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "");
      for (const slug of ["edit", "logistics", "ledger", "activity", "actions"])
        expect(html).toContain(`/admin/attendees/${id}/${slug}`);
    });
  });

  describe("the ledger tab", () => {
    test("opens for the owner", async () => {
      const response = await renderTab(await bookAttendee(), "ledger");
      expect(response.status).toBe(200);
    });

    test("is not found for a manager, who may not see money movements", async () => {
      const response = await renderTab(await bookAttendee(), "ledger", MANAGER);
      expect(response.status).toBe(404);
    });

    test("is not even linked for a manager, so no one clicks a dead link", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "", MANAGER);
      expect(html).not.toContain(`/admin/attendees/${id}/ledger`);
    });
  });

  describe("the actions tab", () => {
    test("sends the reader back to the tab they came from", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "actions");
      // The return URL is threaded through as a query value, so the confirm
      // page can come back to this exact tab.
      expect(html).toContain(
        `/admin/attendees/${id}/resend-notification?return_url=${encodeURIComponent(
          `/admin/attendees/${id}/actions`,
        )}`,
      );
    });

    test("links a text message to this attendee on this listing", async () => {
      const listing = await createTestListing({});
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Grace Hopper",
        "grace@example.com",
      );
      const html = await tabHtml(attendee.id, "actions");
      // The separator is escaped in the rendered attribute.
      expect(html).toContain(
        `/admin/sms?listing=${listing.id}&amp;attendee=${attendee.id}`,
      );
    });

    test("offers deleting without a return URL, since there is nothing to come back to", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "actions");
      expect(html).toContain(`/admin/attendees/${id}/delete"`);
    });

    test("does not offer a refund for an attendee who never paid", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "actions");
      expect(html).not.toContain(`/admin/attendees/${id}/refund`);
    });
  });

  describe("the other tabs", () => {
    for (const slug of ["edit", "logistics", "activity"]) {
      test(`${slug} opens`, async () => {
        const response = await renderTab(await bookAttendee(), slug);
        expect(response.status).toBe(200);
      });
    }

    test("a tab that does not exist is not found", async () => {
      const response = await renderTab(await bookAttendee(), "nonsense");
      expect(response.status).toBe(404);
    });
  });
});
