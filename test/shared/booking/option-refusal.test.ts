/**
 * The refusal vocabulary's own unit suite: a pure, single-isolate direct
 * test of every declared failure path, so the coverage merge attributes the
 * module's lines from one report.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  noSpanReason,
  reasonOfFailures,
  whyChildFails,
  whyNoChildServes,
} from "#booking/option-refusal.ts";
import { nextWeekday, orderDate } from "#test/features/public/order/helpers.ts";
import { resolved } from "#test-utils/booking-model-fixtures.ts";

/** A daily-fixed listing whose calendar serves Tuesdays only. */
const tuesdayKit = () =>
  resolved({
    bookable_days: ["Tuesday"],
    duration_days: 1,
    listing_type: "daily",
    maximum_days_after: 10,
    minimum_days_before: 0,
    name: "Tuesday Kit",
  });

/** A customisable daily listing that prices the second day only. */
const twoDayKit = () =>
  resolved({
    customisable_days: true,
    day_prices: { 2: 900 },
    duration_days: 2,
    listing_type: "daily",
    maximum_days_after: 10,
    minimum_days_before: 0,
    name: "Two Day Kit",
  });

describe("whyChildFails", () => {
  test("a dead child refuses structurally", () => {
    const child = resolved({ active: false, name: "Inactive Kit" });
    expect(
      whyChildFails({ child, date: null, durationDays: 1, holidays: [] }),
    ).toBe("structural");
  });

  test("a live child that cannot serve the span refuses on span", () => {
    expect(
      whyChildFails({
        child: twoDayKit(),
        date: null,
        durationDays: 1,
        holidays: [],
      }),
    ).toBe("span");
  });

  test("a date-less child with no calendar serves", () => {
    const child = resolved({ name: "Plain Kit" });
    expect(
      whyChildFails({ child, date: null, durationDays: 1, holidays: [] }),
    ).toBe(null);
  });

  test("a daily child whose calendar refuses the date refuses on date", () => {
    expect(
      whyChildFails({
        child: tuesdayKit(),
        date: nextWeekday(orderDate(), "Monday"),
        durationDays: 1,
        holidays: [],
      }),
    ).toBe("date");
  });

  test("a daily child whose calendar holds the date serves", () => {
    expect(
      whyChildFails({
        child: tuesdayKit(),
        date: nextWeekday(orderDate(), "Tuesday"),
        durationDays: 1,
        holidays: [],
      }),
    ).toBe(null);
  });
});

describe("whyNoChildServes", () => {
  test("every child dead rolls up to structural", () => {
    const children = [
      resolved({ active: false, name: "Inactive Kit" }),
      resolved({ active: false, name: "Inactive Spare" }),
    ];
    expect(whyNoChildServes(children, null, 1, [])).toBe("structural");
  });

  test("a date refusal rolls up over a span refusal", () => {
    const children = [tuesdayKit(), twoDayKit()];
    expect(
      whyNoChildServes(children, nextWeekday(orderDate(), "Monday"), 1, []),
    ).toBe("date");
  });

  test("no child serving the span rolls up to span", () => {
    expect(whyNoChildServes([twoDayKit()], null, 1, [])).toBe("span");
  });
});

describe("reasonOfFailures", () => {
  test("structural outranks span and date", () => {
    expect(reasonOfFailures(["structural", "span", "date"])).toBe(
      "no_bookable_child",
    );
  });

  test("span outranks date", () => {
    expect(reasonOfFailures(["span", "date"])).toBe("span_unsupported");
  });

  test("date and parent_date map to the same refusal", () => {
    expect(reasonOfFailures(["date"])).toBe("date_unsupported");
    expect(reasonOfFailures(["parent_date"])).toBe("date_unsupported");
  });

  test("a capacity failure maps to capacity", () => {
    expect(reasonOfFailures(["capacity"])).toBe("capacity");
  });
});

describe("noSpanReason", () => {
  test("a live required child means the span was pruned", () => {
    expect(noSpanReason([resolved({ name: "Live Kit" })])).toBe(
      "span_unsupported",
    );
  });

  test("every required child dead means no bookable child", () => {
    expect(noSpanReason([resolved({ active: false, name: "Dead Kit" })])).toBe(
      "no_bookable_child",
    );
  });

  test("no required children at all reads as a pruned span", () => {
    expect(noSpanReason([])).toBe("span_unsupported");
  });
});
