import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { buildTicketListing } from "#shared/booking/model.ts";
import { addDays } from "#shared/dates.ts";
import { settings } from "#shared/db/settings.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import { ticketViewPage } from "#templates/tickets.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

describe("ticketPage listing date and location", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  const renderTicket = (ev: ListingWithCount, opts?: { iframe?: boolean }) => {
    if (opts?.iframe) {
      detectIframeMode(new URL("https://example.com/?iframe=true"));
    } else detectIframeMode(new URL("https://example.com/"));
    return ticketPage({
      dates: [],
      listings: [buildTicketListing(ev, false, undefined)],
      slugs: [ev.slug],
    });
  };

  test("shows date on public ticket page when listing has date", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
    });
    const html = renderTicket(listing);
    expect(html).toContain("<strong>Date:</strong>");
    expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
  });

  test("does not show date on public ticket page when date is empty", () => {
    const listing = testListingWithCount({ attendee_count: 0, date: "" });
    const html = renderTicket(listing);
    expect(html).not.toContain("<strong>Date:</strong>");
  });

  test("shows location on public ticket page when listing has location", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      location: "Village Hall",
    });
    const html = renderTicket(listing);
    expect(html).toContain("<strong>Location:</strong>");
    expect(html).toContain("Village Hall");
  });

  test("does not show location on public ticket page when location is empty", () => {
    const listing = testListingWithCount({ attendee_count: 0, location: "" });
    const html = renderTicket(listing);
    expect(html).not.toContain("<strong>Location:</strong>");
  });

  test("hides date and location in iframe mode", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
      location: "Village Hall",
    });
    const html = renderTicket(listing, { iframe: true });
    expect(html).not.toContain("<strong>Date:</strong>");
    expect(html).not.toContain("<strong>Location:</strong>");
  });

  test("shows past listing badge for listing with date in the past", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2020-01-15T14:00:00.000Z",
    });
    const html = renderTicket(listing);
    expect(html).toContain("badge-alert");
    expect(html).toContain("ago");
  });

  test("does not show past listing badge for future listing", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2099-06-15T14:00:00.000Z",
    });
    const html = renderTicket(listing);
    expect(html).not.toContain("badge-alert");
  });

  test("does not show past listing badge when date is empty", () => {
    const listing = testListingWithCount({ attendee_count: 0, date: "" });
    const html = renderTicket(listing);
    expect(html).not.toContain("badge-alert");
  });

  test("past listing badge shows singular day for 1 day ago", () => {
    const yesterday = addDays(todayInTz(settings.timezone), -1);
    const listing = testListingWithCount({
      attendee_count: 0,
      date: `${yesterday}T12:00:00.000Z`,
    });
    const html = renderTicket(listing);
    expect(html).toContain("1 day ago");
    expect(html).not.toContain("(1 day ago)");
  });

  test("past listing badge shows plural days for multiple days ago", () => {
    const threeDaysAgo = addDays(todayInTz(settings.timezone), -3);
    const listing = testListingWithCount({
      attendee_count: 0,
      date: `${threeDaysAgo}T12:00:00.000Z`,
    });
    const html = renderTicket(listing);
    expect(html).toContain("3 days ago");
    expect(html).not.toContain("(3 days ago)");
  });
});

describe("ticketViewPage package grouping", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  const token = "PKG00011AABBCCDD";
  const purchaseBundleGroups = new Map([
    [1, { hideListings: false, name: "Purchase Bundle" }],
  ]);
  const pkgCards = [
    {
      entry: {
        attendee: testAttendee({ package_group_id: 1, quantity: 2 }),
        listing: testListingWithCount({ name: "Tent" }),
      },
      token,
    },
    {
      entry: {
        attendee: testAttendee({ package_group_id: 1, quantity: 6 }),
        listing: testListingWithCount({ name: "Chair" }),
      },
      token,
    },
  ];

  test("renders a non-hidden package as one card with members and booked quantities", () => {
    const html = ticketViewPage(
      pkgCards,
      false,
      false,
      new Map([[1, { hideListings: false, name: "Camp Kit" }]]),
    );
    expect(html).toContain("Camp Kit");
    expect(html).toContain("Tent");
    expect(html).toContain("&times;2");
    expect(html).toContain("Chair");
    expect(html).toContain("&times;6");
    // One shared QR for the whole bundle.
    expect(html).toContain(`/t/${token}/svg`);
    // No member is non-transferable, so no "ID required" notice.
    expect(html).not.toContain("ID required at entry");
  });

  test("hides member listings for a hidden package, showing only the name", () => {
    const html = ticketViewPage(
      pkgCards,
      false,
      false,
      new Map([[1, { hideListings: true, name: "Secret Bundle" }]]),
    );
    expect(html).toContain("Secret Bundle");
    expect(html).not.toContain("Tent");
    expect(html).not.toContain("Chair");
    expect(html).toContain(`/t/${token}/svg`);
  });

  test("omits wallet links on a package card even when wallets are enabled", () => {
    // Wallet routes resolve a token to a single member listing, so a saved pass
    // would show only the first member (leaking a hidden member); package cards
    // therefore never render wallet links.
    const html = ticketViewPage(
      pkgCards,
      true,
      true,
      new Map([[1, { hideListings: false, name: "Camp Kit" }]]),
    );
    expect(html).not.toContain("wallet-link");
  });

  test("omits wallet links on a standalone card sharing a token with a package", () => {
    // After a merge, a standalone booking can share a token with a package. The
    // wallet endpoints 404 any token containing a package row, so the standalone
    // card must not advertise wallet links it can't honour.
    const mixed = [
      pkgCards[0]!,
      {
        entry: {
          attendee: testAttendee({ package_group_id: 0, quantity: 1 }),
          listing: testListingWithCount({ name: "Standalone Add-On" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(
      mixed,
      true,
      true,
      new Map([[1, { hideListings: false, name: "Camp Kit" }]]),
    );
    // The standalone card renders (it's not part of the package)…
    expect(html).toContain("Standalone Add-On");
    // …but no wallet links anywhere, because the shared token's pass 404s.
    expect(html).not.toContain("wallet-link");
  });

  test("a purchase-only package omits the QR", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee({ package_group_id: 1, quantity: 1 }),
          listing: testListingWithCount({ name: "Pass", purchase_only: true }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards, false, false, purchaseBundleGroups);
    expect(html).toContain("Purchase Bundle");
    expect(html).not.toContain(`/t/${token}/svg`);
  });

  test("shows a non-transferable notice on a package card without naming the member", () => {
    // A hidden package conceals its members but must still warn the buyer that
    // ID is required — the scanner enforces it regardless of the card display.
    const cards = [
      {
        entry: {
          attendee: testAttendee({ package_group_id: 1, quantity: 1 }),
          listing: testListingWithCount({
            name: "Secret Pass",
            non_transferable: true,
          }),
        },
        token,
      },
    ];
    const html = ticketViewPage(
      cards,
      false,
      false,
      new Map([[1, { hideListings: true, name: "Secret Bundle" }]]),
    );
    expect(html).toContain("ID required at entry");
    // The warning is package-level: the concealed member is never named.
    expect(html).not.toContain("Secret Pass");
  });

  test("omits the non-transferable notice when the non-transferable member is purchase-only", () => {
    // A purchase-only member is never checked in, so its non-transferable flag
    // raises no "ID required" warning.
    const cards = [
      {
        entry: {
          attendee: testAttendee({ package_group_id: 1, quantity: 1 }),
          listing: testListingWithCount({
            name: "Pass",
            non_transferable: true,
            purchase_only: true,
          }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards, false, false, purchaseBundleGroups);
    expect(html).not.toContain("ID required at entry");
  });
});
