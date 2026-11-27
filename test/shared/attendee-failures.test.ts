import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  AttendeeCreationFailureReasonSchema,
  AttendeeUpdateFailureReasonSchema,
  attendeeFailureFormatter,
  refusedOrderItem,
} from "#shared/attendee-failures.ts";

describe("attendee failure schemas", () => {
  const cases = [
    {
      accepted: true,
      name: "creation accepts a capacity failure",
      reason: "capacity_exceeded",
      schema: AttendeeCreationFailureReasonSchema,
    },
    {
      accepted: false,
      name: "creation rejects an empty-line failure",
      reason: "no_lines",
      schema: AttendeeCreationFailureReasonSchema,
    },
    {
      accepted: true,
      name: "updates accept a capacity failure",
      reason: "capacity_exceeded",
      schema: AttendeeUpdateFailureReasonSchema,
    },
    {
      accepted: true,
      name: "updates accept an empty-line failure",
      reason: "no_lines",
      schema: AttendeeUpdateFailureReasonSchema,
    },
  ] as const;

  for (const testCase of cases) {
    test(testCase.name, () => {
      expect(v.is(testCase.schema, testCase.reason)).toBe(testCase.accepted);
    });
  }
});

/* jscpd:ignore-start -- static data, not code */
/** Each failure reason, the listing name, and the message it reads. */
const FORMAT_CASES = [
  {
    expected: "My Listing is full",
    listingName: "My Listing",
    name: "names the listing for a capacity failure",
    reason: "capacity_exceeded",
  },
  {
    expected: "generic",
    listingName: undefined,
    name: "uses the generic message for an unnamed capacity failure",
    reason: "capacity_exceeded",
  },
  {
    expected: "fallback",
    listingName: "My Listing",
    name: "uses the fallback for an empty-line failure",
    reason: "no_lines",
  },
  {
    expected:
      "This booking has a subscription that still charges. Cancel the subscription first.",
    listingName: "My Listing",
    name: "asks to cancel a live subscription whatever the surface says",
    reason: "subscription_live",
  },
  {
    expected:
      "A listing that you removed has answers. Remove it on the attendee's Edit tab, where you can choose to delete its answers.",
    listingName: "My Listing",
    name: "sends a removed line that holds answers to the Edit tab, whatever the surface says",
    reason: "answers_held",
  },
] as const;
/* jscpd:ignore-end */

describe("attendeeFailureFormatter", () => {
  const format = attendeeFailureFormatter({
    fallback: "fallback",
    generic: "generic",
    withName: (name) => `${name} is full`,
  });

  for (const testCase of FORMAT_CASES) {
    test(testCase.name, () => {
      expect(format(testCase.reason, testCase.listingName)).toBe(
        testCase.expected,
      );
    });
  }
});

describe("refusedOrderItem", () => {
  const items = [
    { listingId: 10, name: "first" },
    { listingId: 20, name: "second" },
  ];
  const idOf = (item: { listingId: number }) => item.listingId;

  test("names the first item the failure says is out of room", () => {
    expect(refusedOrderItem(items, idOf, [20]).name).toBe("second");
  });

  test("falls back to the order's first item when none is named", () => {
    expect(refusedOrderItem(items, idOf, []).name).toBe("first");
  });

  test("throws for an order with no items", () => {
    expect(() => refusedOrderItem([], idOf, [])).toThrow(
      "A refused order carries no items to name",
    );
  });
});
