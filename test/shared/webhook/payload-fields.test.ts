/**
 * Every field the registration payload reports, from the buyer's details to the
 * price of each line.
 */

import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { resetEffectiveDomain } from "#shared/config.ts";
import type { RegistrationPackagePricing } from "#shared/registration-package-facts.ts";
import {
  buildWebhookPayload,
  type RegistrationEntry,
} from "#shared/webhook.ts";
import { defaultEntries } from "#test/shared/webhook/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  makeTestAttendee as makeAttendee,
  makeTestEntry as makeEntry,
  makeTestListing as makeListing,
} from "#test-utils/factories.ts";
import type { EmailEntry } from "#test-utils/internal.ts";

describeWithEnv("buildWebhookPayload", { db: true }, () => {
  const packagePricing = (
    prices: ReadonlyMap<number, number> = new Map(),
    dayPriceMap: ReadonlyMap<number, ReadonlyMap<number, number>> = new Map(),
  ): RegistrationPackagePricing => ({
    dayPriceMap,
    memberIds: new Set(),
    priceMap: prices,
    quantityMap: new Map(),
  });

  beforeEach(async () => {
    resetEffectiveDomain();
    const { settings: s } = await import("#shared/db/settings.ts");
    s.invalidateCache();
  });

  test("builds payload for a single free listing", async () => {
    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    expect(payload.notification_type).toBe("registration.completed");
    expect(payload.name).toBe("Jane Doe");
    expect(payload.email).toBe("jane@example.com");
    expect(payload.phone).toBe("555-1234");
    expect(payload.price_paid).toBeNull();
    expect(payload.currency).toBe("GBP");
    expect(payload.payment_id).toBeNull();
    expect(payload.ticket_url).toBe("https://localhost/t/AABB001122");
    expect(payload.tickets).toHaveLength(1);
    expect(payload.tickets[0]!.listing_name).toBe("Test Listing");
    expect(payload.tickets[0]!.listing_slug).toBe("test-listing");
    expect(payload.tickets[0]!.unit_price).toBe(0);
    expect(payload.tickets[0]!.quantity).toBe(1);
    expect(payload.tickets[0]!.date).toBeNull();
    expect(payload.tickets[0]!.ticket_token).toBe("AABB001122");
    expect(payload.timestamp).toBeDefined();
    expect(payload.business_email).toBe("");
  });

  test("builds payload for a single paid listing with price_paid on attendee", async () => {
    const entries = [
      makeEntry(
        { unit_price: 500 },
        { payment_id: "pi_abc123", price_paid: "1000", quantity: 2 },
      ),
    ];

    const payload = await buildWebhookPayload(entries, "USD");

    expect(payload.price_paid).toBe(1000);
    expect(payload.payment_id).toBe("pi_abc123");
    expect(payload.currency).toBe("USD");
    expect(payload.tickets[0]!.unit_price).toBe(500);
    expect(payload.tickets[0]!.quantity).toBe(2);
    // Fully paid, so nothing is owed.
    expect(payload.amount_owed).toBe(0);
  });

  test("reports the package override as unit_price, not the amount paid now", async () => {
    // A package member's base listing is free (unit_price 0); its real worth is
    // the package override. Even when the buyer paid less now (a deposit /
    // discount / provider-less order), the webhook reports the full override
    // per unit, not the paid-now amount divided by quantity.
    const entries = [
      makeEntry(
        { id: 42, unit_price: 0 },
        {
          package_group_id: 7,
          payment_id: "pi_pkg",
          price_paid: "3000",
          quantity: 6,
        },
      ),
    ];
    const overrides = new Map([[7, packagePricing(new Map([[42, 900]]))]]);

    const payload = buildWebhookPayload(entries, "GBP", overrides);

    // The order reports what was actually paid.
    expect(payload.price_paid).toBe(3000);
    // The per-unit price is the full override (900), not 3000 / 6 = 500.
    expect(payload.tickets[0]!.unit_price).toBe(900);
  });

  /** The payload for entries whose package group 7 carries NO overrides. */
  const payloadWithEmptyOverrides = (entries: EmailEntry[]) =>
    buildWebhookPayload(entries, "GBP", new Map([[7, packagePricing()]]));

  test("falls back to the base price for a package member with no override", async () => {
    const entries = [
      makeEntry(
        { id: 43, unit_price: 1200 },
        { package_group_id: 7, price_paid: "1200", quantity: 1 },
      ),
    ];
    // No override row for listing 43 → report the listing's base price.
    const payload = payloadWithEmptyOverrides(entries);
    expect(payload.tickets[0]!.unit_price).toBe(1200);
  });

  /** A 2-night (1–3 Aug) booking of one package-group-7 member, the span the
   * per-day pricing tests derive their day count from. */
  const twoNightPackageEntries = (
    listing: Parameters<typeof makeEntry>[0],
    pricePaid: string,
  ) => [
    makeEntry(listing, {
      date: "2026-08-01",
      end_date: "2026-08-03",
      package_group_id: 7,
      price_paid: pricePaid,
      quantity: 1,
    }),
  ];

  test("reports a customisable member's per-day package override for the booked span", async () => {
    // A 2-night booking of a customisable package member priced only by its
    // per-day override: the payload's unit_price is that override, derived
    // from the stored [start, end) range — never the base listing price.
    const entries = twoNightPackageEntries(
      { customisable_days: true, id: 44, unit_price: 0 },
      "1500",
    );
    const payload = buildWebhookPayload(
      entries,
      "GBP",
      new Map([
        [7, packagePricing(new Map(), new Map([[44, new Map([[2, 1500]])]]))],
      ]),
    );
    expect(payload.tickets[0]!.unit_price).toBe(1500);
  });

  test("reports a customisable member's OWN day price when the package has no override", async () => {
    // Regression: the member is priced by its own entered day prices (no flat
    // or per-day package override exists), so the payload must report the
    // 2-day price the checkout actually charged — never the base unit_price.
    const entries = twoNightPackageEntries(
      {
        customisable_days: true,
        day_prices: { 2: 3000 },
        duration_days: 2,
        id: 45,
        unit_price: 0,
      },
      "3000",
    );
    const payload = payloadWithEmptyOverrides(entries);
    expect(payload.tickets[0]!.unit_price).toBe(3000);
  });

  test("reports a standalone customisable booking's day price for the booked span", async () => {
    // A non-package customisable line is charged its entered day price, so the
    // payload reports that span price — the same evaluation checkout used —
    // rather than the flat unit_price.
    const entries = [
      makeEntry(
        {
          customisable_days: true,
          day_prices: { 1: 500, 2: 1500 },
          duration_days: 2,
          id: 46,
          unit_price: 500,
        },
        {
          date: "2026-08-01",
          end_date: "2026-08-03",
          price_paid: "1500",
          quantity: 1,
        },
      ),
    ];
    const payload = await buildWebhookPayload(entries, "GBP");
    expect(payload.tickets[0]!.unit_price).toBe(1500);
  });

  test("reports the order's outstanding balance as amount_owed", async () => {
    // A provider-less paid booking: nothing collected (price_paid 0), the full
    // value owed. remaining_balance is order-level, so a multi-listing order
    // reports it once — not summed across the booking lines.
    const entries = [
      makeEntry(
        { id: 1, name: "Listing A", slug: "listing-a", unit_price: 1000 },
        { price_paid: "0", remaining_balance: 3000, ticket_token: "AA00BB" },
      ),
      makeEntry(
        { id: 2, name: "Listing B", slug: "listing-b", unit_price: 2000 },
        { price_paid: "0", remaining_balance: 3000, ticket_token: "CC11DD" },
      ),
    ];

    const payload = await buildWebhookPayload(entries, "GBP");

    expect(payload.price_paid).toBe(0);
    expect(payload.amount_owed).toBe(3000);
  });

  test("builds payload for multi-listing entries", async () => {
    const entries = [
      makeEntry(
        { id: 1, name: "Listing A", slug: "listing-a", unit_price: 300 },
        {
          payment_id: "pi_multi",
          price_paid: "300",
          ticket_token: "AA00BB11CC",
        },
      ),
      makeEntry(
        { id: 2, name: "Listing B", slug: "listing-b", unit_price: 700 },
        {
          payment_id: "pi_multi",
          price_paid: "1400",
          quantity: 2,
          ticket_token: "DD22EE33FF",
        },
      ),
    ];

    const payload = await buildWebhookPayload(entries, "EUR");

    expect(payload.name).toBe("Jane Doe");
    expect(payload.price_paid).toBe(1700);
    expect(payload.payment_id).toBe("pi_multi");
    expect(payload.ticket_url).toBe(
      "https://localhost/t/AA00BB11CC+DD22EE33FF",
    );
    expect(payload.tickets).toHaveLength(2);
    expect(payload.tickets[0]!.listing_name).toBe("Listing A");
    expect(payload.tickets[0]!.unit_price).toBe(300);
    expect(payload.tickets[0]!.ticket_token).toBe("AA00BB11CC");
    expect(payload.tickets[1]!.listing_name).toBe("Listing B");
    expect(payload.tickets[1]!.unit_price).toBe(700);
    expect(payload.tickets[1]!.quantity).toBe(2);
    expect(payload.tickets[1]!.ticket_token).toBe("DD22EE33FF");
  });

  test("includes price_paid for free can_pay_more listing where attendee paid", async () => {
    const entries: RegistrationEntry[] = [
      {
        attendee: makeAttendee({
          payment_id: "pi_donate",
          price_paid: "500",
        }),
        listing: makeListing({ can_pay_more: true, unit_price: 0 }),
      },
    ];

    const payload = await buildWebhookPayload(entries, "GBP");

    expect(payload.price_paid).toBe(500);
    expect(payload.payment_id).toBe("pi_donate");
  });

  test("includes date in ticket when attendee has a date", async () => {
    const payload = await buildWebhookPayload(
      [makeEntry({}, { date: "2025-07-15" })],
      "GBP",
    );

    expect(payload.tickets[0]!.date).toBe("2025-07-15");
  });

  test("includes mixed dates for multi-listing with daily and standard listings", async () => {
    const entries = [
      makeEntry(
        { id: 1, name: "Daily Listing", slug: "daily-listing" },
        { date: "2025-07-15", ticket_token: "AA00BB11CC" },
      ),
      makeEntry(
        { id: 2, name: "Standard Listing", slug: "standard-listing" },
        { date: null, ticket_token: "DD22EE33FF" },
      ),
    ];

    const payload = await buildWebhookPayload(entries, "GBP");

    expect(payload.tickets[0]!.date).toBe("2025-07-15");
    expect(payload.tickets[1]!.date).toBeNull();
  });

  test("returns 0 price_paid when attendee has no price_paid on paid listing", async () => {
    const payload = await buildWebhookPayload(
      [makeEntry({ unit_price: 500 }, { quantity: 3 })],
      "GBP",
    );

    expect(payload.price_paid).toBe(0);
  });

  test("includes business_email when set", async () => {
    const { updateBusinessEmail } = await import("#shared/validation/email.ts");
    await updateBusinessEmail("contact@example.com");

    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    expect(payload.business_email).toBe("contact@example.com");
  });

  test("includes empty business_email when not set", async () => {
    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    expect(payload.business_email).toBe("");
  });
});
