import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { RefundAttemptResult } from "#payment/refund-attempt.ts";
import type { ChargeMoney, RefundObservation } from "#payment/resources.ts";
import type { SumupRefundSubmission } from "#shared/sumup/failures.ts";
import { sumupRefundOutcome } from "#shared/sumup/money.ts";
import {
  chargeMoney,
  foundCharge,
  fullyRefundedMoney,
  gbp,
} from "#test-utils/payment-state.ts";

/** The sends these rules decide: one that left, and one whose answer was
 *  lost on the way back. A send SumUp refused never reaches them. */
const SENT = { kind: "sent" } as const;
const LOST = { kind: "uncertain", reason: "network_error" } as const;

type CheckedSubmission = Extract<
  SumupRefundSubmission,
  { kind: "sent" | "uncertain" }
>;

/** The £10 charge those refund events add up to. */
const withRefunds = (...refunds: RefundObservation[]): ChargeMoney => ({
  ...chargeMoney(1000),
  refunds,
});

const completed = (amount: number): RefundObservation => ({
  amount: gbp(amount),
  status: "completed",
});

const pending = (amount: number): RefundObservation => ({
  amount: gbp(amount),
  status: "pending",
});

const failed = (amount: number): RefundObservation => ({
  amount: gbp(amount),
  reason: "provider_failed",
  status: "failed",
});

/** What the rules made of one send, given what SumUp says about the charge
 *  now and what it said before the send went out. */
const outcomeOf = (
  submission: CheckedSubmission,
  fresh: ProviderRead<ChargeMoney>,
  before: ChargeMoney = chargeMoney(1000),
): RefundAttemptResult =>
  sumupRefundOutcome(
    submission,
    { charge: before, paymentReference: "txn_9" },
    fresh,
  );

describe("deciding a SumUp send from one fresh transaction reading", () => {
  for (const [name, read, reason] of [
    [
      "cannot find the charge",
      { status: "missing" },
      "missing_documented_resource",
    ],
    [
      "could not answer",
      { reason: "timeout", status: "unavailable" },
      "timeout",
    ],
    [
      "gave money it cannot read",
      { reason: "malformed_money", status: "invalid" },
      "malformed_money",
    ],
  ] as const satisfies readonly (readonly [
    string,
    ProviderRead<ChargeMoney>,
    string,
  ])[]) {
    test(`stays uncertain when the fresh reading ${name}`, () => {
      expect(outcomeOf(SENT, read)).toEqual({ kind: "uncertain", reason });
    });
  }

  for (const [name, fresh] of [
    ["a different total", chargeMoney(2000)],
    ["a different currency", chargeMoney(1000, 0, "USD")],
  ] as const) {
    test(`refuses a fresh reading of ${name}`, () => {
      expect(outcomeOf(SENT, foundCharge(fresh))).toEqual({
        kind: "uncertain",
        reason: "mismatched_money",
      });
    });
  }

  test("refuses a fresh reading that gives back more than was taken", () => {
    expect(outcomeOf(SENT, foundCharge(withRefunds(completed(1400))))).toEqual({
      kind: "uncertain",
      reason: "mismatched_money",
    });
  });

  test("reads a failed refund that is new since the send as a refusal", () => {
    expect(outcomeOf(LOST, foundCharge(withRefunds(failed(1000))))).toEqual({
      kind: "rejected",
      reason: "failed",
    });
  });

  test("does not read a failed refund we already knew about as this send", () => {
    const before = withRefunds(failed(1000));
    expect(outcomeOf(LOST, foundCharge(before), before)).toEqual(LOST);
  });

  test("does not call a send refused while some of the money went back", () => {
    // A failed refund beside money that did move is somebody else's failure.
    expect(
      outcomeOf(SENT, foundCharge(withRefunds(completed(600), failed(400)))),
    ).toEqual({ kind: "uncertain", reason: "mismatched_money" });
  });

  test("keeps a send that left uncertain while nothing has moved", () => {
    expect(outcomeOf(SENT, foundCharge(chargeMoney(1000)))).toEqual({
      kind: "uncertain",
      reason: "missing_documented_resource",
    });
  });

  for (const reason of [
    "malformed_response",
    "network_error",
    "provider_error",
  ] as const) {
    test(`keeps an uncertain ${reason} send at that reason while nothing has moved`, () => {
      expect(
        outcomeOf(
          { kind: "uncertain", reason },
          foundCharge(chargeMoney(1000)),
        ),
      ).toEqual({ kind: "uncertain", reason });
    });
  }

  test("cannot tell which of two pending refunds this send is", () => {
    expect(
      outcomeOf(SENT, foundCharge(withRefunds(pending(400), pending(600)))),
    ).toEqual({ kind: "uncertain", reason: "multiple_pending_refunds" });
  });

  test("refuses a refund that covers only part of the charge", () => {
    expect(outcomeOf(SENT, foundCharge(withRefunds(pending(400))))).toEqual({
      kind: "uncertain",
      reason: "mismatched_money",
    });
  });

  for (const [name, submission] of [
    ["that left", SENT],
    ["whose answer was lost", LOST],
  ] as const) {
    test(`calls a send ${name} completed once every penny is back`, () => {
      const fresh = fullyRefundedMoney(1000);
      expect(outcomeOf(submission, foundCharge(fresh))).toEqual({
        amount: gbp(1000),
        kind: "completed",
        proof: { charge: fresh, kind: "charge_observation" },
      });
    });
  }

  test("calls a send accepted while the whole charge is still pending", () => {
    const fresh = withRefunds(pending(1000));
    expect(outcomeOf(SENT, foundCharge(fresh))).toEqual({
      amount: gbp(1000),
      kind: "accepted",
      proof: { charge: fresh, kind: "charge_observation" },
    });
  });
});
