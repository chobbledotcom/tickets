/**
 * What the registration webhook reports: which packages an order books through,
 * the full price of each line, and the refusal to post anywhere unsafe.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { type Stub, spy } from "@std/testing/mock";
import {
  bookedPackageGroupIds,
  buildWebhookPayload,
  type RegistrationEntry,
  sendWebhook,
} from "#shared/webhook.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  type makeTestAttendee as makeAttendee,
  makeTestEntry as makeEntry,
} from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

/** A line booked through `packageGroupId` (0 for a plain line). */
const packagedEntry = (
  packageGroupId: number,
  overrides: Parameters<typeof makeAttendee>[0] = {},
): RegistrationEntry =>
  makeEntry({}, { package_group_id: packageGroupId, ...overrides });

describeWithEnv("webhook payload", { db: true }, () => {
  test("lists each booked package once and skips plain lines", () => {
    expect(
      bookedPackageGroupIds([
        packagedEntry(0),
        packagedEntry(1),
        packagedEntry(7),
        packagedEntry(1),
      ]),
    ).toEqual([1, 7]);
  });

  test("prices a package member from its package's override", () => {
    const entry = packagedEntry(1);
    const overrides = new Map([
      [1, { dayPrices: new Map(), prices: new Map([[entry.listing.id, 750]]) }],
    ]);

    const payload = buildWebhookPayload([entry], "GBP", overrides);
    expect(payload.tickets[0]?.unit_price).toBe(750);
  });

  test("prices a plain line from its own listing, ignoring any override", () => {
    const entry = makeEntry({ unit_price: 400 });
    const overrides = new Map([
      [0, { dayPrices: new Map(), prices: new Map([[entry.listing.id, 750]]) }],
    ]);

    const payload = buildWebhookPayload([entry], "GBP", overrides);
    expect(payload.tickets[0]?.unit_price).toBe(400);
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
  let fetchSpy: Stub;

  beforeEach(() => {
    fetchSpy = stubFetch(() => new Response());
  });

  afterEach(() => {
    fetchSpy.restore();
  });

  test("refuses to post to an unsafe address, and says so", async () => {
    const errorSpy = spy(console, "error");
    try {
      await sendWebhook(
        "http://127.0.0.1/hook",
        buildWebhookPayload([makeEntry()], "GBP"),
        42,
      );
    } finally {
      errorSpy.restore();
    }

    expect(fetchSpy.calls.length).toBe(0);
    const logged = errorSpy.calls
      .map((call) => String(call.args[0]))
      .join("\n");
    expect(logged).toContain("Refused to send webhook to an unsafe URL");
    expect(logged).toContain("listing=42");
  });

  test("blames the order's first listing when a send fails", async () => {
    fetchSpy.restore();
    fetchSpy = stubFetch(() => new Response("no", { status: 500 }));
    const first = makeEntry({
      id: 11,
      webhook_url: "https://example.com/hook",
    });
    const second = makeEntry({
      id: 22,
      webhook_url: "https://example.com/hook",
    });
    const { sendRegistrationWebhooks } = await import("#shared/webhook.ts");

    const errorSpy = spy(console, "error");
    try {
      await sendRegistrationWebhooks([first, second], "GBP");
    } finally {
      errorSpy.restore();
    }

    const logged = errorSpy.calls
      .map((call) => String(call.args[0]))
      .join("\n");
    expect(logged).toContain("listing=11");
    expect(logged).not.toContain("listing=22");
  });
});
