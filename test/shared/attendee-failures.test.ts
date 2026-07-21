import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  AttendeeCreationFailureReasonSchema,
  AttendeeUpdateFailureReasonSchema,
  attendeeFailureFormatter,
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

describe("attendeeFailureFormatter", () => {
  const format = attendeeFailureFormatter({
    fallback: "fallback",
    generic: "generic",
    withName: (name) => `${name} is full`,
  });
  const cases = [
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
  ] as const;

  for (const testCase of cases) {
    test(testCase.name, () => {
      expect(format(testCase.reason, testCase.listingName)).toBe(
        testCase.expected,
      );
    });
  }
});
