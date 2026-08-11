import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import {
  type ClaimDecision,
  type ClaimRequest,
  claimLeaseMs,
  claimRefusal,
  decideClaim,
  holdsTheRow,
  isClaimStale,
  mayReleaseClaim,
} from "#shared/payment/claim.ts";
import type {
  RefundCapability,
  RefundClaim,
} from "#shared/payment/row-state.ts";

const STALE_BEFORE = "2026-08-10T12:00:00.000Z";
const FRESH = "2026-08-10T12:00:01.000Z";
const CRASHED = "2026-08-10T11:59:59.000Z";

const attendeeClaim = (writtenAt: string, attendeeId = 7): RefundClaim => ({
  attendeeId,
  capability: "keyless",
  scope: "attendee_set",
  writtenAt,
});

const ADMIN_RUN: ClaimRequest = { attendeeId: 7, scope: "attendee_set" };

describe("isClaimStale", () => {
  test("a claim written before the cutoff is a crashed worker", () => {
    expect(isClaimStale(attendeeClaim(CRASHED), STALE_BEFORE)).toBe(true);
  });

  test("a claim written after the cutoff is a run still going", () => {
    expect(isClaimStale(attendeeClaim(FRESH), STALE_BEFORE)).toBe(false);
  });

  test("a claim written exactly at the cutoff is still going", () => {
    expect(isClaimStale(attendeeClaim(STALE_BEFORE), STALE_BEFORE)).toBe(false);
  });
});

describe("claimLeaseMs", () => {
  // The fault this closes: a claim's lease was read straight off
  // `STALE_RESERVATION_MS`, which takes any positive value from the
  // environment. Tuned down — to sweep abandoned reservations sooner — it made
  // a run that was still going look dead, so a second run resumed its rows and
  // sent a keyless provider a second payout against the same charge.
  test("a reservation cutoff below one request's life does not shorten it", () => {
    expect(claimLeaseMs(1)).toBeGreaterThan(1);
  });

  test("a raised reservation cutoff is followed, so the two agree", () => {
    const raised = claimLeaseMs(1) * 2;
    expect(claimLeaseMs(raised)).toBe(raised);
  });

  test("the floor outlives the reservation default it is usually equal to", () => {
    expect(claimLeaseMs(STALE_RESERVATION_MS)).toBe(STALE_RESERVATION_MS);
  });
});

describe("decideClaim", () => {
  test("an unclaimed row is granted", () => {
    expect(decideClaim(undefined, ADMIN_RUN, STALE_BEFORE)).toEqual({
      kind: "grant",
    });
  });

  test("a fresh claim in our own scope is held by someone else", () => {
    expect(decideClaim(attendeeClaim(FRESH), ADMIN_RUN, STALE_BEFORE)).toEqual({
      kind: "held",
    });
  });

  test("a stale claim on our own attendee's set is resumed", () => {
    expect(
      decideClaim(attendeeClaim(CRASHED), ADMIN_RUN, STALE_BEFORE),
    ).toEqual({ kind: "resume", resuming: attendeeClaim(CRASHED) });
  });

  test("a stale claim on a different attendee's set is left alone", () => {
    expect(
      decideClaim(attendeeClaim(CRASHED, 99), ADMIN_RUN, STALE_BEFORE),
    ).toEqual({ kind: "foreign" });
  });
});

describe("holdsTheRow", () => {
  const HOLDS: [ClaimDecision, boolean][] = [
    [{ kind: "foreign" }, false],
    [{ kind: "grant" }, true],
    [{ kind: "held" }, false],
    [{ kind: "resume", resuming: attendeeClaim(CRASHED) }, true],
  ];
  for (const [decision, expected] of HOLDS) {
    test(`${decision.kind} ${expected ? "holds" : "does not hold"} the row`, () => {
      expect(holdsTheRow(decision)).toBe(expected);
    });
  }
});

describe("mayReleaseClaim", () => {
  const CAPABILITIES: RefundCapability[] = ["keyed", "keyless"];

  for (const capability of CAPABILITIES) {
    test(`${capability} releases when the answer came back`, () => {
      expect(mayReleaseClaim(capability, "validated")).toBe(true);
    });

    test(`${capability} releases when nothing was sent`, () => {
      expect(mayReleaseClaim(capability, "not_sent")).toBe(true);
    });
  }

  test("a lost answer releases a keyed claim — a re-run lands on the same key", () => {
    expect(mayReleaseClaim("keyed", "lost")).toBe(true);
  });

  test("a lost answer keeps a keyless claim standing", () => {
    expect(mayReleaseClaim("keyless", "lost")).toBe(false);
  });
});

describe("saying why a run was turned away", () => {
  for (const [kind, words] of [
    ["foreign", "another kind of run holds this payment"],
    ["held", "a refund for this payment is already in progress"],
  ] as const satisfies readonly (readonly [ClaimDecision["kind"], string])[]) {
    test(`${kind} says so in words`, () => {
      expect(claimRefusal({ kind })).toBe(words);
    });
  }

  // Both of these mean the run HOLDS the row. Asking why it was refused is
  // the caller having lost track of its own answer, so it fails rather than
  // handing back words that would read as a refusal in a log.
  const GRANTED: ClaimDecision[] = [
    { kind: "grant" },
    { kind: "resume", resuming: attendeeClaim(CRASHED) },
  ];
  for (const decision of GRANTED) {
    test(`${decision.kind} has no refusal to give`, () => {
      expect(() => claimRefusal(decision)).toThrow(
        `A granted claim has no refusal: ${decision.kind}`,
      );
    });
  }
});
