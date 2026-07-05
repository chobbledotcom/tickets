/**
 * Servicing §21 — end-to-end narrative scenarios.
 *
 * Story-driven e2e flows (TestBrowser) that string the units together the way
 * a real operator would hit them — each is one coherent narrative, not a
 * grab-bag of assertions. They reuse the same fixtures the [I] tests build.
 *
 * Implementation contract (test-first):
 *   - Servicing routes: `GET/POST /admin/servicing/new` (create),
 *     `GET/POST /admin/servicing/:id` (edit), `POST /admin/servicing/:id/delete`,
 *     `POST /admin/servicing/:id/duplicate`. Form fields mirror the attendee
 *     form minus the contact/payment fields (§0/§6).
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { findServicingLink, setupBrowserWithHold } from "#test-utils";
import { useE2eBrowser } from "#test-utils/e2e.ts";

// jscpd:ignore-end

const ROOM_A = { max_attendees: "5", name: "Room A" } as const;
const DAILY_ROOM_A = {
  duration_days: "1",
  listing_type: "daily",
  max_attendees: "5",
  max_quantity: "5",
  maximum_days_after: "365",
  name: "Room A",
} as const;

const costListingIdFromForm = (html: string): string => {
  const match = html.match(
    /<select name="target_listing_id">[\s\S]*?<option value="(\d+)"/,
  );
  if (!match) throw new Error("no cost target listing in servicing form");
  return match[1]!;
};

describe("e2e: servicing — narrative scenarios", () => {
  const ctx = useE2eBrowser();

  test("Boiler service blocks a room, then frees it", async () => {
    const browser = ctx.browser;
    await setupBrowserWithHold(
      browser,
      { ...DAILY_ROOM_A, max_attendees: "1" },
      "Boiler Service",
    );
    expect(browser.containsText("Boiler Service")).toBe(true);

    await browser.visit(findServicingLink(browser));
    await browser.submitForm({}, "Delete Service Event");
    expect(browser.containsText("Boiler Service")).toBe(false);
  });

  test("Annual servicing schedule, duplicated for next year", async () => {
    const browser = ctx.browser;
    await setupBrowserWithHold(
      browser,
      {
        ...DAILY_ROOM_A,
        max_attendees: "10",
        maximum_days_after: "1000",
        name: "Annual Room",
      },
      "Annual Inspection",
    );
    await browser.visit(findServicingLink(browser));
    await browser.submitForm({}, "Duplicate");

    expect(browser.containsText("Annual Inspection")).toBe(true);
    await browser.visit("/admin/");
    const servicingLinks = browser.links
      .filter((l) => l.href.includes("/admin/servicing/"))
      .map((l) => l.href);
    expect(servicingLinks.length).toBeGreaterThanOrEqual(2);
  });

  test("The morning dashboard glance", async () => {
    const browser = ctx.browser;
    await setupBrowserWithHold(browser, { ...ROOM_A }, "Boiler Service");

    await browser.visit("/admin/");
    expect(browser.containsText("Boiler Service")).toBe(true);
    expect(browser.currentHtml).toMatch(/\/admin\/servicing\/\d+/);
    await settings.update.showPublicSite(true);
    await browser.visit("/");
    expect(browser.containsText("Boiler Service")).toBe(false);
  });

  test("The curious operator pokes at URLs", async () => {
    const browser = ctx.browser;
    await setupBrowserWithHold(browser, { ...ROOM_A }, "Boiler Service");
    const id = findServicingLink(browser).match(
      /\/admin\/servicing\/(\d+)/,
    )?.[1];
    if (!id) throw new Error("no servicing id in redirect URL");

    await browser.visit(`/admin/attendees/${id}`);
    expect(browser.currentHtml).toMatch(/not found|404/i);
    await browser.visit(`/admin/attendees/${id}/merge`);
    expect(browser.currentHtml).toMatch(/not found|404/i);

    await browser.visit(`/admin/servicing/${id}`);
    expect(browser.containsText("Boiler Service")).toBe(true);
    expect(browser.currentHtml).not.toContain("@example.com");
  });

  test("A hold with a custom question", async () => {
    const browser = ctx.browser;
    await setupBrowserWithHold(browser, { ...ROOM_A }, "Boiler Service");
    expect(browser.containsText("Boiler Service")).toBe(true);
    await browser.visit(findServicingLink(browser));
    expect(browser.containsText("Boiler Service")).toBe(true);
  });

  test("Costing a boiler service", async () => {
    const browser = ctx.browser;
    await setupBrowserWithHold(browser, { ...ROOM_A }, "Boiler Service");

    await browser.visit(findServicingLink(browser));
    await browser.submitForm(
      {
        amount: "90.00",
        memo: "Boiler part",
        target_listing_id: costListingIdFromForm(browser.currentHtml),
      },
      "Record Cost",
    );
    expect(browser.containsText("90")).toBe(true);
  });
});
