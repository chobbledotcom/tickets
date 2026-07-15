import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  decideUnexpectedCreate,
  type RecoveryFacts,
} from "#routes/api/payment-processing/recovery-decision.ts";

describe("paid booking recovery decision", () => {
  const cases: {
    expected: ReturnType<typeof decideUnexpectedCreate>;
    facts: RecoveryFacts;
    name: string;
  }[] = [
    {
      expected: { attendeeId: 12, kind: "recover" },
      facts: {
        finalizedAttendeeId: 12,
        tokenAttendeeId: 12,
        unresolved: false,
      },
      name: "recovers when the finalized payment and token match",
    },
    {
      expected: { kind: "refund" },
      facts: {
        finalizedAttendeeId: null,
        tokenAttendeeId: null,
        unresolved: true,
      },
      name: "refunds when rollback is proven",
    },
    {
      expected: { kind: "rethrow" },
      facts: {
        finalizedAttendeeId: null,
        tokenAttendeeId: null,
        unresolved: false,
      },
      name: "rethrows when the payment row is missing",
    },
    {
      expected: { kind: "rethrow" },
      facts: {
        finalizedAttendeeId: 12,
        tokenAttendeeId: 13,
        unresolved: false,
      },
      name: "rethrows when the payment resolved to a different attendee",
    },
    {
      expected: { kind: "rethrow" },
      facts: {
        finalizedAttendeeId: 12,
        tokenAttendeeId: null,
        unresolved: false,
      },
      name: "rethrows when a finalized payment has no matching token",
    },
    {
      expected: { kind: "rethrow" },
      facts: {
        finalizedAttendeeId: null,
        tokenAttendeeId: 12,
        unresolved: true,
      },
      name: "rethrows when an unresolved payment has a committed token",
    },
    {
      expected: { kind: "rethrow" },
      facts: {
        finalizedAttendeeId: 12,
        tokenAttendeeId: 12,
        unresolved: true,
      },
      name: "rethrows contradictory finalized and unresolved state",
    },
  ];

  for (const example of cases) {
    test(example.name, () => {
      expect(decideUnexpectedCreate(example.facts)).toEqual(example.expected);
    });
  }
});
