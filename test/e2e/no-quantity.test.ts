/**
 * End-to-end no-quantity (quantity = 0) sentinel flow, driven through the real
 * admin UI with TestBrowser (links followed by text, forms submitted by button).
 *
 * Flow: setup → login → create a listing → add a real booking (quantity 2) →
 *       confirm the customer ticket works → flip the line to no-quantity via the
 *       edit form's "no quantity" box → verify the ghost line STILL shows in the
 *       admin record views (right places) but VANISHES from the customer ticket
 *       and the listing's ticket affordances (wrong places).
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { awaitTestRequest } from "#test-utils";
import { setupAndLogin, useE2eBrowser } from "#test-utils/e2e.ts";

describe("e2e: no-quantity sentinel flow", () => {
  const ctx = useE2eBrowser();

  test("a line flipped to no-quantity stays in admin views but leaves the customer ticket", async () => {
    const browser = ctx.browser;
    await setupAndLogin(browser);

    // Create a free listing and one real booking (quantity 2).
    await browser.clickLink("Add Listing");
    await browser.submitForm(
      { max_attendees: "50", max_quantity: "5", name: "Workshop" },
      "Create Listing",
    );
    await browser.clickLink("Workshop");
    // The listing detail URL carries the id: /admin/listing/<id>.
    const listingId = browser.currentUrl.split("/").pop()!;
    expect(listingId).toMatch(/^\d+$/);

    await browser.submitForm(
      { name: "Ghost Guest", quantity: "2" },
      "Add Attendee",
    );
    expect(browser.containsText("Added Ghost Guest")).toBe(true);

    // The real booking has a live customer ticket: grab its /t token from the
    // listing's ticket column and confirm the ticket renders for the customer.
    const tokenMatch = browser.currentHtml.match(/href="[^"]*\/t\/([^"]+)"/);
    if (!tokenMatch) throw new Error("no customer ticket link for the booking");
    const token = tokenMatch[1]!;
    const liveTicket = await awaitTestRequest(`/t/${token}`);
    expect(liveTicket.status).toBe(200);
    expect(await liveTicket.text()).toContain("Workshop");

    // Flip the booked line to a no-quantity sentinel via the edit form's "no
    // quantity" box. submitForm keeps the grid's existing qty_<id>=2 and the
    // contact fields; we only tick noqty_<id>, which forces the line to 0.
    const editLink = browser.links.find((l) =>
      l.href.includes("/admin/attendees/"),
    );
    if (!editLink) throw new Error("no attendee edit link on the listing page");
    await browser.visit(editLink.href);
    await browser.submitForm({ [`noqty_${listingId}`]: "on" }, "Save Attendee");
    expect(browser.containsText("Updated Ghost Guest")).toBe(true);

    // RIGHT places — the ghost line still appears in the admin record views: the
    // attendee stays on the listing roster, flagged with the no-quantity badge
    // (admin keeps the record; only the live ticket affordance is replaced).
    await browser.visit(`/admin/listing/${listingId}`);
    expect(browser.containsText("Ghost Guest")).toBe(true); // still on the roster
    expect(browser.containsText("No quantity")).toBe(true); // flagged as a ghost

    // WRONG places — the customer ticket now 404s, and the listing's attendee
    // table no longer offers the live /t ticket link (the column shows the
    // no-quantity badge in its place).
    const deadTicket = await awaitTestRequest(`/t/${token}`);
    expect(deadTicket.status).toBe(404);
    expect(browser.currentHtml).not.toContain(`/t/${token}`);
  });
});
