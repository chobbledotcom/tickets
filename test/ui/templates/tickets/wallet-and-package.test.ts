import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { type TicketCard, ticketViewPage } from "#templates/tickets.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectExcludesAll } from "#test-utils/assertions/absent.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
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
    expectExcludesAll(html, ["mutated"]);
  });

  test("joins consecutive cards with no placeholder text between them", () => {
    const html = ticketViewPage([
      cardFromEntry({ listing: { id: 1, name: "First" } }, "AABB0011CCDDEEF1"),
      cardFromEntry({ listing: { id: 2, name: "Second" } }, "AABB0011CCDDEEF2"),
    ]);
    expectIncludesAll(html, ["First", "Second"]);
    expectExcludesAll(html, ["mutated"]);
  });

  test("shows the QR code and the token on a check-in card", () => {
    const html = ticketViewPage([cardFromEntry({}, token)]);
    expectIncludesAll(html, [
      'class="ticket-card-qr"',
      `<div class="ticket-card-token">${token}</div>`,
    ]);
  });

  test("shows the listing image with its card class", () => {
    const html = ticketViewPage([
      cardFromEntry({ listing: { imageUrl: "photo.jpg" } }, token),
    ]);
    expectIncludesAll(html, [
      'class="ticket-card-image"',
      'src="/image/photo.jpg"',
    ]);
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
    expectIncludesAll(html, [
      `href="/wallet/${token}.pkpass"`,
      ">Apple Wallet</a>",
    ]);
    expectExcludesAll(html, ["Google Wallet", "gwallet"]);
  });

  test("offers only the Google Wallet link when Apple Wallet is off", () => {
    const html = ticketViewPage([cardFromEntry({}, token)], false, true);
    expectIncludesAll(html, [`href="/gwallet/${token}"`, ">Google Wallet</a>"]);
    expectExcludesAll(html, ["Apple Wallet", ".pkpass"]);
  });

  test("offers no wallet links when no wallet provider is enabled", () => {
    const html = ticketViewPage([cardFromEntry({}, token)]);
    expectExcludesAll(html, ["ticket-card-wallet", "wallet-link", "Add to:"]);
  });

  test("leaves no placeholder text on a purchase-only card", () => {
    const html = ticketViewPage(
      [cardFromEntry({ listing: { purchaseOnly: true } }, token)],
      true,
      true,
    );
    expectExcludesAll(html, ["mutated"]);
  });

  test("heads and titles a purchase-only page Your Purchase", () => {
    const html = ticketViewPage([
      cardFromEntry({ listing: { purchaseOnly: true } }, token),
    ]);
    expectIncludesAll(html, [
      "<h1>Your Purchase</h1>",
      "<title>Your Purchase</title>",
    ]);
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
    expectIncludesAll(html, [
      "Welcome Pack",
      "Spa Day",
      "Meal For Two",
      "</li><li>",
      "1 Ticket",
    ]);
    expect(html.split("Welcome Pack").length - 1).toBe(1);
    expectExcludesAll(html, ["mutated"]);
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
    expectExcludesAll(html, ["Spa Day", "Meal For Two"]);
  });

  test("shows no ID-required notice when every package member is transferable", () => {
    const html = ticketViewPage(
      [packageMember(undefined, { id: 1, name: "Spa Day" })],
      false,
      false,
      packageDisplays(false),
    );
    expectExcludesAll(html, ["ticket-card-notice", "Non-transferable"]);
  });

  test("warns that a package needs ID when a member is non-transferable", () => {
    const html = ticketViewPage(
      [packageMember(undefined, { id: 1, nonTransferable: true })],
      false,
      false,
      packageDisplays(false),
    );
    expectIncludesAll(html, [
      "ticket-card-notice",
      "Non-transferable — ID required at entry",
    ]);
  });

  test("shows the Booking Date: on a dated package", () => {
    const html = ticketViewPage(
      [
        packageMember(
          { date: "2026-06-15" },
          { durationDays: 1, id: 1, listingType: "daily" },
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
    expectIncludesAll(html, ["Welcome Pack", "Solo Show"]);
    expectExcludesAll(html, ["wallet-link", "Apple Wallet"]);
  });
});
