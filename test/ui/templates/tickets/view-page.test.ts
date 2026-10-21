import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import { ticketViewPage } from "#templates/tickets.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testTokenEntry } from "#test-utils/factories.ts";

describe("ticketViewPage ticket cards", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  const token = "AABB0011CCDDEEFF";

  /** Render the ticket-view page for a single purchase-only listing. */
  const purchaseOnlyViewHtml = () =>
    ticketViewPage([
      {
        entry: testTokenEntry({
          listing: { purchase_only: true },
        }),
        token,
      },
    ]);

  test("shows listing date when entry has non-empty listing date", () => {
    const cards = [
      {
        entry: testTokenEntry({
          listing: { date: "2026-06-15T14:00:00.000Z" },
        }),
        token,
      },
    ];
    const html = ticketViewPage(cards);
    assertStringIncludes(html, "Monday 15 June 2026 at 15:00 GMT+1");
  });

  test("does not show listing date when listing has empty date", () => {
    const cards = [
      {
        entry: testTokenEntry({ listing: { date: "" } }),
        token,
      },
    ];
    const html = ticketViewPage(cards);
    assert(!html.includes("ticket-card-date"));
  });

  test("shows a single booking date for a one-day daily booking", () => {
    const cards = [
      {
        entry: testTokenEntry({
          attendee: { date: "2026-06-15" },
          listing: {
            duration_days: 1,
            listing_type: "daily",
          },
        }),
        token,
      },
    ];
    const html = ticketViewPage(cards);
    // Duration 1 → a single day, not a range.
    assertStringIncludes(html, "Booking Date: Monday 15 June 2026");
    assert(!html.includes("15–"));
  });

  test("shows location when entry has non-empty location", () => {
    const cards = [
      {
        entry: testTokenEntry({ listing: { location: "Village Hall" } }),
        token,
      },
    ];
    const html = ticketViewPage(cards);
    assertStringIncludes(html, "Village Hall");
  });

  test("does not show location when listing has empty location", () => {
    const cards = [
      {
        entry: testTokenEntry({ listing: { location: "" } }),
        token,
      },
    ];
    const html = ticketViewPage(cards);
    assert(!html.includes("ticket-card-location"));
  });

  test("shows both listing date and location when both are present", () => {
    const cards = [
      {
        entry: testTokenEntry({
          listing: {
            date: "2026-06-15T14:00:00.000Z",
            location: "Town Centre",
          },
        }),
        token,
      },
    ];
    const html = ticketViewPage(cards);
    assertStringIncludes(html, "Monday 15 June 2026 at 15:00 GMT+1");
    assertStringIncludes(html, "Town Centre");
  });

  test("shows each ticket as separate card with SVG endpoint reference", () => {
    const cards = [
      {
        entry: testTokenEntry({
          attendee: { id: 1 },
          listing: {
            date: "2026-06-15T14:00:00.000Z",
            id: 1,
          },
        }),
        token: "AABB0011CCDDEEF1",
      },
      {
        entry: testTokenEntry({
          attendee: { id: 2 },
          listing: { date: "", id: 2 },
        }),
        token: "AABB0011CCDDEEF2",
      },
    ];
    const html = ticketViewPage(cards);
    assertStringIncludes(html, "/t/AABB0011CCDDEEF1/svg");
    assertStringIncludes(html, "/t/AABB0011CCDDEEF2/svg");
    assertStringIncludes(html, "2 Tickets");
  });

  test("hides QR code and token for purchase_only listings", () => {
    const html = purchaseOnlyViewHtml();
    assert(!html.includes("ticket-card-qr"));
    assert(!html.includes("ticket-card-token"));
    assert(!html.includes("/svg"));
  });

  test("hides wallet links for purchase_only listings", () => {
    const cards = [
      {
        entry: testTokenEntry({ listing: { purchase_only: true } }),
        token,
      },
    ];
    const html = ticketViewPage(cards, true, true);
    assert(!html.includes("wallet-link"));
    assert(!html.includes("Apple Wallet"));
    assert(!html.includes("Google Wallet"));
  });

  test("hides non-transferable notice for purchase_only listings", () => {
    const cards = [
      {
        entry: testTokenEntry({
          listing: {
            non_transferable: true,
            purchase_only: true,
          },
        }),
        token,
      },
    ];
    const html = ticketViewPage(cards);
    assert(!html.includes("Non-transferable"));
  });

  test("shows Your Purchase heading for purchase_only listings", () => {
    const html = purchaseOnlyViewHtml();
    assertStringIncludes(html, "Your Purchase");
    assert(!html.includes("Ticket"));
  });

  test("shows ticket count heading for mixed listings", () => {
    const cards = [
      {
        entry: testTokenEntry({
          attendee: { id: 1 },
          listing: { id: 1, purchase_only: true },
        }),
        token: "AABB0011CCDDEEF1",
      },
      {
        entry: testTokenEntry({
          attendee: { id: 2 },
          listing: { id: 2, purchase_only: false },
        }),
        token: "AABB0011CCDDEEF2",
      },
    ];
    const html = ticketViewPage(cards);
    assertStringIncludes(html, "2 Tickets");
    assert(!html.includes("Your Purchase"));
  });

  /** The page for one ordinary ticket, built from whatever this test puts on
   * the booking, on the thing booked, and on the card itself. */
  const oneCardPage = (
    entry: Parameters<typeof testTokenEntry>[0],
    onTheCard: { attachmentUrl?: string } = {},
  ): string =>
    ticketViewPage([{ entry: testTokenEntry(entry), token, ...onTheCard }]);

  test("shows the organiser's description of the thing booked", () => {
    const html = oneCardPage({ listing: { description: "A night of song" } });
    assertStringIncludes(html, "ticket-card-description");
    assertStringIncludes(html, "A night of song");
  });

  test("leaves the description out when the organiser wrote none", () => {
    assert(
      !oneCardPage({ listing: { description: "" } }).includes(
        "ticket-card-description",
      ),
    );
  });

  test("shows what was paid for a booking that cost money", () => {
    const html = oneCardPage({ attendee: { price_paid: "1500" } });
    assertStringIncludes(html, "ticket-card-price");
    assertStringIncludes(html, `Price: ${formatCurrency(1500)}`);
  });

  test("says nothing about price for a free booking", () => {
    assert(
      !oneCardPage({ attendee: { price_paid: "0" } }).includes(
        "ticket-card-price",
      ),
    );
  });

  test("warns that a non-transferable ticket needs ID at the door", () => {
    const html = oneCardPage({
      listing: { non_transferable: true, purchase_only: false },
    });
    assertStringIncludes(html, "ticket-card-notice");
    assertStringIncludes(html, "Non-transferable — ID required at entry");
  });

  test("offers the file the organiser attached, behind its signed link", () => {
    const html = oneCardPage(
      { listing: { attachment_name: "Guide.pdf" } },
      { attachmentUrl: "/attachment/42?a=7&exp=1&sig=x" },
    );
    assertStringIncludes(html, 'href="/attachment/42?a=7&amp;exp=1&amp;sig=x"');
    assertStringIncludes(html, "Download: Guide.pdf");
  });

  test("leaves out the download when the thing hands out no file", () => {
    assert(
      !oneCardPage({ listing: { attachment_name: "" } }).includes(
        "attachment-link",
      ),
    );
  });

  test("a package card that names its members keeps each member's file", () => {
    // The package card replaces the per-member cards, so a bundle buyer would
    // otherwise lose the per-listing file a standalone card would have shown.
    const html = ticketViewPage(
      [
        {
          attachmentUrl: "/attachment/9?a=3&exp=1&sig=y",
          entry: testTokenEntry({
            attendee: { package_group_id: 7 },
            listing: { attachment_name: "Handbook.pdf", name: "Handbook" },
          }),
          token,
        },
      ],
      false,
      false,
      new Map([[7, { hideListings: false, name: "Welcome Pack" }]]),
    );
    assertStringIncludes(html, "Welcome Pack");
    assertStringIncludes(html, "Handbook");
    assertStringIncludes(html, 'href="/attachment/9?a=3&amp;exp=1&amp;sig=y"');
    assertStringIncludes(html, "Download: Handbook.pdf");
  });

  test("renders multi-day booking range when daily listing has duration > 1", () => {
    const cards = [
      {
        entry: testTokenEntry({
          attendee: { date: "2026-06-12" },
          listing: {
            duration_days: 3,
            listing_type: "daily",
          },
        }),
        token,
      },
    ];
    const html = ticketViewPage(cards);
    // duration=3 starting 2026-06-12 → covers 12, 13, 14 inclusive.
    assertStringIncludes(html, "12–14 June 2026");
  });
});
