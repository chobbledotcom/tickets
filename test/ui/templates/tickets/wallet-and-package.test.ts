import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { type TicketCard, ticketViewPage } from "#templates/tickets.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testTokenEntry } from "#test-utils/factories.ts";

describe("ticketViewPage wallet links and package cards", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  const token = "AABB0011CCDDEEFF";
  type EntryOverrides = NonNullable<Parameters<typeof testTokenEntry>[0]>;

  const cardFromEntry = (
    entry: EntryOverrides,
    cardToken: string,
  ): TicketCard => ({ entry: testTokenEntry(entry), token: cardToken });

  const packageMember = (
    attendee: EntryOverrides["attendee"],
    listing: EntryOverrides["listing"] = {},
  ): TicketCard =>
    cardFromEntry(
      { attendee: { ...attendee, package_group_id: 7 }, listing },
      token,
    );

  const packageDisplays = (hideListings: boolean) =>
    new Map([[7, { hideListings, name: "Welcome Pack" }]]);

  test("wraps the cards in the ticket slider", () => {
    const html = ticketViewPage([cardFromEntry({}, token)]);
    assertStringIncludes(html, 'class="ticket-slider"');
  });

  test("leaves no placeholder text on a plain card", () => {
    const html = ticketViewPage([cardFromEntry({}, token)]);
    assert(
      !html.includes("mutated"),
      "the value should not contain the searched item",
    );
  });

  test("joins consecutive cards with no placeholder text between them", () => {
    const html = ticketViewPage([
      cardFromEntry({ listing: { id: 1, name: "First" } }, "AABB0011CCDDEEF1"),
      cardFromEntry({ listing: { id: 2, name: "Second" } }, "AABB0011CCDDEEF2"),
    ]);
    assertStringIncludes(html, "First");
    assertStringIncludes(html, "Second");
    assert(
      !html.includes("mutated"),
      "the value should not contain the searched item",
    );
  });

  test("shows the QR code and the token on a check-in card", () => {
    const html = ticketViewPage([cardFromEntry({}, token)]);
    assertStringIncludes(html, 'class="ticket-card-qr"');
    assertStringIncludes(html, `<div class="ticket-card-token">${token}</div>`);
  });

  test("shows the listing image with its card class", () => {
    const html = ticketViewPage([
      cardFromEntry({ listing: { image_url: "photo.jpg" } }, token),
    ]);
    assertStringIncludes(html, 'class="ticket-card-image"');
    assertStringIncludes(html, 'src="/image/photo.jpg"');
  });

  test("offers Add to: Apple Wallet and Google Wallet links", () => {
    const html = ticketViewPage([cardFromEntry({}, token)], true, true);
    assertStringIncludes(
      html,
      `<div class="ticket-card-wallet">Add to: ` +
        `<a href="/wallet/${token}.pkpass" class="wallet-link">` +
        "Apple Wallet</a> / " +
        `<a href="/gwallet/${token}" class="wallet-link">` +
        "Google Wallet</a></div>",
    );
  });

  test("offers only the Apple Wallet link when Google Wallet is off", () => {
    const html = ticketViewPage([cardFromEntry({}, token)], true, false);
    assertStringIncludes(html, `href="/wallet/${token}.pkpass"`);
    assertStringIncludes(html, ">Apple Wallet</a>");
    assert(
      !html.includes("Google Wallet"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("gwallet"),
      "the value should not contain the searched item",
    );
  });

  test("offers only the Google Wallet link when Apple Wallet is off", () => {
    const html = ticketViewPage([cardFromEntry({}, token)], false, true);
    assertStringIncludes(html, `href="/gwallet/${token}"`);
    assertStringIncludes(html, ">Google Wallet</a>");
    assert(
      !html.includes("Apple Wallet"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes(".pkpass"),
      "the value should not contain the searched item",
    );
  });

  test("offers no wallet links when no wallet provider is enabled", () => {
    const html = ticketViewPage([cardFromEntry({}, token)]);
    assert(
      !html.includes("ticket-card-wallet"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("wallet-link"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("Add to:"),
      "the value should not contain the searched item",
    );
  });

  test("leaves no placeholder text on a purchase-only card", () => {
    const html = ticketViewPage(
      [cardFromEntry({ listing: { purchase_only: true } }, token)],
      true,
      true,
    );
    assert(
      !html.includes("mutated"),
      "the value should not contain the searched item",
    );
  });

  test("heads and titles a purchase-only page Your Purchase", () => {
    const html = ticketViewPage([
      cardFromEntry({ listing: { purchase_only: true } }, token),
    ]);
    assertStringIncludes(html, "<h1>Your Purchase</h1>");
    assertStringIncludes(html, "<title>Your Purchase</title>");
  });

  test("names every member of a package on one card", () => {
    const html = ticketViewPage(
      [
        packageMember(undefined, { id: 1, name: "Spa Day" }),
        packageMember(undefined, { id: 2, name: "Meal For Two" }),
      ],
      false,
      false,
      packageDisplays(false),
    );
    assertStringIncludes(html, "Welcome Pack");
    assertStringIncludes(html, "Spa Day");
    assertStringIncludes(html, "Meal For Two");
    assertStringIncludes(html, "</li><li>");
    assertStringIncludes(html, "1 Ticket");
    expect(html.split("Welcome Pack").length - 1).toBe(1);
    assert(
      !html.includes("mutated"),
      "the value should not contain the searched item",
    );
  });

  test("totals the booked quantity on a hidden-listings package card", () => {
    const html = ticketViewPage(
      [
        packageMember({ quantity: 2 }, { id: 1, name: "Spa Day" }),
        packageMember({ quantity: 3 }, { id: 2, name: "Meal For Two" }),
      ],
      false,
      false,
      packageDisplays(true),
    );
    assertStringIncludes(
      html,
      '<div class="ticket-card-package-qty"><span class="package-member-qty">&times;5</span></div>',
    );
    assert(
      !html.includes("Spa Day"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("Meal For Two"),
      "the value should not contain the searched item",
    );
  });

  test("shows no ID-required notice when every package member is transferable", () => {
    const html = ticketViewPage(
      [packageMember(undefined, { id: 1, name: "Spa Day" })],
      false,
      false,
      packageDisplays(false),
    );
    assert(
      !html.includes("ticket-card-notice"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("Non-transferable"),
      "the value should not contain the searched item",
    );
  });

  test("warns that a package needs ID when a member is non-transferable", () => {
    const html = ticketViewPage(
      [packageMember(undefined, { id: 1, non_transferable: true })],
      false,
      false,
      packageDisplays(false),
    );
    assertStringIncludes(html, "ticket-card-notice");
    assertStringIncludes(html, "Non-transferable — ID required at entry");
  });

  test("shows the Booking Date: on a dated package", () => {
    const html = ticketViewPage(
      [
        packageMember(
          { date: "2026-06-15" },
          { duration_days: 1, id: 1, listing_type: "daily" },
        ),
      ],
      false,
      false,
      packageDisplays(false),
    );
    assertStringIncludes(html, "Booking Date: Monday 15 June 2026");
  });

  test("keeps wallet links off a card whose token also carries a package", () => {
    const html = ticketViewPage(
      [
        packageMember(undefined, { id: 1, name: "Spa Day" }),
        cardFromEntry(
          {
            attendee: { package_group_id: 0 },
            listing: { id: 3, name: "Solo Show" },
          },
          token,
        ),
      ],
      true,
      true,
      packageDisplays(false),
    );
    assertStringIncludes(html, "Welcome Pack");
    assertStringIncludes(html, "Solo Show");
    assert(
      !html.includes("wallet-link"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("Apple Wallet"),
      "the value should not contain the searched item",
    );
  });
});
