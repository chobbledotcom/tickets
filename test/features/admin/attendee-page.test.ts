/**
 * The tabbed attendee page as a whole: which tabs each role may open, and what
 * each one puts on the page. The definition is closed over by
 * `defineEntityPage`, so everything here goes through a real render.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeePage } from "#routes/admin/attendee-page.ts";
import { paymentRecoveryAction } from "#routes/admin/attendees-route-helpers.ts";
import { setBookingLineQuantity } from "#test/features/admin/refunds-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { withTestSession } from "#test-utils/session.ts";
import {
  bookAttendee,
  MANAGER,
  OWNER,
  renderTab,
  tabHtml,
} from "./attendee-page/helpers.ts";

describeWithEnv("the attendee page", { db: true }, () => {
  describe("its URLs", () => {
    test("mints the base page and each tab beneath it", () => {
      expect(attendeePage.path(7)).toBe("/admin/attendees/7");
      expect(attendeePage.path(7, "ledger")).toBe("/admin/attendees/7/ledger");
      expect(attendeePage.path(7, "actions")).toBe(
        "/admin/attendees/7/actions",
      );
    });

    test("selects payment recovery URLs from the attendee action schema", () => {
      const refresh = paymentRecoveryAction("refresh-payment");
      const review = paymentRecoveryAction("payment-review");
      expect(refresh.action).toBe("refresh-payment");
      expect(refresh.url(7)).toBe("/admin/attendees/7/refresh-payment");
      expect(review.action).toBe("payment-review");
      expect(review.url(7)).toBe("/admin/attendees/7/payment-review");
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
      for (
        const slug of [
          "edit",
          "logistics",
          "ledger",
          "activity",
          "actions",
        ]
      ) {
        expect(html).toContain(`/admin/attendees/${id}/${slug}`);
      }
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

  describe("the edit tab's return link", () => {
    test("comes back to wherever the caller said", async () => {
      const id = await bookAttendee();
      const response = await withTestSession(() =>
        attendeePage.renderPage(OWNER, id, "edit", {
          query: new URLSearchParams({ return_url: "/admin/calendar" }),
        })
      );
      // The hidden field itself — the admin nav also links /admin/calendar,
      // so a looser check would pass without the value ever being carried.
      expect(await response.text()).toContain(
        'name="return_url" type="hidden" value="/admin/calendar"',
      );
    });

    test("is not carried at all when the caller named nowhere", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "edit");
      // No return URL means no hidden field, rather than an empty one.
      expect(html).not.toContain('name="return_url" type="hidden"');
    });
  });

  describe("an attendee holding no places", () => {
    test("shows a ticket link while they hold a place", async () => {
      const listing = await createTestListing({});
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Has A Place",
        "has@example.com",
      );
      const html = await tabHtml(attendee.id, "");
      expect(html).toContain("/t/");
      expect(html).not.toContain("No quantity");
    });

    test("says so instead of linking a ticket page that would not open", async () => {
      const listing = await createTestListing({});
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "No Places",
        "none@example.com",
      );
      await setBookingLineQuantity(attendee.id, listing.id, 0);
      const html = await tabHtml(attendee.id, "");
      expect(html).toContain("No quantity");
      // The /t page 404s without a quantity, so it must not be linked at all.
      expect(html).not.toContain("/t/");
    });
  });

  describe("the overview's activity preview", () => {
    test("offers a way through to the full activity tab", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "");
      // The preview's own link, not the tab strip's — the strip would still
      // link activity even if the preview pointed somewhere else.
      expect(html).toContain(
        `<a href="/admin/attendees/${id}/activity">View all activity</a>`,
      );
    });
  });

  describe("the overview tab itself", () => {
    test("sits at the attendee's own address, with no slug after it", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "");
      expect(html).toContain(`href="/admin/attendees/${id}"`);
    });
  });

  describe("the admin nav", () => {
    test("marks Attendees as the section being viewed", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "");
      expect(html).toContain('class="active" href="/admin/attendees"');
    });
  });

  describe("adding a note", () => {
    test("is offered while the site can be written to", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "");
      expect(html).toContain("Add a note");
    });

    test("is not offered once the site is read-only", async () => {
      const id = await bookAttendee();
      using _env = withEnv({ READ_ONLY_FROM: "2000-01-01" });
      const html = await tabHtml(id, "");
      expect(html).not.toContain("Add a note");
    });
  });

  describe("the ledger tab", () => {
    test("links back to the full activity history", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "ledger");
      expect(html).toContain(
        `<a href="/admin/attendees/${id}/activity">See the full plain-English log on the Activity tab</a>`,
      );
    });
  });
});
