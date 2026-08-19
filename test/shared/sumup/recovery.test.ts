/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { CallbackOutcome } from "#routes/api/payment-callback.ts";
import {
  RECOVERY_EVENTS,
  recoveryMoveTo,
} from "#shared/payment/sumup-recovery-machine-spec.ts";
import {
  type SumupCheckoutReading,
  sumupRecoveryOutcome,
} from "#shared/sumup/recovery.ts";

/* jscpd:ignore-end */

/** A settled outcome of each kind, with the fields its arm carries. */
const outcomeOf = (kind: CallbackOutcome["kind"]): CallbackOutcome => {
  const failure = { detail: "why", error: "sorry", listingId: 7 };
  switch (kind) {
    case "booked":
      return { kind, listingId: 7, result: { error: "x", success: false } };
    case "held":
    case "settled":
    case "unsettled":
      return { ...failure, kind };
    case "unpaid":
      return { detail: "why", kind };
    default:
      return { kind };
  }
};

/** SumUp's own word decides everything but a paid checkout, so these carry
 * an outcome that would say something different if it were consulted. */
const SUMUP_DECIDES: readonly [SumupCheckoutReading, string][] = [
  ["unusable", "read_unavailable"],
  ["PENDING", "read_pending"],
  ["EXPIRED", "read_expired_or_failed"],
  ["FAILED", "read_expired_or_failed"],
];

describe("sumupRecoveryOutcome", () => {
  for (const [reading, event] of SUMUP_DECIDES) {
    test(`a ${reading} read is ${event} whatever settling said`, () => {
      expect(sumupRecoveryOutcome(reading, outcomeOf("booked"))).toBe(event);
    });
  }

  const PAID: readonly [CallbackOutcome["kind"], string][] = [
    ["booked", "read_paid_booked"],
    ["held", "read_paid_unreadable"],
    ["not_yet", "read_paid_contradiction"],
    ["refused", "read_paid_contradiction"],
    ["settled", "read_paid_settled"],
    ["unpaid", "read_paid_contradiction"],
    ["unreadable", "read_paid_unreadable"],
    ["unrecognised", "read_paid_contradiction"],
    ["unsettled", "read_paid_unsettled"],
    ["unverifiable", "read_paid_contradiction"],
  ];

  for (const [kind, event] of PAID) {
    test(`a paid read settled as ${kind} is ${event}`, () => {
      expect(sumupRecoveryOutcome("PAID", outcomeOf(kind))).toBe(event);
    });
  }

  test("names an event for every outcome a callback can produce", () => {
    // The table above must stay exhaustive: a new outcome with no row here
    // would otherwise be silently read as one of the existing ones.
    expect(PAID.length).toBe(10);
    expect([...new Set(PAID.map(([kind]) => kind))].length).toBe(PAID.length);
  });

  test("only ever names events the machine actually declares", () => {
    const declared = new Set(RECOVERY_EVENTS.map(({ id }) => id));
    const named = [
      ...SUMUP_DECIDES.map(([, event]) => event),
      ...PAID.map(([, event]) => event),
    ];
    for (const event of named) {
      expect(declared.has(event as never), event).toBe(true);
    }
  });

  test("never names an event a waiting row would refuse", () => {
    // The classifier reads evidence; the table decides where it lands. A name
    // no open row accepts would crash the task rather than move the row.
    for (const [, event] of [...SUMUP_DECIDES, ...PAID]) {
      expect(
        () => recoveryMoveTo("waiting", event as never),
        event,
      ).not.toThrow();
    }
  });

  test("never names an event an owed row would refuse", () => {
    for (const [, event] of PAID) {
      expect(() => recoveryMoveTo("owed", event as never), event).not.toThrow();
    }
  });
});
