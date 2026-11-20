// test-groups: run-alone
import { expect } from "@std/expect";
import { beforeAll, describe, it } from "@std/testing/bdd";
import { cancellationFacts } from "#scripts/verify-models/subscriptions/cancellation.ts";
import type { CancellationFacts } from "#scripts/verify-models/subscriptions/cancellation-facts.ts";
import { requireValue } from "#shared/required-value.ts";
import { SubscriptionStatusSchema } from "#shared/subscriptions/plan.ts";
import { cleanFacts } from "#test/scripts/verify-models/registered-model.ts";
import { activeOverEnded } from "./cancellation-fixture.ts";

/** One clean producer run serves every test in this file. */
const [clean, setClean] = cleanFacts<CancellationFacts>("cancellation");
const owner = (scenario: string) =>
  requireValue(
    clean().owners.find((fact) => fact.scenario === scenario),
    `Missing owner evidence: ${scenario}`,
  );
const checkout = (scenario: string, attempt = 1) =>
  requireValue(
    clean().checkouts.find(
      (fact) => fact.scenario === scenario && fact.attempt === attempt,
    ),
    `Missing checkout evidence: ${scenario}/${attempt}`,
  );

/** A read that ran must name the true subscription. No read leaves no id. */
const expectReadTarget = (
  reads: number,
  requestId: string,
  identityKept: boolean,
  subscriptionId: string,
) => {
  expect(requestId).toBe(reads > 0 ? subscriptionId : "");
  if (reads > 0) expect(identityKept).toBe(true);
};

describe("SubscriptionCancellation production evidence", () => {
  beforeAll(async () => {
    setClean(await cancellationFacts());
  });

  it("runs the complete guarded status domain and preserves an ended row", () => {
    const statuses = SubscriptionStatusSchema.options;
    const lives = [
      "active",
      "incomplete",
      "past_due",
      "paused",
      "trialing",
      "unpaid",
    ];
    const expected = lives.flatMap((snapshot) =>
      statuses.flatMap((before) =>
        statuses.map((target) => `${snapshot}/${before}/${target}`),
      ),
    );
    expect(
      clean()
        .writes.map((fact) => `${fact.snapshot}/${fact.before}/${fact.target}`)
        .toSorted(),
    ).toEqual(expected.toSorted());
    expect(activeOverEnded(clean().writes)).toEqual([
      {
        affected: 0,
        after: "canceled",
        before: "canceled",
        snapshot: "active",
        target: "active",
      },
    ]);
    expect(
      clean()
        .writes.filter(
          (fact) =>
            fact.snapshot === "active" &&
            fact.before === "active" &&
            fact.target === "canceled",
        )
        .map(({ affected, after }) => ({ affected, after })),
    ).toEqual([{ affected: 1, after: "canceled" }]);
  });

  it("records every observed status and each final invoice identity separately", () => {
    for (const status of SubscriptionStatusSchema.options) {
      expect(owner(`owner-observed-${status}`)).toMatchObject({
        after: status,
        answer:
          status === "canceled" || status === "incomplete_expired"
            ? "cancelled"
            : "not_cancelled",
        cash: 1200,
        firstCash: 600,
        firstInvoice: "in_final_a",
        firstLegs: 2,
        legs: 4,
        observed: status,
        secondCash: 600,
        secondInvoice: "in_final_b",
        secondLegs: 2,
        threw: false,
      });
    }
    expect(owner("owner-final").firstGroup).not.toEqual(
      owner("owner-final").secondGroup,
    );
    expect(owner("owner-read-ended")).toMatchObject({
      after: "canceled",
      cancels: 1,
      cash: 1200,
      reads: 1,
    });
    expect(owner("owner-read-ended").answer).toBe("cancelled");
  });

  it("captures the true subscription target at every provider read boundary", () => {
    for (const fact of [...clean().owners, ...clean().checkouts]) {
      expectReadTarget(
        fact.reads,
        fact.readRequestId,
        fact.readIdentityKept,
        fact.subscriptionId,
      );
      expectReadTarget(
        fact.invoiceReads,
        fact.invoiceRequestId,
        fact.invoiceIdentityKept,
        fact.subscriptionId,
      );
    }
    expect(owner("owner-read-ended")).toMatchObject({
      invoiceReads: 1,
      invoiceRequestId: "sub_owner",
      readRequestId: "sub_owner",
      requestId: "sub_owner",
    });
    for (const scenario of [
      "owner-invoice-refused",
      "owner-invoice-missing",
      "owner-invoice-unavailable",
    ])
      expect(owner(scenario)).toMatchObject({
        invoiceReads: 1,
        invoiceRequestId: "sub_owner",
        invoicesRead: false,
      });
    expect(checkout("read-ended")).toMatchObject({
      invoiceReads: 0,
      readRequestId: "sub_failed",
      requestId: "sub_failed",
    });
  });

  it("separates external end confirmation from refused local invoice work", () => {
    for (const scenario of [
      "owner-invoice-refused",
      "owner-invoice-missing",
      "owner-invoice-unavailable",
    ]) {
      expect(owner(scenario)).toMatchObject({
        after: "active",
        answer: "behind",
        cash: 0,
        invoicesRead: false,
        legs: 0,
        observed: "canceled",
      });
    }
    for (const scenario of [
      "owner-both-refused",
      "owner-both-missing",
      "owner-both-unavailable",
    ]) {
      expect(owner(scenario)).toMatchObject({
        after: "active",
        answer: "not_cancelled",
        cancels: 1,
        cash: 0,
        invoicesRead: false,
        observed: "unread",
        reads: 1,
      });
    }
    expect(owner("owner-ledger-fault")).toMatchObject({
      after: "active",
      answer: "threw",
      cash: 0,
      legs: 0,
      threw: true,
    });
  });

  it("allows stale status money but refuses every replaced booking identity", () => {
    expect(owner("owner-stale-status")).toMatchObject({
      after: "canceled",
      cash: 1200,
      identityCurrent: true,
      legs: 4,
      threw: false,
    });
    for (const field of ["attendee", "listing", "subscription", "id"]) {
      expect(owner(`owner-replaced-${field}`)).toMatchObject({
        after: "active",
        answer: "threw",
        cash: 0,
        identityCurrent: false,
        legs: 0,
        threw: true,
      });
    }
  });

  it("records an empty invoice list and refuses replaced identities without money", () => {
    expect(owner("owner-no-renewals")).toMatchObject({
      after: "canceled",
      answer: "cancelled",
      cash: 0,
      finalInvoices: 0,
      invoicesRead: true,
      legs: 0,
      threw: false,
    });
    for (const field of ["attendee", "listing", "subscription", "id"]) {
      expect(owner(`owner-no-renewals-replaced-${field}`)).toMatchObject({
        after: "active",
        answer: "threw",
        cash: 0,
        finalInvoices: 0,
        identityCurrent: false,
        invoicesRead: true,
        legs: 0,
        threw: true,
      });
    }
  });

  it("resumes actual rejected and placeholder orchestration with one refund", () => {
    expect(
      clean()
        .checkouts.filter((fact) => fact.scenario === "retry")
        .map((fact) => fact.attempt),
    ).toEqual([1, 2, 3]);
    expect(checkout("retry")).toMatchObject({
      after: "trialing",
      held: 1,
      heldAtCancel: 1,
      planAtCancel: 1,
      quantity: 0,
      refunds: 0,
      threw: true,
    });
    expect(checkout("retry", 2)).toMatchObject({
      after: "trialing",
      authorityLocal: "recorded",
      held: 0,
      quantity: 0,
      refunded: true,
      refunds: 1,
    });
    expect(checkout("retry", 3)).toMatchObject({
      durableRefunded: true,
      held: 0,
      refundCash: 600,
      refundLegs: 1,
      refunds: 1,
    });
    expect(checkout("placeholder", 2)).toMatchObject({
      entrypoint: "placeholder",
      held: 0,
      refunded: true,
      refunds: 1,
    });
    expect(checkout("ledger-interrupted")).toMatchObject({
      authorityLocal: "due",
      held: 1,
      refundLegs: 0,
      refunds: 1,
      threw: true,
    });
    expect(checkout("ledger-interrupted", 3)).toMatchObject({
      authorityLocal: "recorded",
      durableRefunded: true,
      held: 0,
      refundLegs: 1,
      refunds: 1,
    });
  });

  it("protects durable booked and orphaned dispositions without HTTP history", () => {
    for (const scenario of ["booked", "orphaned", "foreign", "occupied"]) {
      expect(checkout(scenario)).toMatchObject({
        cancels: 0,
        reads: 0,
        refunds: 0,
      });
    }
    expect(checkout("booked")).toMatchObject({ planRows: 1, quantity: 1 });
    expect(checkout("orphaned")).toMatchObject({
      paymentLegs: 1,
      planRows: 0,
      quantity: -1,
    });
    expect(checkout("anchorless", 2)).toMatchObject({
      cancels: 1,
      held: 0,
      heldAtCancel: 1,
      planAtCancel: 1,
      planKept: true,
      planRows: 1,
      quantity: 0,
      refunds: 0,
    });
    expect(checkout("unreadable")).toMatchObject({
      confirmed: true,
      planKept: false,
      planRows: 0,
      quantity: -1,
      refunds: 1,
    });
  });

  it("retains the valid quantity-zero plan on every anchorless delivery", () => {
    for (const attempt of [1, 2, 3]) {
      const fact = checkout("anchorless", attempt);
      expect(fact.attendeeId).toBeGreaterThan(0);
      expect(fact.bookingId).toBeGreaterThan(0);
      expect(fact).toMatchObject({
        after: "trialing",
        listingId: 1,
        owned: true,
        planKept: true,
        planRows: 1,
        quantity: 0,
        signedOrder: true,
        subscriptionId: "sub_failed",
        threw: true,
      });
    }
    for (const scenario of ["unreadable", "foreign", "orphaned", "occupied"])
      expect(checkout(scenario)).toMatchObject({
        planKept: false,
        planRows: 0,
      });
  });

  it("requires an ended status and accepts an already observed end without calls", () => {
    for (const status of SubscriptionStatusSchema.options) {
      const ended = status === "canceled" || status === "incomplete_expired";
      expect(checkout(`failed-end-${status}`)).toMatchObject({
        confirmed: ended,
        observed: status,
        refunds: ended ? 1 : 0,
        threw: !ended,
      });
      if (ended)
        expect(checkout(`failed-start-${status}`)).toMatchObject({
          cancels: 0,
          reads: 0,
          refunds: 1,
        });
    }
    expect(checkout("read-ended")).toMatchObject({
      cancels: 1,
      confirmed: true,
      reads: 1,
      refunds: 1,
    });
    for (const scenario of [
      "both-refused",
      "both-missing",
      "both-unavailable",
    ]) {
      expect(checkout(scenario)).toMatchObject({
        after: "trialing",
        confirmed: false,
        held: 1,
        refunds: 0,
        threw: true,
      });
    }
    expect(checkout("unpaid-charge")).toMatchObject({
      chargeNamed: false,
      paymentReference: "",
      planRows: 1,
      quantity: 0,
      refunds: 0,
    });
  });
});
