/**
 * What the registration webhook reports: which packages an order books through,
 * the full price of each line, and the refusal to post anywhere unsafe.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RegistrationPackagePricing } from "#shared/registration-package-facts.ts";
import { sendWebhook } from "#shared/webhook/delivery.ts";
import {
  buildWebhookPayload,
  type RegistrationEntry,
} from "#shared/webhook.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  type makeTestAttendee as makeAttendee,
  makeTestEntry as makeEntry,
} from "#test-utils/factories.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";

/** A line booked through `packageGroupId` (0 for a plain line). */
const packagedEntry = (
  packageGroupId: number,
  overrides: Parameters<typeof makeAttendee>[0] = {},
): RegistrationEntry =>
  makeEntry({}, { package_group_id: packageGroupId, ...overrides });

/** The price the payload reports for one line, given a package override that
 * puts this listing at 750 under `overriddenGroupId`. */
const reportedPrice = (
  entry: RegistrationEntry,
  overriddenGroupId: number,
): number | undefined => {
  const overrides = new Map([
    [
      overriddenGroupId,
      {
        dayPriceMap: new Map(),
        memberIds: new Set(),
        priceMap: new Map([[entry.listing.id, 750]]),
        quantityMap: new Map(),
      } satisfies RegistrationPackagePricing,
    ],
  ]);
  return buildWebhookPayload([entry], "GBP", overrides).tickets[0]?.unit_price;
};

describeWithEnv("webhook payload", { db: true }, () => {
  test("prices a package member from its package's override", () => {
    expect(reportedPrice(packagedEntry(1), 1)).toBe(750);
  });

  test("prices a plain line from its own listing, ignoring any override", () => {
    expect(reportedPrice(makeEntry({ unit_price: 400 }), 0)).toBe(400);
  });

  test("reads the paid amount as a plain decimal figure", () => {
    // Minor units are stored as digits. Reading them any other way — as hex,
    // say — would silently multiply what integrations are told was paid.
    const entry = makeEntry({ unit_price: 0 }, { price_paid: "0x10" });

    expect(buildWebhookPayload([entry], "GBP").price_paid).toBeNull();
  });

  test("reports a free listing that took a payment as paid", () => {
    const entry = makeEntry({ unit_price: 0 }, { price_paid: "1" });

    expect(buildWebhookPayload([entry], "GBP").price_paid).toBe(1);
  });

  test("reports a free order that took nothing as unpaid", () => {
    const entry = makeEntry({ unit_price: 0 }, { price_paid: "0" });

    expect(buildWebhookPayload([entry], "GBP").price_paid).toBeNull();
  });
});

describeWithEnv("webhook sending safety", { db: true }, () => {
  const testFetch = stubFetchEachTest(() => new Response());

  test("refuses to post to an unsafe address", async () => {
    const result = await sendWebhook(
      "http://127.0.0.1/hook",
      buildWebhookPayload([makeEntry()], "GBP"),
    );

    expect(testFetch.calls.length).toBe(0);
    expect(result).toEqual({ delivered: false, reason: "unsafe_url" });
  });
});
