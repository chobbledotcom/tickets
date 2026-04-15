import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildRegistrationItems } from "#routes/public/ticket-payment.ts";
import type { TicketEvent } from "#templates/public.tsx";
import { testEventWithCount } from "#test-utils";

const buildInfo = (
  event: ReturnType<typeof testEventWithCount>,
): TicketEvent => ({
  event,
  isClosed: false,
  isSoldOut: false,
  maxPurchasable: 10,
});

describe("buildRegistrationItems — duration multiplier", () => {
  test("daily event with duration=1 uses per-day price as unitPrice", () => {
    const event = testEventWithCount({
      duration_days: 1,
      event_type: "daily",
      id: 1,
      name: "One day",
      slug: "one-day",
      unit_price: 1000,
    });
    const items = buildRegistrationItems(
      [buildInfo(event)],
      new Map([[1, 2]]),
      new Map(),
    );
    expect(items.length).toBe(1);
    expect(items[0]!.unitPrice).toBe(1000);
    expect(items[0]!.quantity).toBe(2);
  });

  test("daily event with duration=3 multiplies per-day price", () => {
    const event = testEventWithCount({
      duration_days: 3,
      event_type: "daily",
      id: 2,
      name: "Three day",
      slug: "three-day",
      unit_price: 1000,
    });
    const items = buildRegistrationItems(
      [buildInfo(event)],
      new Map([[2, 1]]),
      new Map(),
    );
    expect(items[0]!.unitPrice).toBe(3000);
  });

  test("custom pay-more price is treated per-day and multiplied by duration", () => {
    const event = testEventWithCount({
      can_pay_more: true,
      duration_days: 4,
      event_type: "daily",
      id: 3,
      max_price: 5000,
      name: "Pay more",
      slug: "pay-more",
      unit_price: 500,
    });
    const items = buildRegistrationItems(
      [buildInfo(event)],
      new Map([[3, 1]]),
      new Map([[3, 1500]]),
    );
    // 1500 per-day × 4 days = 6000 per ticket
    expect(items[0]!.unitPrice).toBe(6000);
  });

  test("standard event ignores duration_days", () => {
    const event = testEventWithCount({
      duration_days: 5,
      event_type: "standard",
      id: 4,
      name: "Standard",
      slug: "standard",
      unit_price: 800,
    });
    const items = buildRegistrationItems(
      [buildInfo(event)],
      new Map([[4, 1]]),
      new Map(),
    );
    expect(items[0]!.unitPrice).toBe(800);
  });
});
