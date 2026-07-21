import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ticketViewPage } from "#templates/tickets.tsx";
import { registerPublicTemplateHooks } from "#test/templates/public/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

describe("ticketViewPage listing date and location", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  const token = "AABB0011CCDDEEFF";

  /** Render the ticket-view page for a single purchase-only listing. */
  const purchaseOnlyViewHtml = () =>
    ticketViewPage([
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ purchase_only: true }),
        },
        token,
      },
    ]);

  test("shows listing date when entry has non-empty listing date", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ date: "2026-06-15T14:00:00.000Z" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
  });

  test("does not show listing date when listing has empty date", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ date: "" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).not.toContain("ticket-card-date");
  });

  test("shows a single booking date for a one-day daily booking", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee({ date: "2026-06-15" }),
          listing: testListingWithCount({
            duration_days: 1,
            listing_type: "daily",
          }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    // Duration 1 → a single day, not a range.
    expect(html).toContain("Booking Date: Monday 15 June 2026");
    expect(html).not.toContain("15–");
  });

  test("shows location when entry has non-empty location", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ location: "Village Hall" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("Village Hall");
  });

  test("does not show location when listing has empty location", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ location: "" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).not.toContain("ticket-card-location");
  });

  test("shows both listing date and location when both are present", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({
            date: "2026-06-15T14:00:00.000Z",
            location: "Town Centre",
          }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
    expect(html).toContain("Town Centre");
  });

  test("shows each ticket as separate card with SVG endpoint reference", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee({ id: 1 }),
          listing: testListingWithCount({
            date: "2026-06-15T14:00:00.000Z",
            id: 1,
          }),
        },
        token: "AABB0011CCDDEEF1",
      },
      {
        entry: {
          attendee: testAttendee({ id: 2 }),
          listing: testListingWithCount({ date: "", id: 2 }),
        },
        token: "AABB0011CCDDEEF2",
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("/t/AABB0011CCDDEEF1/svg");
    expect(html).toContain("/t/AABB0011CCDDEEF2/svg");
    expect(html).toContain("2 Tickets");
  });

  test("hides QR code and token for purchase_only listings", () => {
    const html = purchaseOnlyViewHtml();
    expect(html).not.toContain("ticket-card-qr");
    expect(html).not.toContain("ticket-card-token");
    expect(html).not.toContain("/svg");
  });

  test("hides wallet links for purchase_only listings", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ purchase_only: true }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards, true, true);
    expect(html).not.toContain("wallet-link");
    expect(html).not.toContain("Apple Wallet");
    expect(html).not.toContain("Google Wallet");
  });

  test("hides non-transferable notice for purchase_only listings", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({
            non_transferable: true,
            purchase_only: true,
          }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).not.toContain("Non-transferable");
  });

  test("shows Your Purchase heading for purchase_only listings", () => {
    const html = purchaseOnlyViewHtml();
    expect(html).toContain("Your Purchase");
    expect(html).not.toContain("Ticket");
  });

  test("shows ticket count heading for mixed listings", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee({ id: 1 }),
          listing: testListingWithCount({ id: 1, purchase_only: true }),
        },
        token: "AABB0011CCDDEEF1",
      },
      {
        entry: {
          attendee: testAttendee({ id: 2 }),
          listing: testListingWithCount({ id: 2, purchase_only: false }),
        },
        token: "AABB0011CCDDEEF2",
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("2 Tickets");
    expect(html).not.toContain("Your Purchase");
  });

  test("renders multi-day booking range when daily listing has duration > 1", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee({ date: "2026-06-12" }),
          listing: testListingWithCount({
            duration_days: 3,
            listing_type: "daily",
          }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    // duration=3 starting 2026-06-12 → covers 12, 13, 14 inclusive.
    expect(html).toContain("12–14 June 2026");
  });
});
